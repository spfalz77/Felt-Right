-- Server rules, phase 6a: the once-a-minute backstop authenticates with its
-- own shared secret instead of the service-role key.
--
-- Vault secrets (set once when the `table` function is deployed):
--   table_function_url  https://<project>.supabase.co/functions/v1/table
--   table_anon_key      the project's anon (public) key, to pass the gateway
--   table_tick_secret   random string; the function has the same value in its
--                       TABLE_TICK_SECRET env, and only then runs tick_all
-- Until all three exist, or while no server-run game is active, it does nothing.

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
