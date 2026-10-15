-- Run with pgTAP in a test/local Supabase database after menu-access.sql.
-- Test users, role membership, menu changes and metadata all roll back.
begin;
select plan(19);
insert into auth.users(id,email) values
  ('11111111-1111-4111-8111-111111111111','menu-member@example.invalid'),
  ('22222222-2222-4222-8222-222222222222','menu-admin@example.invalid');
insert into public.bid_admin_users(user_id) values ('22222222-2222-4222-8222-222222222222');

set local role anon;
select is((select count(menu_key) from public.bid_menu_settings),4::bigint,'anonymous visitors can read menu status');
select throws_ok($$select updated_by from public.bid_menu_settings$$,'42501',null,'menu status does not expose administrator identifiers');
select throws_ok($$update public.bid_menu_settings set locked=false$$,'42501',null,'anonymous visitors cannot unlock menus');
select throws_ok($$select user_id from public.bid_admin_users$$,'42501',null,'anonymous visitors cannot enumerate administrators');

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
select is((select count(user_id) from public.bid_admin_users),0::bigint,'a regular member has no admin membership');
select throws_ok($$insert into public.bid_admin_users(user_id) values ('11111111-1111-4111-8111-111111111111')$$,'42501',null,'members cannot promote themselves');
select results_eq($$update public.bid_menu_settings set locked=false where menu_key='results' returning menu_key$$,array[]::text[],'members cannot update settings');
set local request.jwt.claims = '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","user_metadata":{"role":"admin","isAdmin":true}}';
select results_eq($$update public.bid_menu_settings set locked=false where menu_key='results' returning menu_key$$,array[]::text[],'user-editable metadata cannot grant menu administration');

set local request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
set local request.jwt.claims = '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select is((select count(user_id) from public.bid_admin_users),1::bigint,'an administrator reads their own membership');
select results_eq($$update public.bid_menu_settings set locked=false where menu_key='results' returning locked$$,array[false],'an administrator can unlock MY');
select results_eq($$update public.bid_menu_settings set message='검수 완료' where menu_key='results' returning message$$,array['검수 완료'],'an administrator can edit maintenance copy');
select throws_ok($$update public.bid_menu_settings set updated_at='2000-01-01' where menu_key='results'$$,'42501',null,'timestamps cannot be forged by the browser');
select throws_ok($$update public.bid_menu_settings set menu_key='profile' where menu_key='results'$$,'42501',null,'menu identities cannot be reassigned');
select throws_ok($$insert into public.bid_menu_settings(menu_key,locked) values ('results',false)$$,'42501',null,'administrators cannot replace the fixed menu registry');
select throws_ok($$delete from public.bid_menu_settings where menu_key='results'$$,'42501',null,'administrators cannot delete a menu policy');
select throws_ok($$delete from public.bid_admin_users where user_id='22222222-2222-4222-8222-222222222222'$$,'42501',null,'web administrator sessions cannot edit role membership');
select throws_ok($$select updated_by from public.bid_menu_settings$$,'42501',null,'administrator identity is not public menu data');

reset role;
select is((select updated_by::text from public.bid_menu_settings where menu_key='results'),'22222222-2222-4222-8222-222222222222','the trigger records the verified administrator');
select is((select count(*) from public.bid_menu_settings),4::bigint,'the four fixed menu policies remain intact');
select * from finish();
rollback;
