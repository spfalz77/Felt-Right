-- Download counter + feature switches that turn on at a threshold.
--
-- app_installs: one row per install of the app (a random id the app makes on
-- first open and keeps). Web visits are counted too, but thresholds that say
-- "downloads" count only the Android and iPhone apps.
--
-- feature_flags: off / coming_soon / beta / on. A coming_soon flag with a
-- threshold switches itself to beta the moment the install count reaches it
-- (checked on every new install), and records when.
--   public_games  : coming soon; beta at 300 app downloads (decided 2026-11-17)
--   guest_hosting : off until switched on by hand
--
-- Phones can read the switches and the counts (feature_status()); only
-- register_install() writes, and only its own row.

create table if not exists public.app_installs (
  install_id uuid primary key,
  platform text not null check (platform in ('web', 'android', 'ios')),
  app_version text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
alter table public.app_installs enable row level security; -- no client policies: only the functions below

create table if not exists public.feature_flags (
  key text primary key,
  state text not null default 'off' check (state in ('off', 'coming_soon', 'beta', 'on')),
  threshold int,
  threshold_platforms text[] not null default array['android', 'ios'],
  reached_at timestamptz,
  note text,
  updated_at timestamptz not null default now()
);
alter table public.feature_flags enable row level security;
drop policy if exists "Anyone can read feature flags" on public.feature_flags;
create policy "Anyone can read feature flags" on public.feature_flags for select using (true);

insert into public.feature_flags (key, state, threshold, note) values
  ('public_games', 'coming_soon', 300, 'Opens as a beta at 300 app downloads'),
  ('guest_hosting', 'off', null, 'Guests can host: switched on by hand when there are enough users')
on conflict (key) do nothing;

create or replace function public.check_feature_thresholds()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.feature_flags f
     set state = 'beta', reached_at = now(), updated_at = now()
   where f.state = 'coming_soon' and f.threshold is not null
     and (select count(*) from public.app_installs i where i.platform = any (f.threshold_platforms)) >= f.threshold;
end $$;
revoke execute on function public.check_feature_thresholds() from public, anon, authenticated;

create or replace function public.register_install(p_install_id uuid, p_platform text, p_version text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare is_new boolean;
begin
  if p_install_id is null or p_platform not in ('web', 'android', 'ios') then raise exception 'bad install'; end if;
  insert into public.app_installs (install_id, platform, app_version)
  values (p_install_id, p_platform, left(p_version, 40))
  on conflict (install_id) do update
    set last_seen = now(), app_version = coalesce(excluded.app_version, public.app_installs.app_version)
  returning (xmax = 0) into is_new;
  if is_new then perform public.check_feature_thresholds(); end if;
end $$;
revoke execute on function public.register_install(uuid, text, text) from public;
grant execute on function public.register_install(uuid, text, text) to anon, authenticated;

-- What phones show: each switch, and how far along its threshold is
create or replace function public.feature_status()
returns table (key text, state text, threshold int, installs bigint, reached_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select f.key, f.state, f.threshold,
         (select count(*) from public.app_installs i where i.platform = any (f.threshold_platforms)),
         f.reached_at
    from public.feature_flags f
$$;
revoke execute on function public.feature_status() from public;
grant execute on function public.feature_status() to anon, authenticated;
