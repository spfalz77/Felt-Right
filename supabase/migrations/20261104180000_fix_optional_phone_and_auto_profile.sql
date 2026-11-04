-- Optional phone: store blanks as NULL so UNIQUE(phone) doesn't block a 2nd phone-less signup
update public.users set phone = null where btrim(coalesce(phone, '')) = '';

create or replace function public.normalize_user_phone()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.phone := nullif(btrim(coalesce(new.phone, '')), '');
  return new;
end $$;

drop trigger if exists normalize_user_phone on public.users;
create trigger normalize_user_phone
  before insert or update of phone on public.users
  for each row execute function public.normalize_user_phone();

-- Create the app profile automatically when an auth account is created
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.users (id, display_name, phone)
  values (
    new.id,
    coalesce(nullif(btrim(new.raw_user_meta_data->>'display_name'), ''), split_part(new.email, '@', 1)),
    nullif(btrim(coalesce(new.raw_user_meta_data->>'phone', '')), '')
  )
  on conflict (id) do nothing;
  return new;
exception when unique_violation then
  insert into public.users (id, display_name)
  values (new.id, coalesce(nullif(btrim(new.raw_user_meta_data->>'display_name'), ''), split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill any accounts that are missing a profile
insert into public.users (id, display_name)
select u.id, coalesce(nullif(btrim(u.raw_user_meta_data->>'display_name'), ''), split_part(u.email, '@', 1))
from auth.users u left join public.users p on p.id = u.id
where p.id is null
on conflict (id) do nothing;
