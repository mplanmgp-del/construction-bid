-- Run in a disposable PostgreSQL after active_notice_catalog.sql regressions
-- and the additive deadline_search_index migration. Fixtures always roll back.
begin;
do $$ begin
 assert not has_table_privilege('anon','bid_active_catalog_private.deadline_index','select'),'public cannot read private index directly';
 assert not has_table_privilege('authenticated','bid_active_catalog_private.deadline_invalidations','select'),'terminal watermarks remain private';
 assert not has_function_privilege('anon','bid_active_catalog_private.worker_legacy(text,text,jsonb)','execute'),'legacy bypass cannot be invoked';
 assert has_function_privilege('anon','public.bid_active_catalog_worker(text,text,jsonb)','execute'),'server token entrypoint remains callable';
 assert (select storage_ceiling=16777216 from bid_active_catalog_private.runtime),'16MiB catalog cap unchanged';
 assert (select storage_ceiling=33554432 from bid_alert_private.runtime),'32MiB total cap unchanged';
end $$;
update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8'));
create function pg_temp.index_notice(p_number text,p_revision text default '000',p_days integer default 3)
returns jsonb language sql as $$
 select jsonb_build_object('id','g2b:공사:'||p_number||':'||p_revision,'type','공사','number',p_number,'revision',p_revision,
 'title','개인조건과 무관한 공공 공사','agency','공개기관','category','기타','province','서울특별시','district','강남구',
 'postedAt','1995-10-02T00:00:00+09:00','sourceUpdatedAt',now()-interval '1 minute',
 'deadline',now()+make_interval(days=>p_days),'openingAt',now()+make_interval(days=>p_days+1),
 'status','접수중','source','live','description','discarded detail','requirements','[]'::jsonb,'documents','[]'::jsonb,
 'licenses','[]'::jsonb,'allowedRegions','[]'::jsonb,'regionComplete',false,'licenseComplete',false);
$$;
do $$ declare c jsonb;lease text;scope text;job_id text;second_id text;result jsonb;failed boolean:=false;before_sources bigint;
 n jsonb:=pg_temp.index_notice('R26SHARED001');changed jsonb;closed jsonb;page_query jsonb;begin
 -- No enabled personal rules are required to build the public index.
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';scope:=c->>'scopeVersion';
 assert lease is not null and jsonb_array_length(c->'rules')=0,'shared index works without an alarm subscriber';
 select x->>'id' into job_id from jsonb_array_elements(c->'sources') x where x->>'type'='공사' and x->>'kind'='history' limit 1;
 select x->>'id' into second_id from jsonb_array_elements(c->'sources') x where x->>'type'='공사' and x->>'id'<>job_id limit 1;
 assert job_id is not null and second_id is not null,'newest history and live scopes claimed';
 result:=public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',lease,'scopeVersion',scope,
   'sourceId',job_id,'page',1,'batch',0,'batches',2,'notices',jsonb_build_array(n),'removed','[]'::jsonb));
 assert result->>'ok'='true','independent public candidate stored before checkpoint';
 assert (select notice->>'description'='' and jsonb_array_length(notice->'documents')=0 from bid_active_catalog_private.deadline_index where number='R26SHARED001'),'raw bodies never persist';
 begin
   perform public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',scope,'sources',jsonb_build_array(jsonb_build_object(
    'id',job_id,'page',1,'totalCount',1,'receivedCount',1,'observed','[]'::jsonb,'items','[]'::jsonb,'complete',true))));
 exception when invalid_parameter_value then failed:=true;end;
 assert failed,'checkpoint cannot skip an unwritten index chunk';
 assert (select completed_at is null from bid_active_catalog_private.sources where id=job_id),'missing chunk leaves source pending';
 perform public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',lease,'scopeVersion',scope,
   'sourceId',job_id,'page',1,'batch',1,'batches',2,'notices','[]'::jsonb,'removed','[]'::jsonb));
 perform public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',scope,'sources',jsonb_build_array(jsonb_build_object(
   'id',job_id,'page',1,'totalCount',1,'receivedCount',1,'observed','[]'::jsonb,'items','[]'::jsonb,'complete',true))));
 assert (select completed_at is not null from bid_active_catalog_private.sources where id=job_id),'durable checkpoint follows all chunks';
 assert not exists(select 1 from bid_active_catalog_private.index_batches where source_id=job_id),'transient chunk receipts discarded after checkpoint';
 page_query:=jsonb_build_object('from',(now() at time zone 'Asia/Seoul')::date-7,'to',(now() at time zone 'Asia/Seoul')::date+7,'type','공사','page',1,'pageSize',10);
 result:=public.bid_active_catalog_worker(repeat('a',64),'deadline_page',page_query);
 assert result->>'totalCount'='1' and result#>>'{indexCoverage,complete}'='false','range search returns public candidates and honest partial coverage';
 result:=public.bid_active_catalog_worker(repeat('a',64),'deadline_page',page_query||'{"keyword":"없는 제목"}'::jsonb);
 assert result->>'totalCount'='0','keyword filtering stays inside the indexed range';
 assert bid_active_catalog_private.ongoing(n||jsonb_build_object('deadline',now()-interval '1 day','openingAt',now()+interval '1 day','status','마감')),'submission closed with future opening remains ongoing';
 assert not bid_active_catalog_private.ongoing(n||jsonb_build_object('openingAt',now()-interval '1 hour')),'past opening excluded';
 assert not bid_active_catalog_private.ongoing(n||'{"openingCompleted":true}'::jsonb),'actual completion excluded even with future dates';
 assert not bid_active_catalog_private.ongoing(n||'{"deadline":""}'::jsonb),'missing deadline cannot match a date range';
 -- Same-clock changed provider content must lose its old exact-history badge.
 update bid_active_catalog_private.deadline_index set verified_at=now() where number='R26SHARED001';
 changed:=n||'{"title":"변경된 공개 공사"}'::jsonb;
 perform public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',lease,'scopeVersion',scope,
   'sourceId',second_id,'page',1,'batch',0,'batches',1,'notices',jsonb_build_array(changed),'removed','[]'::jsonb));
 assert (select verified_at is null from bid_active_catalog_private.deadline_index where number='R26SHARED001'),'body change resets full-history verification';
 result:=public.bid_active_catalog_worker(repeat('a',64),'publish_verified',jsonb_build_object('notices',jsonb_build_array(changed)));
 assert result->>'ok'='true','exact full history can publish without a personal candidate queue';
 result:=public.bid_active_catalog_worker(repeat('a',64),'enrich',jsonb_build_object('notice',changed||'{"openingCompleted":true}'::jsonb));
 assert result->>'ok'='true' and (select latest->>'openingCompleted'='true' from bid_active_catalog_private.groups where number='R26SHARED001'),'exact completion evidence persists';
 assert not exists(select 1 from bid_active_catalog_private.deadline_index where number='R26SHARED001'),'completed candidate leaves general search index';
 assert not bid_active_catalog_private.alarm_active(changed),'old observation cannot override cached actual completion';
 perform public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',lease,'scopeVersion',scope,
   'sourceId',second_id,'page',1,'batch',0,'batches',1,'notices',jsonb_build_array(changed),'removed','[]'::jsonb));
 assert not exists(select 1 from bid_active_catalog_private.deadline_index where number='R26SHARED001'),'same source cannot resurrect completed current head';
 -- An invalidated retained ID gets only a compact watermark, unrelated closed IDs get none.
 n:=pg_temp.index_notice('R26SHARED002');
 perform public.bid_active_catalog_worker(repeat('a',64),'publish_verified',jsonb_build_object('notices',jsonb_build_array(n)));
 closed:=jsonb_build_object('type','공사','number','R26SHARED002','revision','001','sourceUpdatedAt',now());
 perform public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',lease,'scopeVersion',scope,
   'sourceId',second_id,'page',1,'batch',0,'batches',1,'notices','[]'::jsonb,'removed',jsonb_build_array(closed,closed||'{"number":"R26UNSEEN001"}'::jsonb)));
 assert exists(select 1 from bid_active_catalog_private.deadline_invalidations where number='R26SHARED002'),'known terminal head has minimal watermark';
 assert not exists(select 1 from bid_active_catalog_private.deadline_invalidations where number='R26UNSEEN001'),'unrelated closed raw data leaves no retained record';
 assert not bid_active_catalog_private.alarm_active(n),'newer unverified terminal hint suppresses old active match';
 select count(*) into before_sources from bid_active_catalog_private.sources;
 insert into auth.users(id,email) values('77777777-7777-4777-8777-777777777777','deadline@example.invalid');
 insert into public.bid_alert_settings(user_id,settings) values('77777777-7777-4777-8777-777777777777',jsonb_set(bid_alert_private.defaults(),'{enabled}','true'));
 assert bid_active_catalog_private.scope_version()=scope,'changing member conditions never changes public source scope';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease));
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';
 assert (select count(*)=before_sources from bid_active_catalog_private.sources),'filter save does not replay years';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease));
end $$;

do $$ declare n0 jsonb:=pg_temp.index_notice('R26MOVED001');n1 jsonb:=pg_temp.index_notice('R26MOVED001','001',30);
 p0 jsonb:=pg_temp.index_notice('R26HISTORY01');p1 jsonb:=pg_temp.index_notice('R26HISTORY01','001');result jsonb;claim jsonb;sub_id uuid;notice_id uuid;begin
 perform public.bid_active_catalog_worker(repeat('a',64),'publish_verified',jsonb_build_object('notices',jsonb_build_array(n0)));
 insert into bid_active_catalog_private.deadline_index(type,number,revision,notice,source_updated_at,deadline,opening_at)
 values('공사','R26MOVED001',1,n1,(n1->>'sourceUpdatedAt')::timestamptz,(n1->>'deadline')::timestamptz,(n1->>'openingAt')::timestamptz)
 on conflict(type,number) do update set revision=1,notice=excluded.notice,deadline=excluded.deadline,opening_at=excluded.opening_at;
 result:=public.bid_active_catalog_worker(repeat('a',64),'alarm_page','{"limit":100,"includeInactive":true}');
 assert not exists(select 1 from jsonb_array_elements(result->'groups') g where g->>'number'='R26MOVED001'),'head moved outside seven days suppresses old inside-window original';
 perform public.bid_active_catalog_worker(repeat('a',64),'publish_verified',jsonb_build_object('notices',jsonb_build_array(p0,p1)));
 result:=public.bid_active_catalog_worker(repeat('a',64),'alarm_page','{"limit":100,"includeInactive":true}');
 assert (select jsonb_array_length(g->'versions')=2 from jsonb_array_elements(result->'groups') g where g->>'number'='R26HISTORY01'),'equal index head never truncates verified full history';
 assert not bid_active_catalog_private.delivery_eligible('77777777-7777-4777-8777-777777777777','g2b:공사:R26MOVED001','new',n0),'queued push checks new head rather than old inbox snapshot';
 insert into bid_alert_private.observations(notice_key,notice,fingerprint,version,revision,source_updated_at)
 values('g2b:공사:R26HISTORY01',p1,repeat('a',64),1,1,(p1->>'sourceUpdatedAt')::timestamptz);
 insert into bid_alert_private.memberships(user_id,notice_key,last_version,initial)
 values('77777777-7777-4777-8777-777777777777','g2b:공사:R26HISTORY01',1,true);
 assert bid_active_catalog_private.delivery_eligible('77777777-7777-4777-8777-777777777777','@initial','initial',null),'matching owner can receive its initial digest';
 assert not bid_active_catalog_private.delivery_eligible('88888888-8888-4888-8888-888888888888','@initial','initial',null),'another member cannot enable this member initial push';
 assert position('bid_active_catalog_private.delivery_eligible(i.user_id' in pg_get_functiondef('public.bid_alert_worker(text,text,jsonb)'::regprocedure))>0,'queued deliveries use the owner-specific current-head predicate';
 insert into bid_alert_private.subscriptions(user_id,endpoint_hash,subscription)
 values('77777777-7777-4777-8777-777777777777',sha256('offline-endpoint'::bytea),'{}') returning id into sub_id;
 insert into public.bid_alert_inbox(user_id,notice_key,version,kind,notice,message)
 values('77777777-7777-4777-8777-777777777777','g2b:공사:R26MOVED001',1,'new',n0,'offline fixture') returning id into notice_id;
 insert into bid_alert_private.deliveries(notification_id,subscription_id) values(notice_id,sub_id);
 claim:=public.bid_alert_worker(repeat('a',64),'claim','{}');
 result:=public.bid_alert_worker(repeat('a',64),'deliveries',jsonb_build_object('leaseId',claim->>'leaseId'));
 assert jsonb_array_length(result->'deliveries')=0,'ineligible queued push is never dispatched';
 assert (select status='failed' from bid_alert_private.deliveries where notification_id=notice_id),'ineligible delivery is settled rather than left pending forever';
 perform public.bid_alert_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',claim->>'leaseId'));
end $$;
do $$ declare claim jsonb;job jsonb;result jsonb;before_page integer;before_batches integer;begin
 claim:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 job:=claim->'sources'->0;
 select page into before_page from bid_active_catalog_private.sources where id=job->>'id';
 select count(*) into before_batches from bid_active_catalog_private.index_batches where source_id=job->>'id';
 execute $replace$create or replace function bid_active_catalog_private.storage_bytes() returns bigint language sql stable security invoker set search_path='' as 'select 16777216::bigint'$replace$;
 result:=public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',claim->>'leaseId','scopeVersion',claim->>'scopeVersion',
   'sourceId',job->>'id','page',before_page,'batch',0,'batches',1,'notices','[]'::jsonb,'removed','[]'::jsonb));
 assert result->>'storageFull'='true','physical capacity blocks a chunk before its receipt';
 assert (select page=before_page and completed_at is null from bid_active_catalog_private.sources where id=job->>'id'),'capacity preserves source continuation';
 assert (select count(*)=before_batches from bid_active_catalog_private.index_batches where source_id=job->>'id'),'capacity creates no false written-batch receipt';
end $$;
rollback;
