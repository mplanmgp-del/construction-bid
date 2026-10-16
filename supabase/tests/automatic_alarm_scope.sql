-- Disposable regression: automatic matching has no implicit deadline-day cap.
begin;
update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8'));
update public.bid_menu_settings set locked=false where menu_key='notices';
create function pg_temp.wide_alarm_notice(p_number text,p_days integer default 30,p_revision text default '000')
returns jsonb language sql as $$
 select jsonb_build_object('id','g2b:공사:'||p_number||':'||p_revision,'type','공사','number',p_number,'revision',p_revision,
 'title','철거 시험 공사','agency','공공기관','category','철거·해체','province','서울특별시','district','강남구',
 'postedAt',now()-interval '1 minute','sourceUpdatedAt',now()-interval '1 minute','biddingStartAt',now()-interval '1 hour',
 'deadline',now()+make_interval(days=>p_days),'openingAt',now()+make_interval(days=>greatest(2,p_days+1)),
 'status','접수중','source','live','allowedRegions',jsonb_build_array('서울특별시'),'licenses',jsonb_build_array('구조물해체·비계공사업'),
 'regionComplete',true,'licenseComplete',true,'estimatedPrice',100000000,'contractMethod','제한경쟁');
$$;
create function pg_temp.seed_wide_alarm(n jsonb)
returns void language sql as $$
 insert into bid_active_catalog_private.deadline_index(type,number,revision,notice,source_updated_at,deadline,opening_at,verified_at,source_version,verified_version)
 values(n->>'type',n->>'number',(n->>'revision')::integer,bid_active_catalog_private.compact(n),(n->>'sourceUpdatedAt')::timestamptz,
 (n->>'deadline')::timestamptz,(n->>'openingAt')::timestamptz,now(),
 bid_active_catalog_private.source_version(bid_active_catalog_private.compact(n)),bid_active_catalog_private.source_version(bid_active_catalog_private.compact(n)))
 on conflict(type,number) do update set revision=excluded.revision,notice=excluded.notice,source_updated_at=excluded.source_updated_at,
 deadline=excluded.deadline,opening_at=excluded.opening_at,verified_at=excluded.verified_at,source_version=excluded.source_version,verified_version=excluded.verified_version;
$$;
do $$declare n jsonb;r jsonb;begin
 n:=pg_temp.wide_alarm_notice('R26WIDE030',30);
 assert bid_active_catalog_private.alarm_active(n),'future deadline beyond seven days remains alarm eligible';
 assert bid_active_catalog_private.alarm_active(pg_temp.wide_alarm_notice('R26WIDE366',366)),'no replacement month/year cutoff';
 assert bid_active_catalog_private.alarm_active(pg_temp.wide_alarm_notice('R26WIDEPAST',-30)),'past deadline awaiting future opening has no seven-day cutoff';
 assert not bid_active_catalog_private.alarm_active(n||'{"status":"취소"}'),'cancellation stays excluded';
 assert not bid_active_catalog_private.alarm_active(n||'{"openingCompleted":true}'),'actual opening completion stays excluded';
 assert not bid_active_catalog_private.alarm_active(n||jsonb_build_object('openingAt',now()-interval '1 hour')),'past opening stays excluded';
 assert not bid_active_catalog_private.alarm_active(n||'{"deadline":""}'),'missing deadline stays excluded';
 perform pg_temp.seed_wide_alarm(n);
 perform pg_temp.seed_wide_alarm(pg_temp.wide_alarm_notice('R26WIDE366',366));
 perform pg_temp.seed_wide_alarm(pg_temp.wide_alarm_notice('R26WIDEPAST',-30));
 r:=public.bid_active_catalog_worker(repeat('a',64),'alarm_page','{"limit":100}');
 assert jsonb_array_length(r->'groups')=3,'alarm page enumerates all ongoing deadline ranges';
 r:=public.bid_active_catalog_worker(repeat('a',64),'alarm_page','{"limit":1}');
 assert jsonb_array_length(r->'groups')=1 and r->>'nextCursor' is not null,'wide matching keeps bounded pagination';
 r:=public.bid_active_catalog_worker(repeat('a',64),'alarm_page',jsonb_build_object('limit',100,'changedThrough',now()-interval '1 hour'));
 assert r->'groups'='[]'::jsonb,'publication watermark still gates delta scans';
 -- The latest out-of-window revision wins; no old inside-window original is revived.
 n:=pg_temp.wide_alarm_notice('R26WIDEMOVE',3);
 perform public.bid_active_catalog_worker(repeat('a',64),'publish_verified',jsonb_build_object('notices',jsonb_build_array(n)));
 perform pg_temp.seed_wide_alarm(pg_temp.wide_alarm_notice('R26WIDEMOVE',90,'001'));
 r:=public.bid_active_catalog_worker(repeat('a',64),'alarm_page','{"limit":100}');
 assert (select g#>>'{latest,revision}'='001' from jsonb_array_elements(r->'groups')g where g->>'number'='R26WIDEMOVE'),'latest future revision wins across old range boundary';
 insert into bid_active_catalog_private.deadline_invalidations(type,number,revision,source_updated_at)
 values('공사','R26WIDEMOVE',2,now());
 assert not bid_active_catalog_private.alarm_active(n),'newer invalidation overrides both active cached revisions';
 r:=public.bid_active_catalog_worker(repeat('a',64),'alarm_page','{"limit":100,"includeInactive":true}');
 assert not exists(select 1 from jsonb_array_elements(r->'groups')g where g->>'number'='R26WIDEMOVE'),'inactive scan does not revive an invalidated active head';
 assert (select storage_ceiling=25165824 from bid_active_catalog_private.runtime),'24MiB catalog allocation unchanged';
 assert (select storage_ceiling=33554432 from bid_alert_private.runtime),'combined 32MiB budget unchanged';
end $$;

-- Database events, initial digest and browser queue stay durable and idempotent.
insert into auth.users(id,email) values('96969696-9696-4696-8696-969696969696','wide-alarm@example.invalid');
insert into public.bid_alert_settings(user_id,settings)
values('96969696-9696-4696-8696-969696969696',bid_alert_private.defaults()||jsonb_build_object('enabled',true,'pushEnabled',true,'notifyChanges',true,'activatedAt',now()-interval '5 minutes'));
insert into bid_alert_private.subscriptions(user_id,endpoint_hash,subscription)
values('96969696-9696-4696-8696-969696969696',sha256('wide-alarm-offline-fixture'::bytea),'{}');
do $$declare c jsonb;l text;n jsonb;old jsonb;payload jsonb;events jsonb;r jsonb;d jsonb;activation jsonb;begin
 c:=public.bid_alert_worker(repeat('a',64),'claim','{}');l:=c->>'leaseId';assert l is not null;
 select settings->'activatedAt' into activation from public.bid_alert_settings where user_id='96969696-9696-4696-8696-969696969696';
 n:=pg_temp.wide_alarm_notice('R26WIDEEVENT',60);
 payload:=jsonb_build_object('leaseId',l,'observations',jsonb_build_array(jsonb_build_object('key','g2b:공사:R26WIDEEVENT','version',1,'fingerprint',repeat('b',64),'notice',n)),
 'events',jsonb_build_array(jsonb_build_object('userId','96969696-9696-4696-8696-969696969696','key','g2b:공사:R26WIDEEVENT','version',1,'kind','new','message','새 관심 공고','changeFields','[]'::jsonb)));
 perform public.bid_alert_worker(repeat('a',64),'commit',payload);
 perform public.bid_alert_worker(repeat('a',64),'commit',payload);
 n:=n||jsonb_build_object('estimatedPrice',200000000,'sourceUpdatedAt',now());
 payload:=jsonb_set(jsonb_set(payload,'{observations}',jsonb_build_array(jsonb_build_object('key','g2b:공사:R26WIDEEVENT','version',2,'fingerprint',repeat('c',64),'notice',n))),'{events}',
 jsonb_build_array(jsonb_build_object('userId','96969696-9696-4696-8696-969696969696','key','g2b:공사:R26WIDEEVENT','version',2,'kind','changed','message','추정가격 변경','changeFields',jsonb_build_array('추정가격'))));
 perform public.bid_alert_worker(repeat('a',64),'commit',payload);
 perform public.bid_alert_worker(repeat('a',64),'commit',payload);
 -- A higher official revision is a change even when its content fingerprint is unchanged.
 n:=n||'{"id":"g2b:공사:R26WIDEEVENT:001","revision":"001"}'::jsonb;
 payload:=jsonb_set(jsonb_set(payload,'{observations}',jsonb_build_array(jsonb_build_object('key','g2b:공사:R26WIDEEVENT','version',3,'fingerprint',repeat('c',64),'notice',n))),'{events}',
 jsonb_build_array(jsonb_build_object('userId','96969696-9696-4696-8696-969696969696','key','g2b:공사:R26WIDEEVENT','version',3,'kind','changed','message','공고 차수 변경','changeFields',jsonb_build_array('공고 차수'))));
 perform public.bid_alert_worker(repeat('a',64),'commit',payload);
 perform public.bid_alert_worker(repeat('a',64),'commit',payload);
 assert (select count(*)=3 and count(*)filter(where kind='new')=1 and count(*)filter(where kind='changed')=2 from public.bid_alert_inbox where notice_key='g2b:공사:R26WIDEEVENT'),'new/change/revision repeats each create one durable inbox event';
 assert (select count(*)=3 from bid_alert_private.deliveries d join public.bid_alert_inbox i on i.id=d.notification_id where i.notice_key='g2b:공사:R26WIDEEVENT'),'one durable browser delivery per event';
 assert bid_active_catalog_private.delivery_eligible('96969696-9696-4696-8696-969696969696','g2b:공사:R26WIDEEVENT','new',n),'far-future new delivery eligible';
 assert bid_active_catalog_private.delivery_eligible('96969696-9696-4696-8696-969696969696','g2b:공사:R26WIDEEVENT','changed',n),'far-future changed delivery eligible';
 -- Existing pre-activation matches stay one initial digest rather than replayed new alerts.
 old:=pg_temp.wide_alarm_notice('R26WIDEBASE',120)||jsonb_build_object('postedAt',now()-interval '2 days','sourceUpdatedAt',now()-interval '2 days');
 payload:=jsonb_build_object('leaseId',l,'observations',jsonb_build_array(jsonb_build_object('key','g2b:공사:R26WIDEBASE','version',1,'fingerprint',repeat('d',64),'notice',old)),
 'existing',jsonb_build_array(jsonb_build_object('userId','96969696-9696-4696-8696-969696969696','key','g2b:공사:R26WIDEBASE','version',1)));
 perform public.bid_alert_worker(repeat('a',64),'commit',payload);
 perform public.bid_alert_worker(repeat('a',64),'commit',payload);
 assert (select count(*)=1 from public.bid_alert_inbox where user_id='96969696-9696-4696-8696-969696969696' and kind='initial'),'one baseline digest preserved';
 assert not exists(select 1 from public.bid_alert_inbox where notice_key='g2b:공사:R26WIDEBASE'),'pre-activation record is not a new event';
 assert bid_active_catalog_private.delivery_eligible('96969696-9696-4696-8696-969696969696','@initial','initial',null),'far-future owner baseline remains deliverable';
 assert not bid_active_catalog_private.delivery_eligible('98989898-9898-4898-8898-989898989898','@initial','initial',null),'baseline delivery remains owner-specific';
 r:=public.bid_alert_worker(repeat('a',64),'deliveries',jsonb_build_object('leaseId',l,'limit',30));
 assert jsonb_array_length(r->'deliveries')=4,'new, changed, revision and initial deliveries are selected beyond seven days';
 for d in select value from jsonb_array_elements(r->'deliveries')loop
 perform public.bid_alert_worker(repeat('a',64),'settle',jsonb_build_object('leaseId',l,'results',jsonb_build_array(jsonb_build_object('id',d->>'id','status','sent'))));end loop;
 r:=public.bid_alert_worker(repeat('a',64),'deliveries',jsonb_build_object('leaseId',l,'limit',30));
 assert r->'deliveries'='[]'::jsonb,'sent events are not selected on the unchanged next pass';
 assert (select settings->'activatedAt'=activation and settings->>'notifyChanges'='true' and settings->>'pushEnabled'='true' from public.bid_alert_settings where user_id='96969696-9696-4696-8696-969696969696'),'activation and all preferences preserved';
 r:=public.bid_alert_worker(repeat('a',64),'load',jsonb_build_object('leaseId',l,'keys',jsonb_build_array('g2b:공사:R26WIDEEVENT','g2b:공사:R26WIDEBASE')));
 assert (select bool_and((x->>'observedAt')::timestamptz=o.updated_at) and count(*)=2
   from jsonb_array_elements(r->'observations')x join bid_alert_private.observations o on o.notice_key=x->>'key'),
   'protected observation load exposes the successful observation time for same-clock changes';
end $$;
rollback;
