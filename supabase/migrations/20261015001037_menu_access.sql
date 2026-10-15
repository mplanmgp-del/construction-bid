-- Apply only to the explicitly selected construction-bid database.
-- Administrator membership is provisioned by a database owner, never by signup metadata.
begin;

create table if not exists public.bid_admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.bid_admin_users enable row level security;
revoke all on table public.bid_admin_users from public, anon, authenticated;
grant select (user_id) on table public.bid_admin_users to authenticated;
drop policy if exists bid_admin_read_own on public.bid_admin_users;
create policy bid_admin_read_own on public.bid_admin_users for select to authenticated
  using ((select auth.uid()) = user_id);

create table if not exists public.bid_menu_settings (
  menu_key text primary key check (menu_key in ('notices','bookmarks','profile','results')),
  locked boolean not null default false,
  message text not null default '' check (char_length(message) <= 300),
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid references auth.users(id) on delete set null
);
alter table public.bid_menu_settings enable row level security;
revoke all on table public.bid_menu_settings from public, anon, authenticated;
grant select (menu_key,locked,message,updated_at) on table public.bid_menu_settings to anon, authenticated;
grant update (locked,message) on table public.bid_menu_settings to authenticated;
drop policy if exists bid_menu_read_public on public.bid_menu_settings;
create policy bid_menu_read_public on public.bid_menu_settings for select to anon, authenticated using (true);
drop policy if exists bid_menu_update_admin on public.bid_menu_settings;
create policy bid_menu_update_admin on public.bid_menu_settings for update to authenticated
  using (exists (select 1 from public.bid_admin_users where user_id = (select auth.uid())))
  with check (exists (select 1 from public.bid_admin_users where user_id = (select auth.uid())));

create or replace function public.bid_menu_stamp_update()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at := greatest(clock_timestamp(), old.updated_at + interval '1 microsecond');
  new.updated_by := auth.uid();
  return new;
end;
$$;
revoke all on function public.bid_menu_stamp_update() from public, anon, authenticated;
drop trigger if exists bid_menu_updated_at on public.bid_menu_settings;
create trigger bid_menu_updated_at before update on public.bid_menu_settings
  for each row execute function public.bid_menu_stamp_update();

-- Reapplying the schema preserves every administrator's saved menu choice.
insert into public.bid_menu_settings(menu_key,locked,message) values
  ('notices',false,''), ('bookmarks',false,''), ('profile',false,''),
  ('results',true,'MY입찰관리 기능을 점검하고 있습니다. 안정화 후 다시 제공하겠습니다.')
on conflict (menu_key) do nothing;

commit;
