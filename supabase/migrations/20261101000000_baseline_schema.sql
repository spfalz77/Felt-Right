-- Baseline schema: the tables, constraints, row-level security policies and
-- realtime settings that existed in the live project before migrations were
-- tracked in this repo. Captured from project dcfsbtefwkcbdeqreiyx on 2026-11-08.
--
-- The live database already has all of this, so this file is NOT meant to be
-- applied there. It exists so a fresh local Supabase (`supabase start`, used by
-- the multi-player end-to-end tests in CI) ends up with the same schema.
-- Functions and triggers come from the later migrations.

create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- ── Tables ────────────────────────────────────────────────────────────────
create table if not exists public.users (
  id uuid not null,
  phone text,
  display_name text not null,
  avatar_emoji text default '🃏'::text,
  created_at timestamp with time zone default now()
);

create table if not exists public.friendships (
  id uuid default extensions.uuid_generate_v4() not null,
  requester_id uuid,
  addressee_id uuid,
  status text default 'pending'::text,
  created_at timestamp with time zone default now()
);

create table if not exists public.games (
  id uuid default extensions.uuid_generate_v4() not null,
  name text not null,
  host_id uuid,
  status text default 'lobby'::text,
  state jsonb default '{}'::jsonb,
  blind_config jsonb default '{}'::jsonb,
  hand_number integer default 0,
  created_at timestamp with time zone default now(),
  started_at timestamp with time zone,
  finished_at timestamp with time zone,
  last_host_seen timestamp with time zone,
  buy_in_amount numeric default 20,
  game_format text default 'tournament'::text,
  game_variant text default 'holdem'::text
);

create table if not exists public.game_players (
  id uuid default extensions.uuid_generate_v4() not null,
  game_id uuid,
  user_id uuid,
  seat_index integer,
  chips integer default 1500,
  status text default 'waiting'::text,
  joined_at timestamp with time zone default now()
);

create table if not exists public.game_messages (
  id uuid default gen_random_uuid() not null,
  game_id uuid,
  sender_id uuid,
  sender_name text not null,
  sender_emoji text,
  text text not null,
  created_at timestamp with time zone default now()
);

create table if not exists public.payout_ledger (
  id uuid default gen_random_uuid() not null,
  game_id uuid,
  user_id uuid not null,
  opponent_id uuid,
  amount numeric not null,
  note text,
  kind text default 'game'::text not null,
  created_at timestamp with time zone default now(),
  settled_at timestamp with time zone
);

create table if not exists public.player_actions (
  id uuid default extensions.uuid_generate_v4() not null,
  game_id uuid,
  player_id uuid,
  action text not null,
  amount integer,
  created_at timestamp with time zone default now()
);

create table if not exists public.private_hands (
  id uuid default gen_random_uuid() not null,
  game_id uuid,
  hand_number integer not null,
  player_id uuid,
  cards jsonb,
  created_at timestamp with time zone default now()
);

create table if not exists public.user_stats_private (
  user_id uuid not null,
  hands_dealt integer default 0,
  vpip_count integer default 0,
  pfr_count integer default 0,
  three_bet_count integer default 0,
  three_bet_faced integer default 0,
  three_bet_folded integer default 0,
  bets_made integer default 0,
  raises_made integer default 0,
  calls_made integer default 0,
  river_seen integer default 0,
  river_called integer default 0,
  river_folded integer default 0,
  updated_at timestamp with time zone default now()
);

create table if not exists public.user_stats_public (
  user_id uuid not null,
  tournaments_played integer default 0,
  tournaments_won integer default 0,
  second_place integer default 0,
  third_place integer default 0,
  total_chips_won bigint default 0,
  best_finish integer,
  hands_played integer default 0,
  hands_won integer default 0,
  best_hand_rank integer,
  best_hand_label text,
  biggest_pot_won bigint default 0,
  biggest_pot_lost bigint default 0,
  worst_bad_beat_pot bigint default 0,
  worst_bad_beat_label text,
  all_in_wins integer default 0,
  all_in_losses integer default 0,
  showdowns_played integer default 0,
  showdowns_won integer default 0,
  updated_at timestamp with time zone default now()
);

-- ── Keys and checks ───────────────────────────────────────────────────────
alter table public.users add constraint users_pkey primary key (id);
alter table public.users add constraint users_phone_key unique (phone);
alter table public.friendships add constraint friendships_pkey primary key (id);
alter table public.friendships add constraint friendships_requester_id_addressee_id_key unique (requester_id, addressee_id);
alter table public.friendships add constraint friendships_status_check check (status = any (array['pending'::text, 'accepted'::text]));
alter table public.games add constraint games_pkey primary key (id);
alter table public.games add constraint games_status_check check (status = any (array['lobby'::text, 'active'::text, 'finished'::text]));
alter table public.game_players add constraint game_players_pkey primary key (id);
alter table public.game_players add constraint game_players_game_id_user_id_key unique (game_id, user_id);
alter table public.game_players add constraint game_players_status_check check (status = any (array['invited'::text, 'waiting'::text, 'joined'::text, 'playing'::text, 'eliminated'::text]));
alter table public.game_messages add constraint game_messages_pkey primary key (id);
alter table public.payout_ledger add constraint payout_ledger_pkey primary key (id);
alter table public.player_actions add constraint player_actions_pkey primary key (id);
alter table public.private_hands add constraint private_hands_pkey primary key (id);
alter table public.private_hands add constraint private_hands_unique unique (game_id, hand_number, player_id);
alter table public.user_stats_private add constraint user_stats_private_pkey primary key (user_id);
alter table public.user_stats_public add constraint user_stats_public_pkey primary key (user_id);

-- ── Foreign keys ──────────────────────────────────────────────────────────
alter table public.users add constraint users_id_fkey foreign key (id) references auth.users(id) on delete cascade;
alter table public.friendships add constraint friendships_addressee_id_fkey foreign key (addressee_id) references public.users(id) on delete cascade;
alter table public.friendships add constraint friendships_requester_id_fkey foreign key (requester_id) references public.users(id) on delete cascade;
alter table public.games add constraint games_host_id_fkey foreign key (host_id) references public.users(id);
alter table public.game_players add constraint game_players_game_id_fkey foreign key (game_id) references public.games(id) on delete cascade;
alter table public.game_players add constraint game_players_user_id_fkey foreign key (user_id) references public.users(id);
alter table public.game_messages add constraint game_messages_game_id_fkey foreign key (game_id) references public.games(id) on delete cascade;
alter table public.game_messages add constraint game_messages_sender_id_fkey foreign key (sender_id) references public.users(id);
alter table public.payout_ledger add constraint payout_ledger_game_id_fkey foreign key (game_id) references public.games(id) on delete set null;
alter table public.payout_ledger add constraint payout_ledger_opponent_id_fkey foreign key (opponent_id) references public.users(id) on delete cascade;
alter table public.payout_ledger add constraint payout_ledger_user_id_fkey foreign key (user_id) references public.users(id) on delete cascade;
alter table public.player_actions add constraint player_actions_game_id_fkey foreign key (game_id) references public.games(id) on delete cascade;
alter table public.player_actions add constraint player_actions_player_id_fkey foreign key (player_id) references public.users(id);
alter table public.private_hands add constraint private_hands_game_id_fkey foreign key (game_id) references public.games(id) on delete cascade;
alter table public.private_hands add constraint private_hands_player_id_fkey foreign key (player_id) references public.users(id);
alter table public.user_stats_private add constraint user_stats_private_user_id_fkey foreign key (user_id) references public.users(id) on delete cascade;
alter table public.user_stats_public add constraint user_stats_public_user_id_fkey foreign key (user_id) references public.users(id) on delete cascade;

create index if not exists game_messages_game_id_idx on public.game_messages using btree (game_id, created_at);

-- ── Row-level security ────────────────────────────────────────────────────
alter table public.users enable row level security;
alter table public.friendships enable row level security;
alter table public.games enable row level security;
alter table public.game_players enable row level security;
alter table public.game_messages enable row level security;
alter table public.payout_ledger enable row level security;
alter table public.player_actions enable row level security;
alter table public.private_hands enable row level security;
alter table public.user_stats_private enable row level security;
alter table public.user_stats_public enable row level security;

create policy "Users can insert own profile" on public.users for insert with check (auth.uid() = id);
create policy "Users can read all profiles" on public.users for select using (true);
create policy "Users can update own profile" on public.users for update using (auth.uid() = id);

create policy "Addressee can update status" on public.friendships for update using (auth.uid() = addressee_id);
create policy "Users can create friend requests" on public.friendships for insert with check (auth.uid() = requester_id);
create policy "Users can delete their friendships" on public.friendships for delete using (auth.uid() = requester_id or auth.uid() = addressee_id);
create policy "Users can see their friendships" on public.friendships for select using (auth.uid() = requester_id or auth.uid() = addressee_id);

create policy "Allow delete games" on public.games for delete using (true);
create policy "Anyone authenticated can update games" on public.games for update using (auth.uid() is not null);
create policy "Anyone can read games" on public.games for select using (true);
create policy "Authenticated users can create games" on public.games for insert with check (auth.uid() = host_id);

create policy "Allow delete game_players" on public.game_players for delete using (true);
create policy "Anyone auth can join games" on public.game_players for insert with check (auth.uid() is not null);
create policy "Anyone can read game players" on public.game_players for select using (true);
create policy "Users can update their own seat" on public.game_players for update using (auth.uid() = user_id);

create policy "Anyone auth can delete messages" on public.game_messages for delete using (auth.uid() is not null);
create policy "Anyone auth can read messages" on public.game_messages for select using (auth.uid() is not null);
create policy "Send as yourself" on public.game_messages for insert with check (auth.uid() = sender_id);

create policy "Delete own ledger" on public.payout_ledger for delete using (auth.uid() = user_id);
create policy "Insert own ledger" on public.payout_ledger for insert with check (auth.uid() = user_id);
create policy "Read own ledger" on public.payout_ledger for select using (auth.uid() = user_id or auth.uid() = opponent_id);
create policy "Update own ledger" on public.payout_ledger for update using (auth.uid() = user_id);

create policy "Allow delete player_actions" on public.player_actions for delete using (true);
create policy "Anyone can read actions" on public.player_actions for select using (true);
create policy "Players can insert their own actions" on public.player_actions for insert with check (auth.uid() = player_id);

create policy "Anyone auth can delete hands" on public.private_hands for delete using (true);
create policy "Anyone auth can write hands" on public.private_hands for insert with check (auth.uid() is not null);
create policy "Players read own hands" on public.private_hands for select using (auth.uid() = player_id);

create policy "Delete own private stats" on public.user_stats_private for delete using (auth.uid() = user_id);
create policy "Insert own private stats" on public.user_stats_private for insert with check (auth.uid() = user_id);
create policy "Read own private stats" on public.user_stats_private for select using (auth.uid() = user_id);
create policy "Update own private stats" on public.user_stats_private for update using (auth.uid() = user_id);

create policy "Anyone auth can read public stats" on public.user_stats_public for select using (auth.uid() is not null);
create policy "Delete own public stats" on public.user_stats_public for delete using (auth.uid() = user_id);
create policy "Insert own public stats" on public.user_stats_public for insert with check (auth.uid() = user_id);
create policy "Update own public stats" on public.user_stats_public for update using (auth.uid() = user_id);

-- ── Realtime ──────────────────────────────────────────────────────────────
alter publication supabase_realtime add table public.games;
alter publication supabase_realtime add table public.game_players;
alter publication supabase_realtime add table public.game_messages;
alter publication supabase_realtime add table public.player_actions;
alter publication supabase_realtime add table public.private_hands;
alter table public.game_players replica identity full;
