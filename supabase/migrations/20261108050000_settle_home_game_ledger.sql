-- One place that writes a home game's friends-ledger entries, for BOTH sides of
-- every pair. Players can only insert rows under their own name (RLS), so a
-- quitting player could never record the other side; this runs as the database.
--
-- Source of truth is the game's saved state:
--   • state.cashOuts present (final Cash Out, or auto-finish) → final amounts
--   • otherwise (someone quit mid-game) → snapshot of current stacks; a player
--     who left uses the stack they took home (cashedOutCents)
-- net = stack − total buy-in; losers pay winners in proportion to each winner's
-- share of total winnings (same as the in-app Cash Out).
--
-- Idempotent: replaces this game's unsettled entries each time it runs, so the
-- mid-game tally is overwritten by the final result. If anyone already marked
-- entries from this game as settled, it leaves the game alone.

create or replace function public.settle_home_game_ledger(p_game_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g          public.games%rowtype;
  v_final    boolean;
  v_total    numeric;
  v_rows     int := 0;
  v_note     text;
begin
  select * into g from public.games where id = p_game_id;
  if not found then return jsonb_build_object('error', 'game not found'); end if;
  if g.game_format is distinct from 'home' then return jsonb_build_object('skipped', 'not a home game'); end if;

  -- Called from the app: only players in this game may trigger it
  if auth.uid() is not null and not exists (
       select 1 from public.game_players gp where gp.game_id = g.id and gp.user_id = auth.uid()
     ) and g.host_id is distinct from auth.uid() then
    raise exception 'not a player in this game';
  end if;

  if exists (select 1 from public.payout_ledger where game_id = g.id and kind = 'game' and settled_at is not null) then
    return jsonb_build_object('skipped', 'entries already settled');
  end if;

  v_final := jsonb_typeof(g.state -> 'cashOuts') = 'array';
  v_note  := case when v_final then 'Home game cash-out' else 'Home game (in progress)' end;

  create temp table if not exists _st (id text, stack numeric, buyin numeric, net numeric) on commit drop;
  truncate _st;

  if v_final then
    insert into _st (id, stack, buyin)
    select c ->> 'id', coalesce((c ->> 'stackCents')::numeric, 0), coalesce((c ->> 'buyInCents')::numeric, 0)
    from jsonb_array_elements(g.state -> 'cashOuts') c;
  elsif jsonb_typeof(g.state -> 'players') = 'array' then
    insert into _st (id, stack, buyin)
    select p ->> 'id',
           coalesce((p ->> 'cashedOutCents')::numeric, (p ->> 'chips')::numeric, 0),
           coalesce((p ->> 'totalBuyInCents')::numeric, coalesce(g.buy_in_amount, 0) * 100)
    from jsonb_array_elements(g.state -> 'players') p;
  end if;

  delete from _st s where not exists (select 1 from public.users u where u.id::text = s.id);
  update _st set net = stack - buyin where true;

  delete from public.payout_ledger where game_id = g.id and kind = 'game' and settled_at is null;

  select coalesce(sum(net), 0) into v_total from _st where net > 0;
  if v_total > 0 then
    with pairs as (
      select w.id::uuid winner, l.id::uuid loser,
             round(round(w.net / v_total * abs(l.net)) / 100.0, 2) dollars
      from _st w, _st l where w.net > 0 and l.net < 0
    ), ins as (
      insert into public.payout_ledger (game_id, user_id, opponent_id, amount, kind, note)
      select g.id, winner, loser,  dollars, 'game', v_note from pairs where dollars > 0
      union all
      select g.id, loser,  winner, -dollars, 'game', v_note from pairs where dollars > 0
      returning 1
    ) select count(*) into v_rows from ins;
  end if;

  return jsonb_build_object('final', v_final, 'ledger_rows', v_rows);
end;
$$;

revoke execute on function public.settle_home_game_ledger(uuid) from public, anon;
grant execute on function public.settle_home_game_ledger(uuid) to authenticated;

-- Hourly cleanup now settles home games through the same function, and counts
-- players who quit using the stack they took home.
create or replace function public.cleanup_stale_games(p_idle interval default interval '6 hours')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g            record;
  v_deleted    int := 0;
  v_finished   int := 0;
  v_home       int := 0;
  v_rows       int := 0;
  v_pot        numeric;
  v_refund     numeric;
  v_leftover   numeric;
  v_seated     int;
  v_cashouts   jsonb;
  v_res        jsonb;
begin
  -- 1. Lobbies that never started
  with d as (
    delete from public.games
    where status = 'lobby' and created_at < now() - p_idle
    returning 1
  ) select count(*) into v_deleted from d;

  -- 2. Started games that went quiet
  for g in
    select ga.*
    from public.games ga
    where ga.status not in ('lobby', 'finished')
      and greatest(
            ga.last_host_seen, ga.started_at, ga.created_at,
            (select max(pa.created_at) from public.player_actions pa where pa.game_id = ga.id)
          ) < now() - p_idle
    for update skip locked
  loop
    v_cashouts := null;

    if g.game_format = 'home' and jsonb_typeof(g.state -> 'players') = 'array' then
      create temp table if not exists _co (
        ord int, id text, name text, emoji text,
        chips numeric, total_bet numeric, buyin numeric, left_table boolean, cashed numeric,
        stack numeric, net numeric
      ) on commit drop;
      truncate _co;

      insert into _co (ord, id, name, emoji, chips, total_bet, buyin, left_table, cashed)
      select e.ord::int,
             e.p ->> 'id',
             coalesce(e.p ->> 'name', '?'),
             coalesce(e.p ->> 'emoji', ''),
             coalesce((e.p ->> 'chips')::numeric, 0),
             greatest(coalesce((e.p ->> 'totalBet')::numeric, 0), 0),
             coalesce((e.p ->> 'totalBuyInCents')::numeric, coalesce(g.buy_in_amount, 0) * 100),
             coalesce((e.p ->> 'eliminated')::boolean, false)
               and coalesce(e.p -> 'lastAction' ->> 'type', '') = 'quit',
             (e.p ->> 'cashedOutCents')::numeric
      from jsonb_array_elements(g.state -> 'players') with ordinality as e(p, ord);

      -- Players who left keep what they took home; everyone else: void an
      -- unfinished hand (return bets, split any unattributed pot evenly)
      update _co set stack = case when left_table then coalesce(cashed, 0) else chips end where true;
      v_pot := greatest(coalesce((g.state ->> 'pot')::numeric, 0), 0);
      if v_pot > 0 then
        select coalesce(sum(total_bet), 0) into v_refund from _co where not left_table;
        if v_refund > v_pot then
          update _co set stack = stack + round(total_bet * v_pot / v_refund) where not left_table;
          v_leftover := 0;
        else
          update _co set stack = stack + total_bet where not left_table;
          v_leftover := v_pot - v_refund;
        end if;
        select count(*) into v_seated from _co where not left_table;
        if v_leftover > 0 and v_seated > 0 then
          update _co c set stack = stack + floor(v_leftover / v_seated)
                                   + case when c.ord = (select min(ord) from _co where not left_table)
                                          then v_leftover - floor(v_leftover / v_seated) * v_seated else 0 end
          where not left_table;
        end if;
      end if;
      update _co set net = stack - buyin where true;

      select jsonb_agg(jsonb_build_object(
               'id', id, 'name', name, 'emoji', emoji,
               'stackCents', stack, 'buyInCents', buyin, 'netCents', net,
               'placement', rn) order by rn)
        into v_cashouts
      from (select *, row_number() over (order by net desc, ord) rn from _co) s;
      v_home := v_home + 1;
    end if;

    update public.games
       set status = 'finished',
           finished_at = now(),
           state = coalesce(state, '{}'::jsonb)
                   || jsonb_build_object('stage', 'finished', 'tournamentOver', true, 'autoFinished', true)
                   || case when v_cashouts is not null then jsonb_build_object(
                        'cashOuts', v_cashouts,
                        'finalPlacements', (select jsonb_agg(jsonb_build_object(
                            'name', x ->> 'name', 'emoji', x ->> 'emoji', 'netCents', (x ->> 'netCents')::numeric))
                          from jsonb_array_elements(v_cashouts) x))
                      else '{}'::jsonb end
     where id = g.id;

    if v_cashouts is not null then
      v_res := public.settle_home_game_ledger(g.id);
      v_rows := v_rows + coalesce((v_res ->> 'ledger_rows')::int, 0);
    end if;
    v_finished := v_finished + 1;
  end loop;

  return jsonb_build_object(
    'lobbies_deleted', v_deleted,
    'games_finished', v_finished,
    'home_games_cashed_out', v_home,
    'ledger_rows', v_rows
  );
end;
$$;

revoke execute on function public.cleanup_stale_games(interval) from public, anon, authenticated;
