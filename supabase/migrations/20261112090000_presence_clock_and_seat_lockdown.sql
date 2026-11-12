-- Findings from the first real-phone tournament (2026-11-11).
--
-- 1. Heartbeats carry the DATABASE's time. Phones used to send their own
--    clock, so a phone whose clock ran behind could look gone to the server
--    (and be auto-folded), or a fast one look present after it left.
-- 2. Players in a game can read each other's heartbeats, so the pause screen
--    on every phone shows the same online/away list (the server's).
-- 3. Seats can be deleted only by their own player (leave a lobby, archive a
--    finished game) or by that game's host (cancel a lobby). Before, any
--    signed-in user could delete every seat in every game ("Allow delete
--    game_players" using true), which the admin "Kill Stuck Games" button did.

create or replace function public.stamp_game_presence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- (the service role may set it: tests backdate a heartbeat to fake a gone player)
  if coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') <> 'service_role' then
    new.last_seen_at := now();
  end if;
  return new;
end $$;

drop trigger if exists stamp_game_presence on public.game_presence;
create trigger stamp_game_presence
  before insert or update on public.game_presence
  for each row execute function public.stamp_game_presence();

-- (a security definer helper avoids game_players' own policies recursing)
create or replace function public.is_in_game(p_game_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.game_players gp where gp.game_id = p_game_id and gp.user_id = auth.uid()
  ) or exists (
    select 1 from public.games g where g.id = p_game_id and g.host_id = auth.uid()
  )
$$;
revoke execute on function public.is_in_game(uuid) from public, anon;
grant execute on function public.is_in_game(uuid) to authenticated;

drop policy if exists "Read own heartbeat" on public.game_presence;
drop policy if exists "Read heartbeats in my games" on public.game_presence;
create policy "Read heartbeats in my games" on public.game_presence
  for select using (public.is_in_game(game_id));

drop policy if exists "Allow delete game_players" on public.game_players;
drop policy if exists "Delete own seat or as host" on public.game_players;
create policy "Delete own seat or as host" on public.game_players
  for delete using (
    auth.uid() = user_id
    or exists (select 1 from public.games g where g.id = game_players.game_id and g.host_id = auth.uid())
  );
