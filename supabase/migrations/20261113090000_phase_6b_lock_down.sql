-- Phase 6b-2: every game is run by the `table` Edge Function, so phones no
-- longer write game state, hole cards, other players' seats or tournament
-- ledger rows. (Demo mode plays locally and saves nothing.)

-- games: a host may still edit (and delete) their own lobby before it starts;
-- once started, only the function (service role) changes a game.
drop policy if exists "Players update their own phone-run games" on public.games;
drop policy if exists "Hosts update their own lobbies" on public.games;
create policy "Hosts update their own lobbies" on public.games
  for update
  using (auth.uid() = host_id and status = 'lobby')
  with check (auth.uid() = host_id and status = 'lobby');

-- private_hands: written only by the function; a player reads their own.
drop policy if exists "Anyone auth can write hands" on public.private_hands;
drop policy if exists "Anyone auth can delete hands" on public.private_hands;

-- player_actions: nobody's phone deletes them (cleanup runs as the database).
drop policy if exists "Allow delete player_actions" on public.player_actions;

-- game_players: you can seat yourself, and a host can invite into their game.
drop policy if exists "Anyone auth can join games" on public.game_players;
drop policy if exists "Join a game or invite into your own" on public.game_players;
create policy "Join a game or invite into your own" on public.game_players
  for insert
  with check (
    auth.uid() = user_id
    or exists (select 1 from public.games g where g.id = game_id and g.host_id = auth.uid())
  );

-- payout_ledger: game rows come from the function (tournaments) or
-- settle_home_game_ledger (home games); a phone adds only its own settle-ups.
drop policy if exists "Insert own ledger" on public.payout_ledger;
drop policy if exists "Insert own settle-ups" on public.payout_ledger;
create policy "Insert own settle-ups" on public.payout_ledger
  for insert
  with check (auth.uid() = user_id and kind = 'settle');
