-- Transactional assertions for a disposable/local Supabase database only.
-- Apply member-workspaces.sql, menu-access.sql and alerts.sql first.
-- No cron setup, Vault writes, provider calls, or production fixtures are made.
begin;
insert into auth.users(id,email) values
 ('11111111-1111-4111-8111-111111111111','alerts-a@example.invalid'),
 ('22222222-2222-4222-8222-222222222222','alerts-b@example.invalid');

do $$ begin
 assert not has_table_privilege('anon','public.bid_alert_settings','select'), 'anonymous settings access denied';
 assert not has_table_privilege('authenticated','public.bid_alert_inbox','insert'), 'clients cannot insert events';
 assert not has_schema_privilege('authenticated','bid_alert_private','usage'), 'private queue is hidden';
 assert not has_function_privilege('anon','public.bid_alert_user(text,jsonb)','execute'), 'anonymous user RPC denied';
 assert has_function_privilege('authenticated','public.bid_alert_user(text,jsonb)','execute'), 'members can use owner RPC';
end $$;

set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
do $$ declare result jsonb; settings jsonb; begin
 result:=public.bid_alert_user('get','{}');
 assert result#>>'{settings,enabled}'='false', 'default alerts disabled';
 assert result->'notifications'='[]'::jsonb, 'empty inbox';
 settings:=result->'settings';
 settings:=jsonb_set(settings,'{enabled}','true');
 settings:=jsonb_set(settings,'{activatedAt}','"2000-01-01T00:00:00Z"');
 perform public.bid_alert_user('save',jsonb_build_object('settings',settings));
 result:=public.bid_alert_user('get','{}');
 assert (result#>>'{settings,activatedAt}')::timestamptz>now()-interval '1 minute', 'activation cannot be forged';
 assert (select count(*) from public.bid_alert_settings)=1, 'owner sees their settings';
 perform public.bid_alert_user('subscribe',jsonb_build_object('subscription',jsonb_build_object(
   'endpoint','https://fcm.googleapis.com/fcm/send/alerts-test-owner-a','expirationTime',null,
   'keys',jsonb_build_object('p256dh',repeat('A',87),'auth',repeat('A',22)))));
 result:=public.bid_alert_user('get','{}');
 assert result#>>'{settings,pushEnabled}'='true', 'subscribing enables owner push preference';
 settings:=jsonb_set(result->'settings','{pushEnabled}','false');
 perform public.bid_alert_user('save',jsonb_build_object('settings',settings));
 result:=public.bid_alert_user('get','{}');
 assert result#>>'{settings,pushEnabled}'='true', 'stale form cannot disable an enrolled browser push';
 begin
   settings:=jsonb_set(result->'settings','{filter,keywords}','[]');
   perform public.bid_alert_user('save',jsonb_build_object('settings',settings));
   assert false, 'enabled unbounded rule must be rejected through direct RPC';
 exception when invalid_parameter_value then null; end;
 result:=public.bid_alert_user('subscription_status','{"endpoint":"https://fcm.googleapis.com/fcm/send/alerts-test-owner-a"}');
 assert result->>'subscribed'='true', 'owner recognizes their browser';
 result:=public.bid_alert_user('subscription_status','{"endpoint":"https://FCM.GOOGLEAPIS.COM:443/fcm/send/alerts-test-owner-a"}');
 assert result->>'subscribed'='true', 'default-port and host-case aliases retain ownership';
 perform public.bid_alert_user('subscribe',jsonb_build_object('subscription',jsonb_build_object(
   'endpoint','https://test.push.apple.com/test','expirationTime',null,'keys',jsonb_build_object('p256dh',repeat('A',87),'auth',repeat('A',22)))));
 perform public.bid_alert_user('unsubscribe','{"endpoint":"https://test.push.apple.com/test"}');
 result:=public.bid_alert_user('get','{}');
 assert result#>>'{settings,pushEnabled}'='true', 'removing one browser preserves other browser push';
 perform public.bid_alert_user('test','{"endpoint":"https://fcm.googleapis.com/fcm/send/alerts-test-owner-a"}');
 begin
   perform public.bid_alert_user('test','{"endpoint":"https://fcm.googleapis.com/fcm/send/alerts-test-owner-a"}');
   assert false, 'test flood must be rejected';
 exception when program_limit_exceeded then null; end;
 begin
   perform public.bid_alert_user('subscribe','{"subscription":{"endpoint":"https://127.0.0.1/private","expirationTime":null,"keys":{"p256dh":"invalid","auth":"invalid"}}}');
   assert false, 'SSRF endpoint must be rejected';
 exception when invalid_parameter_value then null; end;
 begin
   perform public.bid_alert_admin_setup(repeat('a',64),'https://construction-bid-nine.vercel.app/api/alerts?action=worker');
   assert false, 'ordinary member cannot provision cron';
 exception when insufficient_privilege then null; end;
end $$;

set local request.jwt.claim.sub='22222222-2222-4222-8222-222222222222';
do $$ declare result jsonb; begin
 assert (select count(*) from public.bid_alert_settings)=0, 'another user cannot see settings';
 result:=public.bid_alert_user('get','{}');
 assert result->'notifications'='[]'::jsonb, 'other account inbox empty';
 begin
   perform public.bid_alert_user('subscribe',jsonb_build_object('subscription',jsonb_build_object(
     'endpoint','https://FCM.GOOGLEAPIS.COM:443/fcm/send/alerts-test-owner-a','expirationTime',null,
     'keys',jsonb_build_object('p256dh',repeat('A',87),'auth',repeat('A',22)))));
   assert false, 'endpoint must not transfer to another account';
 exception when unique_violation then null; end;
 result:=public.bid_alert_user('subscription_status','{"endpoint":"https://fcm.googleapis.com/fcm/send/alerts-test-owner-a"}');
 assert result->>'subscribed'='false', 'another account cannot inspect browser ownership';
 begin
   perform public.bid_alert_user('read','{"ids":["11111111-1111-4111-8111-111111111111"]}');
 exception when others then raise exception 'own read action should safely ignore unknown IDs'; end;
end $$;
reset role;

-- A fixed non-secret fixture token bypasses admin_setup to avoid scheduling HTTP.
update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8')),
 lease_id=null,lease_until=null,last_checked_at=null where singleton;
update public.bid_menu_settings set locked=false where menu_key='notices';

do $$ declare claim jsonb; claim2 jsonb; lease text; observed jsonb; payload jsonb; result jsonb; delivery_id text; begin
 begin
   perform public.bid_alert_worker('wrong','claim','{}');
   assert false, 'wrong token rejected';
 exception when insufficient_privilege then null; end;
 claim:=public.bid_alert_worker(repeat('a',64),'claim','{}'); lease:=claim->>'leaseId';
 assert lease is not null, 'DB issues lease';
 claim2:=public.bid_alert_worker(repeat('a',64),'claim','{}');
 assert claim2->>'leaseId' is null, 'concurrent claim cannot enter';
 observed:=jsonb_build_object('key','g2b:공사:R26TEST','version',1,'fingerprint',repeat('b',64),'notice',jsonb_build_object(
   'id','g2b:공사:R26TEST:000','number','R26TEST','revision','000','type','공사','title','철거 시험 공고',
   'postedAt',now()-interval '1 day','sourceUpdatedAt',now(),'regionComplete',true,'licenseComplete',true));
 payload:=jsonb_build_object('leaseId',lease,'observations',jsonb_build_array(observed),
   'events',jsonb_build_array(jsonb_build_object('userId','11111111-1111-4111-8111-111111111111','key','g2b:공사:R26TEST','version',1,'kind','new','message','새 공고','changeFields','[]'::jsonb)),
   'existing','[]'::jsonb);
 perform public.bid_alert_worker(repeat('a',64),'commit',payload);
 perform public.bid_alert_worker(repeat('a',64),'commit',payload);
 assert (select count(*) from public.bid_alert_inbox where notice_key='g2b:공사:R26TEST')=1, 'event retries deduplicate';
 assert (select count(*) from bid_alert_private.memberships where notice_key='g2b:공사:R26TEST')=1, 'ledger persists';
 -- Advancing a seen member without sending changes must not create an initial digest.
 perform public.bid_alert_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'observations','[]'::jsonb,'events','[]'::jsonb,
   'existing',jsonb_build_array(jsonb_build_object('userId','11111111-1111-4111-8111-111111111111','key','g2b:공사:R26TEST','version',1,'initial',false))));
 assert (select count(*) from public.bid_alert_inbox where kind='initial')=0, 'seen ledger update creates no initial digest';
 -- Older observations must not overwrite the current snapshot or create events.
 observed:=jsonb_set(observed,'{notice,revision}','"000"');
 observed:=jsonb_set(observed,'{notice,sourceUpdatedAt}','"2000-01-01T00:00:00Z"');
 observed:=jsonb_set(observed,'{version}','2');
 payload:=jsonb_set(payload,'{observations}',jsonb_build_array(observed));
 payload:=jsonb_set(payload,'{events,0,version}','2');
 perform public.bid_alert_worker(repeat('a',64),'commit',payload);
 assert (select version from bid_alert_private.observations where notice_key='g2b:공사:R26TEST')=1, 'older provider result ignored';
 assert (select count(*) from public.bid_alert_inbox where notice_key='g2b:공사:R26TEST')=1, 'older event ignored';
 -- Revision takes priority over provider timestamps, matching the domain model.
 -- A revision-only change keeps the meaningful version and creates no event.
 observed:=jsonb_set(observed,'{notice,revision}','"001"');
 observed:=jsonb_set(observed,'{notice,id}','"g2b:공사:R26TEST:001"');
 observed:=jsonb_set(observed,'{version}','1');
 perform public.bid_alert_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'observations',jsonb_build_array(observed),'events','[]'::jsonb,'existing','[]'::jsonb));
 assert (select revision=1 and version=1 and source_updated_at='2000-01-01T00:00:00Z'::timestamptz from bid_alert_private.observations where notice_key='g2b:공사:R26TEST'), 'higher revision wins even with older source timestamp';
 assert (select count(*) from public.bid_alert_inbox where notice_key='g2b:공사:R26TEST')=1, 'revision alone creates no duplicate event';
 -- The initial digest remains one row as additional existing matches arrive.
 payload:=jsonb_build_object('leaseId',lease,'observations','[]'::jsonb,'events','[]'::jsonb,
   'existing',jsonb_build_array(jsonb_build_object('userId','11111111-1111-4111-8111-111111111111','key','g2b:공사:R26TEST','version',1)));
 perform public.bid_alert_worker(repeat('a',64),'commit',payload);
 perform public.bid_alert_worker(repeat('a',64),'commit',payload);
 assert (select count(*) from public.bid_alert_inbox where kind='initial')=1, 'one initial digest';
 assert (select count(*) from bid_alert_private.deliveries d join public.bid_alert_inbox i on i.id=d.notification_id where i.kind='initial')=1, 'initial count refresh does not resend push';
 result:=public.bid_alert_worker(repeat('a',64),'deliveries',jsonb_build_object('leaseId',lease,'limit',30));
 assert jsonb_array_length(result->'deliveries')=3, 'test, new and initial events have durable deliveries';
 delivery_id:=result#>>'{deliveries,0,id}';
 perform public.bid_alert_worker(repeat('a',64),'settle',jsonb_build_object('leaseId',lease,'results',jsonb_build_array(jsonb_build_object('id',delivery_id,'status','retry','retryAfterSeconds',600))));
 assert (select attempts=1 and next_attempt_at>clock_timestamp()+interval '9 minutes' from bid_alert_private.deliveries where id=delivery_id::uuid), 'retry honors delay and increments attempts';
 perform public.bid_alert_worker(repeat('a',64),'settle',jsonb_build_object('leaseId',lease,'results',jsonb_build_array(jsonb_build_object('id',delivery_id,'status','expired'))));
 assert (select count(*) from bid_alert_private.subscriptions)=0, 'expired endpoint is removed';
 assert (select count(*) from bid_alert_private.deliveries)=0, 'expired subscription queue is removed';
 perform public.bid_alert_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'finish',true,'checkpoint',jsonb_build_object('cursor','2026-10-15T00:00:00Z')));
 assert (select cursor_value='2026-10-15T00:00:00Z' and last_checked_at is not null from bid_alert_private.runtime), 'successful finish advances checkpoint';
 begin
   perform public.bid_alert_worker(repeat('a',64),'load',jsonb_build_object('leaseId',lease,'keys','[]'::jsonb));
   assert false, 'finished lease rejected';
 exception when insufficient_privilege then null; end;
end $$;

set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
do $$ declare preferences jsonb; notification text; result jsonb; begin
 result:=public.bid_alert_user('get','{}'); preferences:=result->'settings';
 preferences:=jsonb_set(preferences,'{filter,keywords}','["해체"]');
 perform public.bid_alert_user('save',jsonb_build_object('settings',preferences));
 perform public.bid_alert_user('unsubscribe','{"endpoint":"https://fcm.googleapis.com/fcm/send/alerts-test-owner-a"}');
 result:=public.bid_alert_user('get','{}');
 assert result#>>'{settings,pushEnabled}'='false', 'removing the last browser disables owner push';
 select id::text into notification from public.bid_alert_inbox limit 1;
 perform public.bid_alert_user('read',jsonb_build_object('id',notification));
 assert (select read_at is not null from public.bid_alert_inbox where id=notification::uuid), 'single-item read action works';
end $$;
reset role;

-- The application's push-only completion uses commit({finish:true}); it must not
-- move collection checkpoints or require a collecting lease.
do $$ declare sub_id uuid; notice_id uuid; claim jsonb; result jsonb; lease text; previous_cursor text; begin
 insert into bid_alert_private.subscriptions(user_id,endpoint_hash,subscription) values('11111111-1111-4111-8111-111111111111',
   bid_alert_private.endpoint_hash('https://fcm.googleapis.com/fcm/send/dispatch-fixture'),jsonb_build_object('endpoint','https://fcm.googleapis.com/fcm/send/dispatch-fixture','expirationTime',null,
   'keys',jsonb_build_object('p256dh',repeat('A',87),'auth',repeat('A',22)))) returning id into sub_id;
 select id into notice_id from public.bid_alert_inbox where kind='test' limit 1;
 insert into bid_alert_private.deliveries(notification_id,subscription_id) values(notice_id,sub_id);
 select cursor_value into previous_cursor from bid_alert_private.runtime;
 claim:=public.bid_alert_worker(repeat('a',64),'claim','{"dispatchOnly":true}'); lease:=claim->>'leaseId';
 assert lease is not null and claim->>'enabled'='false', 'push-only claims a distinct non-collecting lease';
 result:=public.bid_alert_worker(repeat('a',64),'deliveries',jsonb_build_object('leaseId',lease));
 perform public.bid_alert_worker(repeat('a',64),'settle',jsonb_build_object('leaseId',lease,'results',jsonb_build_array(jsonb_build_object('id',result#>>'{deliveries,0,id}','status','sent'))));
 perform public.bid_alert_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'finish',true,'checkpoint',jsonb_build_object('cursor','DISPATCH_MUST_NOT_ADVANCE')));
 assert (select lease_id is null and cursor_value=previous_cursor from bid_alert_private.runtime), 'push-only finish releases lease without checkpoint advance';
end $$;

do $$ declare claim jsonb; lease text; begin
 claim:=public.bid_alert_worker(repeat('a',64),'claim','{}'); lease:=claim->>'leaseId';
 perform public.bid_alert_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'finish',true,
   'checkpoint',jsonb_build_object('cursor','2026-10-15T00:10:00Z'),'warning','과거 공고 확인은 다음 작업에서 이어집니다.'));
 assert (select cursor_value='2026-10-15T00:10:00Z' and last_checked_at is not null and last_error='과거 공고 확인은 다음 작업에서 이어집니다.' from bid_alert_private.runtime),
   'a historical warning preserves live success and advances its cursor';
end $$;
do $$ begin
 assert (select last_version=1 from bid_alert_private.memberships where notice_key='g2b:공사:R26TEST'), 'filter changes retain dedup ledger';
 assert (select initial=false from bid_alert_private.memberships where notice_key='g2b:공사:R26TEST'), 'filter changes clear only old existing-match visibility';
 assert (select existing_count=0 from public.bid_alert_inbox where kind='initial'), 'initial digest count resets without a duplicate event';
end $$;

set local role authenticated;
set local request.jwt.claim.sub='22222222-2222-4222-8222-222222222222';
do $$ begin
 assert (select count(*) from public.bid_alert_inbox)=0, 'RLS hides other user events';
end $$;
reset role;

-- An incomplete provider window shrinks its retry interval without moving the
-- cursor; a later successful checkpoint can cautiously expand it again.
do $$ declare claim jsonb; lease text; previous_cursor text; begin
 select cursor_value into previous_cursor from bid_alert_private.runtime;
 claim:=public.bid_alert_worker(repeat('a',64),'claim','{}'); lease:=claim->>'leaseId';
 assert claim->>'windowMinutes'='60', 'worker starts with a bounded 60-minute window';
 perform public.bid_alert_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'finish',true,'error','조회 도중 작업 시간이 초과되었습니다.',
   'retryWindowMinutes',30,'checkpoint',jsonb_build_object('cursor','FAILED_WINDOW_MUST_NOT_ADVANCE')));
 assert (select window_minutes=30 and cursor_value=previous_cursor from bid_alert_private.runtime), 'failed window shrinks without checkpoint advancement';
 claim:=public.bid_alert_worker(repeat('a',64),'claim','{}'); lease:=claim->>'leaseId';
 assert claim->>'windowMinutes'='30', 'next claim receives the smaller retry window';
 perform public.bid_alert_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'finish',true,
   'checkpoint',jsonb_build_object('cursor','2026-10-15T00:40:00Z','windowMinutes',60)));
 assert (select window_minutes=60 and cursor_value='2026-10-15T00:40:00Z' and last_error is null from bid_alert_private.runtime), 'successful window restores its bound and advances cursor';
end $$;

-- Simulate capacity through the size helper, without allocating 32 MiB or touching
-- existing project relations. Function replacement rolls back with this test.
update bid_alert_private.runtime set last_checked_at=null where singleton;
do $$ declare claim jsonb; lease text; result jsonb; previous_cursor text; begin
 select cursor_value into previous_cursor from bid_alert_private.runtime;
 claim:=public.bid_alert_worker(repeat('a',64),'claim','{}'); lease:=claim->>'leaseId';
 execute $replace$create or replace function bid_alert_private.storage_bytes() returns bigint language sql stable security invoker set search_path='' as 'select 33554432::bigint'$replace$;
 result:=public.bid_alert_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'observations','[]'::jsonb,'events','[]'::jsonb,'existing','[]'::jsonb));
 assert result->>'storageFull'='true', 'capacity stops new observations';
 perform public.bid_alert_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'finish',true,'checkpoint',jsonb_build_object('cursor','SHOULD_NOT_ADVANCE')));
 assert (select cursor_value=previous_cursor and last_error is not null and last_checked_at is null from bid_alert_private.runtime), 'capacity preserves cursor and reports error';
 result:=public.bid_alert_worker(repeat('a',64),'claim','{}');
 assert result->>'storageFull'='true' and result->>'leaseId' is null, 'full storage prevents another provider scan';
end $$;

set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
do $$ declare previous jsonb; result jsonb; begin
 previous:=public.bid_alert_user('get','{}')->'settings';
 result:=public.bid_alert_user('save','{"settings":{"enabled":false,"filter":{"keywords":["SHOULD_NOT_REPLACE_FILTER"]},"pushEnabled":true}}');
 assert result#>>'{settings,enabled}'='false', 'owner can pause alerts at capacity';
 assert result#>'{settings,filter}'=previous->'filter' and result#>'{settings,pushEnabled}'=previous->'pushEnabled', 'capacity pause preserves stored filter and push preference';
end $$;
set local request.jwt.claim.sub='22222222-2222-4222-8222-222222222222';
do $$ declare result jsonb; begin
 result:=public.bid_alert_user('save','{"settings":{"enabled":false}}');
 assert result#>>'{settings,enabled}'='false' and (select count(*) from public.bid_alert_settings)=0, 'capacity pause never inserts a settings row';
end $$;
reset role;
rollback;
