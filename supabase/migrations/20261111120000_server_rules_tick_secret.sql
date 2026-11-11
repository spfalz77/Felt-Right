-- Server rules, phase 6a: the once-a-minute backstop authenticates with its
-- own random secret instead of the service-role key.
--
-- table_tick_secret is generated here, in Vault, and never leaves the
-- database: tick_server_tables() sends it, and the `table` function reads it
-- through table_tick_secret(), which only the service role may call.
--
-- Two more Vault entries are added by hand on each project (not secret, but
-- project-specific):
--   table_function_url  https://<project>.supabase.co/functions/v1/table
--   table_anon_key      the project's anon (public) key, to pass the gateway
-- Until they exist, or while no server-run game is active, the backstop does
-- nothing.

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'table_tick_secret') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'table_tick_secret',
      'Shared secret: pg_cron backstop -> table Edge Function (tick_all)');
  end if;
end $$;

create or replace function public.table_tick_secret()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'table_tick_secret'
$$;
revoke execute on function public.table_tick_secret() from public, anon, authenticated;
grant execute on function public.table_tick_secret() to service_role;

create or replace function public.tick_server_tables()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_anon text;
  v_secret text;
begin
  if not exists (
    select 1 from public.game_secrets s join public.games g on g.id = s.game_id
    where g.status = 'active'
  ) then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'table_function_url';
  select decrypted_secret into v_anon from vault.decrypted_secrets where name = 'table_anon_key';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'table_tick_secret';
  if v_url is null or v_anon is null or v_secret is null then return; end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_anon,
      'x-tick-secret', v_secret),
    body := jsonb_build_object('action', 'tick_all')
  );
end $$;
revoke execute on function public.tick_server_tables() from public, anon, authenticated;
