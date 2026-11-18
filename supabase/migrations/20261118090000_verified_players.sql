-- Verified players (getting-in plan, phase 2): unique player names, and
-- deleting your account.
--
-- A verified player's name (users.display_name with name_set = true) is
-- unique ignoring case, 3–20 letters/numbers/spaces/_/-, and not reserved.
-- It's chosen once with set_player_name() (checked with
-- player_name_problem() as you type). Guests' names aren't unique.
-- Existing accounts keep their names where unique; the newer of two
-- clashing accounts is asked to pick another at its next sign-in.
--
-- Phones can't flip is_guest / name_set or change a verified name directly:
-- only these functions can.

alter table public.users add column if not exists name_set boolean not null default false;
alter table public.users add column if not exists deleted_at timestamptz;

-- Existing accounts: keep the name where it's unique (oldest account wins)
update public.users u set name_set = true
 where not u.is_guest
   and not exists (select 1 from public.users o
                    where o.id <> u.id and not o.is_guest
                      and lower(btrim(o.display_name)) = lower(btrim(u.display_name))
                      and (coalesce(o.created_at, 'epoch'), o.id) < (coalesce(u.created_at, 'epoch'), u.id));

create unique index if not exists users_player_name_unique
  on public.users (lower(btrim(display_name))) where name_set and not is_guest;

create table if not exists public.reserved_names (name text primary key);
alter table public.reserved_names enable row level security; -- read only through the function below
insert into public.reserved_names (name) values
  ('admin'), ('administrator'), ('felt right'), ('feltright'), ('felt-right'), ('guest'), ('player'),
  ('deleted player'), ('moderator'), ('mod'), ('support'), ('help'), ('dealer'), ('host'), ('system'),
  ('staff'), ('official'), ('anthropic'), ('claude'), ('null'), ('undefined'), ('you'), ('me')
on conflict do nothing;

-- Why a name can't be used (null = it can): length / characters / reserved / taken
create or replace function public.player_name_problem(p_name text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare n text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
begin
  if length(n) < 3 or length(n) > 20 then return 'length'; end if;
  if n !~ '^[A-Za-z0-9 _-]+$' then return 'characters'; end if;
  if exists (select 1 from public.reserved_names r where r.name = lower(n)) then return 'reserved'; end if;
  if exists (select 1 from public.users u
              where u.name_set and not u.is_guest and u.deleted_at is null
                and lower(btrim(u.display_name)) = lower(n)
                and u.id is distinct from auth.uid()) then return 'taken'; end if;
  return null;
end $$;
revoke execute on function public.player_name_problem(text) from public;
grant execute on function public.player_name_problem(text) to authenticated;

create or replace function public.set_player_name(p_name text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  n text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  problem text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if public.is_guest() then raise exception 'verify first'; end if;
  problem := public.player_name_problem(n);
  if problem is not null then raise exception '%', problem using errcode = 'P0001'; end if;
  perform set_config('felt.player_name', 'on', true);
  update public.users set display_name = n, name_set = true where id = auth.uid();
  return n;
exception when unique_violation then
  raise exception 'taken' using errcode = 'P0001';
end $$;
revoke execute on function public.set_player_name(text) from public, anon;
grant execute on function public.set_player_name(text) to authenticated;

-- Phones may still edit their own row (avatar, phone, a guest's name), but not
-- these columns, and not a verified player's name (that's set_player_name)
create or replace function public.guard_user_columns()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    if new.is_guest is distinct from old.is_guest
       or new.name_set is distinct from old.name_set
       or new.deleted_at is distinct from old.deleted_at then
      raise exception 'not allowed';
    end if;
    if old.name_set and not old.is_guest and new.display_name is distinct from old.display_name
       and coalesce(current_setting('felt.player_name', true), '') <> 'on' then
      raise exception 'use set_player_name';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_user_columns on public.users;
create trigger guard_user_columns
  before update on public.users
  for each row execute function public.guard_user_columns();

-- Delete account: called by the `account` function (service role), which then
-- soft-deletes the sign-in (auth). The profile stays as "Deleted player" so
-- other people's Standings and game history still add up; everything personal
-- goes: friends, devices, stats, the player's own Standings rows, phone, name.
create or replace function public.forget_user(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.friendships where requester_id = p_user_id or addressee_id = p_user_id;
  delete from public.push_tokens where user_id = p_user_id;
  delete from public.user_stats_public where user_id = p_user_id;
  delete from public.user_stats_private where user_id = p_user_id;
  delete from public.payout_ledger where user_id = p_user_id;
  update public.users
     set display_name = 'Deleted player', avatar_emoji = '🃏', phone = null,
         name_set = false, deleted_at = now()
   where id = p_user_id;
end $$;
revoke execute on function public.forget_user(uuid) from public, anon, authenticated;
grant execute on function public.forget_user(uuid) to service_role;

-- Sign-in by email code: the splash shows it when this switch is on (needs an
-- email sender and code templates set up in the dashboard). Off: passwords.
insert into public.feature_flags (key, state, note) values
  ('email_code_login', 'off', 'Sign in with an emailed 6-digit code. Turn on after custom SMTP + code email templates')
on conflict (key) do nothing;
