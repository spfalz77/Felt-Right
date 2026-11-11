-- Server rules, phase 5: phones can no longer change games they're not in,
-- and can't change a server-run game at all.
-- Plan: docs/server-authoritative-migration.md
--
-- Before: any signed-in user could update or delete ANY games row
-- ("Anyone authenticated can update games", "Allow delete games" using true).
--
-- After:
--   update  only the host or a player of that game, and never a game whose
--           state says rules = 'server' (only the table Edge Function, as
--           service_role, writes those). Phone-run games still work as before:
--           the host's phone saves the table, and a guest can take over as host.
--   delete  only the host, and only while the game is still a lobby (Cancel /
--           leaving your own lobby). Finished games are kept; the hourly
--           cleanup job runs as the database owner and is unaffected.
--
-- Phase 6 (cutover) removes client updates of games entirely, once no
-- phone-run games are left.

drop policy if exists "Anyone authenticated can update games" on public.games;
drop policy if exists "Players update their own phone-run games" on public.games;
create policy "Players update their own phone-run games" on public.games
  for update
  using (
    coalesce(state ->> 'rules', '') <> 'server'
    and (
      auth.uid() = host_id
      or exists (select 1 from public.game_players gp where gp.game_id = games.id and gp.user_id = auth.uid())
    )
  )
  with check (coalesce(state ->> 'rules', '') <> 'server');

drop policy if exists "Allow delete games" on public.games;
drop policy if exists "Hosts delete their own lobbies" on public.games;
create policy "Hosts delete their own lobbies" on public.games
  for delete
  using (auth.uid() = host_id and status = 'lobby');
