-- Disposable PostgreSQL only. No HTTP, cron or live push is performed.
begin;
insert into auth.users(id,email) values
 ('11111111-1111-4111-8111-111111111111','trash-a@example.invalid'),
 ('22222222-2222-4222-8222-222222222222','trash-b@example.invalid');
insert into public.bid_alert_settings(user_id,settings) values
 ('11111111-1111-4111-8111-111111111111',jsonb_set(jsonb_set(bid_alert_private.defaults(),'{enabled}','true'),'{pushEnabled}','true')),
 ('22222222-2222-4222-8222-222222222222',jsonb_set(bid_alert_private.defaults(),'{enabled}','true'));
update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8')),
 lease_id=null,lease_until=null,last_checked_at=null where singleton;
create function pg_temp.trash_notice() returns jsonb language sql as $$
 select jsonb_build_object('id','g2b:공사:R26DELETE00001:000','type','공사','number','R26DELETE00001','revision','000',
 'title','복원 가능한 알림','agency','공개기관','status','접수중','source','live','postedAt',now()-interval '1 day',
 'sourceUpdatedAt',now()-interval '1 day','deadline',now()+interval '3 days','openingAt',now()+interval '4 days');
$$;
insert into public.bid_alert_inbox(id,user_id,notice_key,version,kind,notice,message,created_at,deleted_at)
select ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'11111111-1111-4111-8111-111111111111',
 'fixture:'||n,1,'new',pg_temp.trash_notice(),'owner A '||n,now()-make_interval(mins=>n),
 case when n>35 then now()-make_interval(mins=>n) end from generate_series(1,67) n;
insert into public.bid_alert_inbox(id,user_id,notice_key,version,kind,notice,message) values
 ('20000000-0000-4000-8000-000000000001','22222222-2222-4222-8222-222222222222','other:1',1,'new',pg_temp.trash_notice(),'other owner');
insert into bid_alert_private.observations(notice_key,notice,fingerprint,version,revision,source_updated_at)
 values('fixture:1',pg_temp.trash_notice(),repeat('d',64),1,0,now()-interval '1 day');
insert into bid_alert_private.memberships(user_id,notice_key,last_version,initial)
 values('11111111-1111-4111-8111-111111111111','fixture:1',1,true);
insert into bid_alert_private.subscriptions(id,user_id,endpoint_hash,subscription)
 values('30000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',sha256('offline-trash'::bytea),'{}');
insert into bid_alert_private.deliveries(notification_id,subscription_id)
 values('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001');
do $$ begin
 assert not has_table_privilege('authenticated','public.bid_alert_inbox','update'),'client cannot bypass owner RPC';
 assert not has_function_privilege('anon','public.bid_alert_user(text,jsonb)','execute'),'anonymous deletion remains denied';
 assert not has_function_privilege('authenticated','bid_alert_private.overview(uuid,integer,integer,integer)','execute'),'trash helper remains private';
 assert (select storage_ceiling=33554432 from bid_alert_private.runtime),'32MiB ceiling unchanged';
 assert (select storage_ceiling=16777216 from bid_active_catalog_private.runtime),'16MiB catalog ceiling unchanged';
end $$;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
do $$ declare result jsonb;failed boolean;begin
 result:=public.bid_alert_user('get','{}');
 assert jsonb_array_length(result->'notifications')=30 and result->>'hasMore'='true','visible pagination filters hidden rows first';
 assert result->>'unreadCount'='35','unread count excludes trash';
 assert result->>'deletedCount'='32' and result->>'deletedHasMore'='true','trash has its own total and continuation';
 result:=public.bid_alert_user('get','{"offset":30,"deletedOffset":30}');
 assert jsonb_array_length(result->'notifications')=5 and result->>'hasMore'='false','visible tail contains only remaining visible records';
 assert jsonb_array_length(result->'deletedNotifications')=2 and result->>'deletedHasMore'='false','trash tail is independently paginated';
 assert (select count(*)=67 from public.bid_alert_inbox),'owner RLS hides all other accounts';
 assert public.bid_alert_user('delete','{"id":"20000000-0000-4000-8000-000000000001"}')='{"ok":true}'::jsonb,'unknown or other-owner ID is an indistinguishable no-op';
 result:=public.bid_alert_user('delete','{"id":"10000000-0000-4000-8000-000000000001"}');
 assert result='{"ok":true}'::jsonb,'single delete succeeds';
 result:=public.bid_alert_user('get','{}');
 assert result->>'unreadCount'='34' and result->>'deletedCount'='33','deleting unread item updates both counts';
 assert not exists(select 1 from jsonb_array_elements(result->'notifications') x where x->>'id'='10000000-0000-4000-8000-000000000001'),'deleted item disappears from visible page';
 assert result#>>'{deletedNotifications,0,id}'='10000000-0000-4000-8000-000000000001' and result#>>'{deletedNotifications,0,deletedAt}' is not null,'latest deletion appears first with a recovery timestamp';
 perform public.bid_alert_user('read','{"all":true}');
 assert (select read_at is null from public.bid_alert_inbox where id='10000000-0000-4000-8000-000000000001'),'mark all read preserves hidden item read state';
 perform public.bid_alert_user('restore','{"id":"10000000-0000-4000-8000-000000000001"}');
 result:=public.bid_alert_user('get','{}');
 assert result->>'unreadCount'='1' and result->>'deletedCount'='32','restoring preserves the original unread state';
 assert exists(select 1 from jsonb_array_elements(result->'notifications') x where x->>'id'='10000000-0000-4000-8000-000000000001' and x->'deletedAt'='null'::jsonb),'restored item returns to inbox';
 failed:=false;begin perform public.bid_alert_user('delete','{"id":"not-a-uuid"}');exception when invalid_parameter_value then failed:=true;end;
 assert failed,'invalid ID is rejected';
 failed:=false;begin perform public.bid_alert_user('delete','{"id":"10000000-0000-4000-8000-000000000001","all":true}');exception when invalid_parameter_value then failed:=true;end;
 assert failed,'ambiguous single/bulk mutation is rejected';
 failed:=false;begin perform public.bid_alert_user('get','{"deletedOffset":-1}');exception when invalid_parameter_value then failed:=true;end;
 assert failed,'negative trash cursor is rejected';
 perform public.bid_alert_user('delete','{"all":true}');
 result:=public.bid_alert_user('get','{}');
 assert result->'notifications'='[]'::jsonb and result->>'unreadCount'='0' and result->>'deletedCount'='67','bulk delete affects all owner-visible records';
 assert (select count(*)=67 from public.bid_alert_inbox),'bulk deletion retains recoverable rows';
end $$;
reset role;
do $$ begin
 assert (select deleted_at is null from public.bid_alert_inbox where user_id='22222222-2222-4222-8222-222222222222'),'bulk deletion never touches another account';
 assert (select count(*)=1 from bid_alert_private.observations where notice_key='fixture:1'),'delete preserves observations';
 assert (select last_version=1 and initial from bid_alert_private.memberships where notice_key='fixture:1'),'delete preserves membership dedup ledger';
 assert (select status='failed' from bid_alert_private.deliveries where notification_id='10000000-0000-4000-8000-000000000001'),'deletion stops pending push';
 insert into public.bid_alert_inbox(user_id,notice_key,version,kind,notice,message)
 values('11111111-1111-4111-8111-111111111111','fixture:1',1,'new',pg_temp.trash_notice(),'duplicate provider replay') on conflict(user_id,notice_key,version) do nothing;
 assert (select count(*)=1 and bool_and(deleted_at is not null) from public.bid_alert_inbox where user_id='11111111-1111-4111-8111-111111111111' and notice_key='fixture:1'),'same notice/version cannot recreate a deleted alert';
 -- A later meaningful version is allowed; only the old version stays deduped.
 insert into public.bid_alert_inbox(id,user_id,notice_key,version,kind,notice,message)
 values('10000000-0000-4000-8000-000000000068','11111111-1111-4111-8111-111111111111','fixture:1',2,'changed',pg_temp.trash_notice(),'new version after delete');
 assert (select settings->>'enabled'='true' from public.bid_alert_settings where user_id='11111111-1111-4111-8111-111111111111'),'deleting past alerts never disables future alerts';
 assert (select count(*)=2 from public.bid_alert_inbox where user_id='11111111-1111-4111-8111-111111111111' and notice_key='fixture:1'),'new meaningful version can notify while deleted old version remains';
end $$;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
do $$ declare result jsonb;begin
 result:=public.bid_alert_user('get','{}');
 assert jsonb_array_length(result->'notifications')=1 and result#>>'{notifications,0,id}'='10000000-0000-4000-8000-000000000068','new arrivals after bulk delete remain visible';
 perform public.bid_alert_user('restore','{"all":true}');
 result:=public.bid_alert_user('get','{}');
 assert result->>'deletedCount'='0' and result->'deletedNotifications'='[]'::jsonb and result->>'hasMore'='true','bulk restore returns all owner records';
 perform public.bid_alert_user('delete','{"id":"10000000-0000-4000-8000-000000000001"}');
end $$;
reset role;
-- Simulate a stale queue insert after the delete transaction, before dispatch.
update bid_alert_private.deliveries set status='pending' where notification_id='10000000-0000-4000-8000-000000000001';
do $$ declare claim jsonb;result jsonb;begin
 claim:=public.bid_alert_worker(repeat('a',64),'claim','{}');
 result:=public.bid_alert_worker(repeat('a',64),'deliveries',jsonb_build_object('leaseId',claim->>'leaseId'));
 assert result->'deliveries'='[]'::jsonb,'dispatch excludes a deleted notification even after a stale queue insertion';
 assert (select status='failed' from bid_alert_private.deliveries where notification_id='10000000-0000-4000-8000-000000000001'),'stale hidden delivery is settled';
 perform public.bid_alert_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',claim->>'leaseId'));
end $$;
update bid_alert_private.deliveries set status='pending' where notification_id='10000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
select public.bid_alert_user('restore','{"id":"10000000-0000-4000-8000-000000000001"}');
select public.bid_alert_user('delete','{"id":"10000000-0000-4000-8000-000000000036"}');
set local request.jwt.claim.sub='22222222-2222-4222-8222-222222222222';
do $$ declare result jsonb;begin
 perform public.bid_alert_user('restore','{"id":"10000000-0000-4000-8000-000000000036"}');
 result:=public.bid_alert_user('get','{}');
 assert result->>'deletedCount'='0' and jsonb_array_length(result->'notifications')=1,'other account sees and restores only its own inbox';
end $$;
reset role;
do $$ declare claim jsonb;result jsonb;begin
 assert (select deleted_at is not null from public.bid_alert_inbox where id='10000000-0000-4000-8000-000000000036'),'another owner cannot restore a hidden notification';
 assert (select status='failed' from bid_alert_private.deliveries where notification_id='10000000-0000-4000-8000-000000000001'),'restore settles a stale pending race and never resends old push';
 claim:=public.bid_alert_worker(repeat('a',64),'claim','{}');
 if claim->>'leaseId' is not null then
   result:=public.bid_alert_worker(repeat('a',64),'deliveries',jsonb_build_object('leaseId',claim->>'leaseId'));
   assert result->'deliveries'='[]'::jsonb,'restored historical alert is not dispatched again';
 end if;
end $$;
set local request.jwt.claim.sub='';
do $$ declare failed boolean:=false;begin
 begin perform public.bid_alert_user('delete','{"all":true}');exception when insufficient_privilege then failed:=true;end;
 assert failed,'missing authenticated identity cannot delete any inbox';
end $$;
rollback;
