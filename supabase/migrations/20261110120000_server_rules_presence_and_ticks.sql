-- Server-run games, phase 4: who's still at the table, and a clock backstop.
--
-- game_presence: each phone in a server-run game writes its own heartbeat
-- every few seconds. The `table` function counts a player as gone (app
-- closed, phone offline) after 12s without one, and then checks/folds their
-- turns after 5s instead of waiting out the full turn. Not in the realtime
-- publication, so heartbeats don't wake anyone's screen.

create table if not exists public.game_presence (
  game_id      uuid not null references public.games(id) on delete cascade,
  user_id      uuid not null references public.users(id) on delete cascade,
  last_seen_at timestamp with time zone not null default now(),
  primary key (game_id, user_id)
);
alter table public.game_presence enable row level security;
create policy "Write own heartbeat" on public.game_presence for insert with check (auth.uid() = user_id);
create policy "Update own heartbeat" on public.game_presence for update using (auth.uid() = user_id);
create policy "Read own heartbeat" on public.game_presence for select using (auth.uid() = user_id);

-- Backstop: once a minute, ask the table function to apply anything that's
-- come due (next deal, timed-out turns) in every server-run game, so a table
-- moves even if every phone is asleep. Needs two Vault secrets, set when the
-- function is deployed (phase 6):
--   table_function_url  e.g. https://<project>.supabase.co/functions/v1/table
--   service_role_key    the project's service role key
-- Until both exist, or while no server-run game is active, it does nothing.
create extension if not exists pg_net with schema extensions;

create or replace function public.tick_server_tables()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_key text;
begin
  if not exists (
    select 1 from public.game_secrets s join public.games g on g.id = s.game_id
    where g.status = 'active'
  ) then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'table_function_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then return; end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := jsonb_build_object('action', 'tick_all')
  );
end $$;
revoke execute on function public.tick_server_tables() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'tick-server-tables';
    perform cron.schedule('tick-server-tables', '* * * * *', 'select public.tick_server_tables()');
  end if;
end $$;
