-- Server-run games (migration plan phase 1).
-- game_secrets holds the full state of a table the server is running: the
-- deck, every player's cards, deadlines. Phones can never read or write it
-- (row-level security on, no policies); only the `table` Edge Function, using
-- the service role, touches it. games.state stays the redacted copy that
-- phones render.

create table if not exists public.game_secrets (
  game_id    uuid primary key references public.games(id) on delete cascade,
  state      jsonb not null,
  version    integer not null default 0,
  updated_at timestamp with time zone not null default now()
);
alter table public.game_secrets enable row level security;
revoke all on public.game_secrets from anon, authenticated;

-- One atomic save per action: the full state (only if nobody else saved
-- first), the public copy, and the new deal's private cards. Returns false on
-- a version conflict so the caller can reload and retry; two saves can never
-- land out of order.
create or replace function public.save_table(
  p_game_id uuid,
  p_expect_version integer,      -- null = first save (game start)
  p_state jsonb,
  p_public jsonb,
  p_hands jsonb default null     -- [{player_id, cards}] when cards were dealt
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows int;
  v_over boolean := coalesce((p_public ->> 'tournamentOver')::boolean, false);
  v_hand int := coalesce((p_public ->> 'handNumber')::int, 0);
begin
  if p_expect_version is null then
    insert into public.game_secrets (game_id, state, version) values (p_game_id, p_state, 1)
    on conflict (game_id) do nothing;
  else
    update public.game_secrets
       set state = p_state, version = version + 1, updated_at = now()
     where game_id = p_game_id and version = p_expect_version;
  end if;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return false; end if;

  update public.games
     set state = p_public,
         hand_number = v_hand,
         last_host_seen = now(),
         status = case when v_over then 'finished' when status = 'lobby' then 'active' else status end,
         started_at = coalesce(started_at, now()),
         finished_at = case when v_over then coalesce(finished_at, now()) else finished_at end
   where id = p_game_id;

  if p_hands is not null then
    delete from public.private_hands where game_id = p_game_id and hand_number = v_hand;
    insert into public.private_hands (game_id, hand_number, player_id, cards)
    select p_game_id, v_hand, (h ->> 'player_id')::uuid, h -> 'cards'
    from jsonb_array_elements(p_hands) h;
  end if;
  if v_over then
    delete from public.private_hands where game_id = p_game_id and hand_number <> v_hand;
  end if;
  return true;
end $$;

revoke execute on function public.save_table(uuid, integer, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_table(uuid, integer, jsonb, jsonb, jsonb) to service_role;
