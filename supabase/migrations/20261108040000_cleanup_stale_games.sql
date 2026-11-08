-- Hourly cleanup of dead games (runs inside Supabase via pg_cron).
--
--  1. Lobbies that never started within 6 hours  → deleted.
--  2. Started games with no activity for 6 hours → finished.
--     "Activity" = host heartbeat (last_host_seen), any player action, or start time.
--     • Tournaments: just marked finished.
--     • Home games: chip stacks are counted and cashed out to the friends ledger
--       first, the same way the in-app Cash Out does it:
--         net = stack − total buy-in (incl. re-buys), losers pay winners in
--         proportion to each winner's share of total winnings.
--       If the game stalled mid-hand, that unfinished hand is voided: each player
--       gets back what they put in this hand, and any carry-over pot that can't be
--       attributed (e.g. Guts) is split evenly among the players still seated.
--       Players who already quit (and recorded their own cash-out) are skipped.
--
-- Run manually any time:  select public.cleanup_stale_games();

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
  v_total_win  numeric;
  v_cashouts   jsonb;
  v_n          int;
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
        chips numeric, total_bet numeric, buyin numeric, quit boolean,
        stack numeric, net numeric
      ) on commit drop;
      truncate _co;

      insert into _co (ord, id, name, emoji, chips, total_bet, buyin, quit)
      select e.ord::int,
             e.p ->> 'id',
             coalesce(e.p ->> 'name', '?'),
             coalesce(e.p ->> 'emoji', ''),
             coalesce((e.p ->> 'chips')::numeric, 0),
             greatest(coalesce((e.p ->> 'totalBet')::numeric, 0), 0),
             coalesce((e.p ->> 'totalBuyInCents')::numeric, coalesce(g.buy_in_amount, 0) * 100),
             coalesce((e.p ->> 'eliminated')::boolean, false)
               and coalesce(e.p -> 'lastAction' ->> 'type', '') = 'quit'
      from jsonb_array_elements(g.state -> 'players') with ordinality as e(p, ord);

      -- Void an unfinished hand: return bets, split any unattributed pot evenly
      v_pot := greatest(coalesce((g.state ->> 'pot')::numeric, 0), 0);
      update _co set stack = chips where true;
      if v_pot > 0 then
        select coalesce(sum(total_bet), 0) into v_refund from _co;
        if v_refund > v_pot then
          -- never hand back more than is in the pot
          update _co set stack = stack + round(total_bet * v_pot / v_refund) where not quit;
          v_leftover := 0;
        else
          update _co set stack = stack + total_bet where not quit;
          v_leftover := v_pot - v_refund;
        end if;
        select count(*) into v_seated from _co where not quit;
        if v_leftover > 0 and v_seated > 0 then
          update _co c set stack = stack + floor(v_leftover / v_seated)
                                   + case when c.ord = (select min(ord) from _co where not quit)
                                          then v_leftover - floor(v_leftover / v_seated) * v_seated else 0 end
          where not quit;
        end if;
      end if;
      update _co set net = stack - buyin where true;

      -- Cash-out summary stored in the game state (same shape the app uses)
      select jsonb_agg(jsonb_build_object(
               'id', id, 'name', name, 'emoji', emoji,
               'stackCents', stack, 'buyInCents', buyin, 'netCents', net,
               'placement', rn) order by rn)
        into v_cashouts
      from (select *, row_number() over (order by net desc, ord) rn from _co where not quit) s;

      -- Friends ledger: both sides of every loser→winner pair, unless already recorded
      if not exists (select 1 from public.payout_ledger where game_id = g.id and note like 'Home game cash-out%') then
        select coalesce(sum(net), 0) into v_total_win
        from _co c where not quit and net > 0 and exists (select 1 from public.users u where u.id::text = c.id);

        if v_total_win > 0 then
          with pairs as (
            select w.id::uuid as winner, l.id::uuid as loser,
                   round(round(w.net / v_total_win * abs(l.net)) / 100.0, 2) as dollars
            from _co w, _co l
            where not w.quit and not l.quit and w.net > 0 and l.net < 0
              and exists (select 1 from public.users u where u.id::text = w.id)
              and exists (select 1 from public.users u where u.id::text = l.id)
          ), ins as (
            insert into public.payout_ledger (game_id, user_id, opponent_id, amount, kind, note)
            select g.id, winner, loser,  dollars, 'game', 'Home game cash-out (auto: game went inactive)' from pairs where dollars > 0
            union all
            select g.id, loser,  winner, -dollars, 'game', 'Home game cash-out (auto: game went inactive)' from pairs where dollars > 0
            returning 1
          ) select count(*) into v_n from ins;
          v_rows := v_rows + v_n;
        end if;
      end if;
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

-- Schedule hourly (at :07) inside the database
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;
select cron.unschedule('cleanup-stale-games')
  where exists (select 1 from cron.job where jobname = 'cleanup-stale-games');
select cron.schedule('cleanup-stale-games', '7 * * * *', $cron$select public.cleanup_stale_games()$cron$);
