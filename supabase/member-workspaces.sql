-- Apply only to the project's explicitly selected Supabase database.
-- No prototype data is imported. Every authenticated user starts with an empty workspace.
begin;

create table if not exists public.bid_member_workspaces (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default clock_timestamp()
);

-- Replace the earlier unnamed/default-named check as well as enforcing it on fresh tables.
-- PostgreSQL accepts NULL CHECK results, so coalesce is required for missing JSON paths.
alter table public.bid_member_workspaces drop constraint if exists bid_member_workspaces_data_check;
alter table public.bid_member_workspaces add constraint bid_member_workspaces_data_check
  check (coalesce(jsonb_typeof(data) = 'object' and data ->> 'version' = '1' and data #>> '{profile,id}' = user_id::text, false));

alter table public.bid_member_workspaces enable row level security;
revoke all on table public.bid_member_workspaces from anon, authenticated;
grant select, insert, update on table public.bid_member_workspaces to authenticated;

drop policy if exists bid_workspace_read_own on public.bid_member_workspaces;
create policy bid_workspace_read_own on public.bid_member_workspaces for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists bid_workspace_insert_own on public.bid_member_workspaces;
create policy bid_workspace_insert_own on public.bid_member_workspaces for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists bid_workspace_update_own on public.bid_member_workspaces;
create policy bid_workspace_update_own on public.bid_member_workspaces for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Server-issued version stamps make browser writes compare-and-swap, not last-write-wins.
create or replace function public.bid_workspace_set_updated_at()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at := greatest(clock_timestamp(), old.updated_at + interval '1 microsecond');
  return new;
end;
$$;
revoke all on function public.bid_workspace_set_updated_at() from public, anon, authenticated;
drop trigger if exists bid_workspace_updated_at on public.bid_member_workspaces;
create trigger bid_workspace_updated_at before update on public.bid_member_workspaces
  for each row execute function public.bid_workspace_set_updated_at();

commit;
