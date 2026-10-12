-- Run against a local/test Supabase database with pgTAP enabled after member-workspaces.sql.
-- All inserted users and workspace rows are rolled back; this script has no production fixtures.
begin;
select plan(15);

insert into auth.users(id, email) values
  ('11111111-1111-4111-8111-111111111111', 'workspace-rls-a@example.invalid'),
  ('22222222-2222-4222-8222-222222222222', 'workspace-rls-b@example.invalid');

set local role anon;
select throws_ok($$select * from public.bid_member_workspaces$$, '42501', null, 'anon cannot read member workspaces');
select throws_ok($$insert into public.bid_member_workspaces(user_id,data) values ('11111111-1111-4111-8111-111111111111','{}')$$, '42501', null, 'anon cannot insert member workspaces');
select throws_ok($$update public.bid_member_workspaces set data = '{}'$$, '42501', null, 'anon cannot update member workspaces');
select throws_ok($$delete from public.bid_member_workspaces$$, '42501', null, 'anon cannot delete member workspaces');

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
select throws_ok($$insert into public.bid_member_workspaces(user_id,data) values ('11111111-1111-4111-8111-111111111111','{}')$$, '23514', null, 'missing JSON version and profile id cannot bypass the check with NULL');
select throws_ok($$insert into public.bid_member_workspaces(user_id,data) values ('11111111-1111-4111-8111-111111111111','{"version":1,"profile":{"id":"22222222-2222-4222-8222-222222222222"}}')$$, '23514', null, 'JSON profile id must match row owner');
select results_eq(
  $$insert into public.bid_member_workspaces(user_id,data) values ('11111111-1111-4111-8111-111111111111','{"version":1,"profile":{"id":"11111111-1111-4111-8111-111111111111"}}') returning user_id::text$$,
  array['11111111-1111-4111-8111-111111111111'], 'owner inserts own workspace');
select results_eq($$select user_id::text from public.bid_member_workspaces$$, array['11111111-1111-4111-8111-111111111111'], 'owner reads own workspace');
select results_eq($$update public.bid_member_workspaces set data = jsonb_set(data, '{updated}', 'true') returning data ->> 'updated'$$, array['true'], 'owner updates own workspace');
select throws_ok($$delete from public.bid_member_workspaces$$, '42501', null, 'member deletion is not granted');
select throws_ok($$update public.bid_member_workspaces set user_id = '22222222-2222-4222-8222-222222222222', data = '{"version":1,"profile":{"id":"22222222-2222-4222-8222-222222222222"}}'$$, '42501', null, 'owner cannot transfer row ownership');

set local request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
select is((select count(*) from public.bid_member_workspaces), 0::bigint, 'another member cannot read owner workspace');
select results_eq($$update public.bid_member_workspaces set data = jsonb_set(data, '{hijacked}', 'true') returning user_id::text$$, array[]::text[], 'another member cannot update owner workspace');
select throws_ok($$insert into public.bid_member_workspaces(user_id,data) values ('11111111-1111-4111-8111-111111111111','{"version":1,"profile":{"id":"11111111-1111-4111-8111-111111111111"}}')$$, '42501', null, 'another member cannot insert owner workspace');
select throws_ok($$delete from public.bid_member_workspaces$$, '42501', null, 'another member cannot delete owner workspace');

select * from finish();
rollback;
