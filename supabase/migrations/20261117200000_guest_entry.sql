-- Guest entry (getting-in plan, phase 1).
--
-- A guest is an anonymous Supabase user (auth.users.is_anonymous). Guests can
-- join and play any game they're invited to (link or invite). Until they
-- verify, they can't host (unless the guest_hosting switch is on), have
-- friends, keep stats, or appear in anyone's Standings: their results are
-- shown at the table and never saved.

-- 1. Profiles know who's a guest (other players' phones read this)
alter table public.users add column if not exists is_guest boolean not null default false;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  nm text := left(coalesce(nullif(btrim(new.raw_user_meta_data->>'display_name'), ''),
                           nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
                           'Guest'), 30);
  av text := coalesce(nullif(btrim(new.raw_user_meta_data->>'avatar_emoji'), ''), '🃏');
begin
  insert into public.users (id, display_name, phone, avatar_emoji, is_guest)
  values (new.id, nm, nullif(btrim(coalesce(new.raw_user_meta_data->>'phone', '')), ''), left(av, 8),
          coalesce(new.is_anonymous, false))
  on conflict (id) do nothing;
  return new;
exception when unique_violation then
  insert into public.users (id, display_name, avatar_emoji, is_guest)
  values (new.id, nm, left(av, 8), coalesce(new.is_anonymous, false))
  on conflict (id) do nothing;
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- A guest who becomes a full account (phase 2: email + code) stops being a guest
create or replace function public.handle_user_verified()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(old.is_anonymous, false) and not coalesce(new.is_anonymous, false) then
    update public.users set is_guest = false where id = new.id;
  end if;
  return new;
end $$;
revoke execute on function public.handle_user_verified() from public, anon, authenticated;
drop trigger if exists on_auth_user_verified on auth.users;
create trigger on_auth_user_verified
  after update of is_anonymous on auth.users
  for each row execute function public.handle_user_verified();

-- Names are shown on other people's screens: keep them to plain text
-- (no markup characters), 1–30 characters, for guests and accounts alike.
create or replace function public.clean_display_name()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.display_name := left(btrim(regexp_replace(coalesce(new.display_name, ''), '[<>&"''`\\]|[[:cntrl:]]', '', 'g')), 30);
  if new.display_name = '' then new.display_name := 'Player'; end if;
  return new;
end $$;
drop trigger if exists clean_display_name on public.users;
create trigger clean_display_name
  before insert or update of display_name on public.users
  for each row execute function public.clean_display_name();

-- 2. "Is the caller a guest?" for the rules below
create or replace function public.is_guest()
returns boolean language sql stable set search_path = '' as $$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
$$;
grant execute on function public.is_guest() to anon, authenticated;

create or replace function public.guest_hosting_on()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.feature_flags where key = 'guest_hosting' and state in ('beta', 'on'))
$$;
grant execute on function public.guest_hosting_on() to anon, authenticated;

-- 3. What guests can't do (restrictive: on top of the existing rules)
drop policy if exists "Guests host only when guest hosting is on" on public.games;
create policy "Guests host only when guest hosting is on" on public.games
  as restrictive for insert with check (not public.is_guest() or public.guest_hosting_on());

drop policy if exists "Guests have no friends list" on public.friendships;
create policy "Guests have no friends list" on public.friendships
  as restrictive for insert
  with check (not public.is_guest()
              and not exists (select 1 from public.users u where u.id = addressee_id and u.is_guest));

drop policy if exists "Guests keep no stats" on public.user_stats_public;
create policy "Guests keep no stats" on public.user_stats_public
  as restrictive for insert with check (not public.is_guest());
drop policy if exists "Guests keep no stats (update)" on public.user_stats_public;
create policy "Guests keep no stats (update)" on public.user_stats_public
  as restrictive for update using (not public.is_guest());
drop policy if exists "Guests keep no stats" on public.user_stats_private;
create policy "Guests keep no stats" on public.user_stats_private
  as restrictive for insert with check (not public.is_guest());
drop policy if exists "Guests keep no stats (update)" on public.user_stats_private;
create policy "Guests keep no stats (update)" on public.user_stats_private
  as restrictive for update using (not public.is_guest());

-- 4. Standings never count a guest: rows for any pair with a guest in it are
--    dropped, whoever writes them (the table function, settle_home_game_ledger)
create or replace function public.skip_guest_ledger_rows()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.users u where u.id in (new.user_id, new.opponent_id) and u.is_guest) then
    return null;
  end if;
  return new;
end $$;
revoke execute on function public.skip_guest_ledger_rows() from public, anon, authenticated;
drop trigger if exists skip_guest_ledger_rows on public.payout_ledger;
create trigger skip_guest_ledger_rows
  before insert on public.payout_ledger
  for each row execute function public.skip_guest_ledger_rows();

-- 5. Invite links: ?join=<first 8 characters of the game id>
--    Returns the game (id, status) so the app can open its lobby, or nothing.
create or replace function public.game_for_code(p_code text)
returns table (id uuid, status text, name text)
language sql stable security definer set search_path = '' as $$
  select g.id, g.status, g.name
    from public.games g
   where length(regexp_replace(coalesce(p_code, ''), '[^0-9a-fA-F]', '', 'g')) >= 8
     and g.id::text like lower(left(regexp_replace(p_code, '[^0-9a-fA-F]', '', 'g'), 8)) || '%'
     and g.status in ('lobby', 'active')
   order by g.created_at desc
   limit 1
$$;
revoke execute on function public.game_for_code(text) from public;
grant execute on function public.game_for_code(text) to anon, authenticated;

-- 6. The "Play now" splash is behind a switch: turn it on once Anonymous
--    sign-ins are enabled in the Supabase dashboard (Authentication →
--    Sign In / Providers). Off: the splash shows sign in / create account as before.
insert into public.feature_flags (key, state, note) values
  ('guest_play', 'off', 'Play without an account. Turn on after enabling Anonymous sign-ins in the dashboard')
on conflict (key) do nothing;
