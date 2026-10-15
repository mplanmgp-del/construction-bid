-- Disposable PostgreSQL regression: filtered current coverage is never history.
begin;
update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8'));
update bid_active_catalog_private.runtime set scope_version=bid_active_catalog_private.scope_version(),lease_id=null,lease_until=null,retry_after_at=null,storage_blocked=false,last_error=null;
delete from bid_active_catalog_private.verification;
delete from bid_active_catalog_private.deadline_index;
delete from bid_active_catalog_private.groups;
delete from bid_active_catalog_private.sources;
delete from bid_active_catalog_private.live_cursors;

create function pg_temp.sweep_notice(p_number text) returns jsonb language sql as $$
 select jsonb_build_object('id','g2b:공사:'||p_number||':000','type','공사','number',p_number,'revision','000',
 'title','오래된 철거공사','agency','공공기관','category','철거·해체','province','서울특별시','district','강남구',
 'postedAt','1995-10-01T09:00:00+09:00','sourceUpdatedAt',now()-interval '1 minute',
 'biddingStartAt',now()-interval '1 day','deadline',now()+interval '1 day','openingAt',null,
 'status','접수중','source','live','licenses','[]'::jsonb,'allowedRegions','["전국"]'::jsonb,
 'regionComplete',false,'licenseComplete',false,'contractMethod','일반경쟁','estimatedPrice',100000000);
$$;

do $$declare c jsonb;again jsonb;before_sources bigint;failed boolean:=false;cutoff timestamptz;cur jsonb;r jsonb;n jsonb;begin
 assert not has_function_privilege('anon','bid_active_catalog_private.current_coverage()','execute'),'current coverage helper stays private';
 assert not has_schema_privilege('authenticated','bid_active_catalog_private','usage'),'current sources keep private schema';
 select count(*) into before_sources from bid_active_catalog_private.sources;
 begin perform public.bid_active_catalog_worker('wrong','claim','{}');exception when insufficient_privilege then failed:=true;end;
 assert failed and (select count(*)=before_sources from bid_active_catalog_private.sources),'wrong token cannot seed or claim current sources';
 n:=pg_temp.sweep_notice('R26PREVIOUSLYVERIFIED')||'{"regionComplete":true,"licenseComplete":true}'::jsonb;
 insert into bid_active_catalog_private.deadline_index(type,number,revision,notice,source_updated_at,deadline,opening_at,verified_at,source_version,verified_version)
 values('공사',n->>'number',0,n,(n->>'sourceUpdatedAt')::timestamptz,(n->>'deadline')::timestamptz,null,now(),bid_active_catalog_private.source_version(n),bid_active_catalog_private.source_version(n));
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 assert c->>'leaseId' is not null,'existing token-authorized claim acquires shared lease';
 cutoff:=(c#>>'{status,currentCoverage,cutoff}')::timestamptz;
 assert cutoff is not null and cutoff<=clock_timestamp(),'current sweep has explicit fixed cutoff';
 assert exists(select 1 from bid_active_catalog_private.verification where number='R26PREVIOUSLYVERIFIED'),'current sweep rechecks an old verified focus head even if filtered provider lists omit its cancellation';
 assert (select count(*)=2*((extract(year from cutoff at time zone 'Asia/Seoul')::int-1995)*12+extract(month from cutoff at time zone 'Asia/Seoul')::int-10+1) from bid_active_catalog_private.sources where kind='current'),'every supported posting month has its own current-only source';
 assert (select min(from_at)='1995-10-01T00:00:00+09:00' from bid_active_catalog_private.sources where kind='current'),'old posting age is not a current-notice cutoff';
 assert (select bool_and(to_at<=cutoff) from bid_active_catalog_private.sources where kind='current'),'all current source endpoints stop at the fixed cutoff';
 assert (select count(*)=8 from jsonb_array_elements(c->'sources') s where s->>'kind'='current'),'at most eight current sources progress per invocation';
 assert not exists(select 1 from jsonb_array_elements(c->'sources') s where s->>'kind'='history'),'unfiltered history does not consume current sweep work';
 assert (select count(*)=4 from jsonb_array_elements(c->'sources') s where s->>'kind' in ('registered','modified')),'all four independent live streams remain claimed';
 assert (c#>>'{status,pendingSources}')::integer=(select count(*) from bid_active_catalog_private.sources where kind<>'current' and completed_at is null),'historical status counts do not include new filtered source coverage';
 assert c#>>'{status,currentCoverage,complete}'='false','no completion claim while months remain';
 again:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 assert again->>'leaseId' is null and jsonb_array_length(again->'sources')=0,'concurrent caller cannot steal current source leases';
 select value into cur from jsonb_array_elements(c->'sources') s where s->>'kind'='current' limit 1;
 -- Empty filtered page still goes through the existing durable index fence.
 r:=public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',c->>'leaseId','scopeVersion',c->>'scopeVersion',
 'sourceId',cur->>'id','page',1,'batch',0,'batches',1,'notices','[]'::jsonb,'removed','[]'::jsonb));
 assert r->>'ok'='true','current source uses existing index batch lease guard';
 r:=public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',c->>'leaseId','scopeVersion',c->>'scopeVersion',
 'sources',jsonb_build_array(jsonb_build_object('id',cur->>'id','page',1,'totalCount',0,'receivedCount',0,'items','[]'::jsonb,'observed','[]'::jsonb,'rawIdentities','[]'::jsonb,'complete',true))));
 assert r->>'ok'='true','filtered source page can be acknowledged independently';
 assert (select completed_at is not null from bid_active_catalog_private.sources where id=cur->>'id'),'only current source finishes';
 assert not exists(select 1 from bid_active_catalog_private.sources where kind='history' and completed_at is not null),'filtered empty page never completes an unfiltered history window';
 assert bid_active_catalog_private.index_coverage()->>'checked'='0','old historical coverage remains unchanged';
 assert bid_active_catalog_private.current_coverage()->>'checked'='1','current coverage reports its own completion';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',c->>'leaseId'));
 -- Backoff is not reset to force an apparent sweep completion.
 update bid_active_catalog_private.sources set next_attempt=now()+interval '1 hour',failures=4,last_error='provider retry later'
 where kind='current' and completed_at is null;
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 assert c#>>'{status,currentCoverage,cutoff}'=to_jsonb(cutoff)#>>'{}','next invocation retains the original cutoff';
 assert not exists(select 1 from jsonb_array_elements(c->'sources') s where s->>'kind' in ('current','history')),'current backoff does not permit history to jump ahead';
 assert (select bool_and(failures=4 and next_attempt>now()) from bid_active_catalog_private.sources where kind='current' and completed_at is null),'claim preserves every current source retry delay';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',c->>'leaseId'));
 delete from bid_active_catalog_private.verification where number='R26PREVIOUSLYVERIFIED';
 delete from bid_active_catalog_private.deadline_index where number='R26PREVIOUSLYVERIFIED';
end $$;

do $$declare c jsonb;r jsonb;raw_ids jsonb;failed boolean:=false;begin
 update bid_active_catalog_private.runtime set retry_after_at=null,last_error=null;
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{"currentLimit":32}');
 -- Backoff remains in force even for the token-controlled accelerated batch.
 assert not exists(select 1 from jsonb_array_elements(c->'sources') s where s->>'kind'='current'),'accelerated server batch never skips backoff';
 insert into bid_active_catalog_private.sources(id,type,kind,from_at,to_at,scope_version,claimed_lease)
 values('fixture-current-raw','공사','current','1995-10-01T00:00:00+09:00','1995-10-31T23:59:00+09:00',c->>'scopeVersion',(c->>'leaseId')::uuid);
 select jsonb_agg('R26NONFOCUS'||lpad(i::text,4,'0')||':000' order by i) into raw_ids from generate_series(1,999) i;
 perform public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',c->>'leaseId','scopeVersion',c->>'scopeVersion','sourceId','fixture-current-raw','page',1,'batch',0,'batches',1,'notices','[]'::jsonb,'removed','[]'::jsonb));
 begin
   perform public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',c->>'leaseId','scopeVersion',c->>'scopeVersion','sources',jsonb_build_array(jsonb_build_object('id','fixture-current-raw','page',1,'totalCount',1000,'receivedCount',999,'items','[]'::jsonb,'observed','[]'::jsonb,'complete',false))));
 exception when raise_exception then failed:=sqlerrm='Incomplete current raw source identities';end;
 assert failed,'missing all-raw identities cannot acknowledge a filtered current page';
 r:=public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',c->>'leaseId','scopeVersion',c->>'scopeVersion','sources',jsonb_build_array(jsonb_build_object('id','fixture-current-raw','page',1,'totalCount',1000,'receivedCount',999,'items','[]'::jsonb,'observed','[]'::jsonb,'rawIdentities',raw_ids,'complete',false))));
 assert r->>'ok'='true' and (select page=2 from bid_active_catalog_private.sources where id='fixture-current-raw'),'all-raw first page advances independently of focused index count';
 assert (select count(*)=999 from bid_active_catalog_private.source_seen where source_id='fixture-current-raw'),'even nonfocus raw identities fence later pages';
 -- Simulate the next bounded claim without touching any other source.
 update bid_active_catalog_private.sources set claimed_lease=(c->>'leaseId')::uuid where id='fixture-current-raw';
 perform public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',c->>'leaseId','scopeVersion',c->>'scopeVersion','sourceId','fixture-current-raw','page',2,'batch',0,'batches',1,'notices','[]'::jsonb,'removed','[]'::jsonb));
 r:=public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',c->>'leaseId','scopeVersion',c->>'scopeVersion','sources',jsonb_build_array(jsonb_build_object('id','fixture-current-raw','page',2,'totalCount',1000,'receivedCount',1,'items','[]'::jsonb,'observed','[]'::jsonb,'rawIdentities',jsonb_build_array('R26NONFOCUS0001:000'),'complete',true))));
 assert r->>'restartRequired'='true','a cross-page nonfocus duplicate forces a restart instead of false completion';
 assert (select page=1 and completed_at is null and failures=1 from bid_active_catalog_private.sources where id='fixture-current-raw'),'duplicate current page never advances its completion checkpoint';
 assert not exists(select 1 from bid_active_catalog_private.source_seen where source_id='fixture-current-raw'),'restart clears transient raw identities';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',c->>'leaseId'));
 update bid_active_catalog_private.sources set next_attempt=now(),completed_at=null where kind='current';
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{"currentLimit":32}');
 assert (select count(*)=32 from jsonb_array_elements(c->'sources') s where s->>'kind'='current'),'token-controlled source batch can claim thirty-two while retaining the worker provider budget';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',c->>'leaseId'));
 failed:=false;
 begin perform public.bid_active_catalog_worker(repeat('a',64),'claim','{"currentLimit":33}');exception when invalid_parameter_value then failed:=true;end;
 assert failed,'server source claim limit is bounded to thirty-two';
 assert (select lease_id is null from bid_active_catalog_private.runtime),'invalid accelerated limit rolls back the inherited claim';
end $$;

do $$declare c jsonb;r jsonb;n jsonb:=pg_temp.sweep_notice('R26OLDNOOPEN');failed boolean:=false;before_page integer;begin
 update bid_active_catalog_private.sources set completed_at=now(),claimed_lease=null where kind='current';
 update bid_active_catalog_private.live_cursors set cursor_at=now();
 update bid_active_catalog_private.runtime set last_error=null;
 assert bid_active_catalog_private.current_coverage()->>'complete'='true','completed current months plus caught-up live cursors can finish independently of history';
 assert bid_active_catalog_private.current_focus('{"title":"시설물 해체 및 석면 철거"}'),'all four focus terms are title alternatives';
 assert bid_active_catalog_private.current_focus('{"title":"건설폐기물 처리용역"}'),'construction waste title is in the current focus';
 assert not bid_active_catalog_private.current_focus('{"title":"도로 신설 전기공사","category":"철거·해체"}'),'focus coverage is explicitly a title scope, not all business categories';
 assert bid_active_catalog_private.index_coverage()->>'complete'='false','current completion never claims full past archive completion';
 insert into bid_active_catalog_private.deadline_index(type,number,revision,notice,source_updated_at,deadline,opening_at)
 values('공사',n->>'number',0,n,(n->>'sourceUpdatedAt')::timestamptz,(n->>'deadline')::timestamptz,null);
 assert bid_active_catalog_private.ongoing(n),'1995-posted future-deadline notice without opening date remains eligible';
 assert bid_active_catalog_private.current_coverage()->>'verificationPending'='1','unverified actionable candidate blocks current completion without needing an opening date';
 assert bid_active_catalog_private.current_coverage()->>'complete'='false','source coverage alone never substitutes for full latest-revision verification';
 insert into bid_active_catalog_private.verification(type,number,revision,source_updated_at,scope_version)
 values('용역','R26UNCLASSIFIED',0,now(),bid_active_catalog_private.scope_version());
 assert bid_active_catalog_private.current_coverage()->>'globalUnknownPending'='1','unclassified global queue is labelled separately from focused verification coverage';
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 assert exists(select 1 from jsonb_array_elements(c->'verify') v where v->>'number'=n->>'number'),'old actionable candidate receives an ordinary verification claim';
 assert not exists(select 1 from jsonb_array_elements(c->'sources') s where s->>'kind'='history'),'pending actionable verification blocks historical source claims';
 -- New current job still cannot bypass scope or runtime lease checks.
 insert into bid_active_catalog_private.sources(id,type,kind,from_at,to_at,scope_version,claimed_lease)
 values('fixture-current-guard','공사','current','1995-10-01T00:00:00+09:00','1995-10-31T23:59:00+09:00',c->>'scopeVersion',(c->>'leaseId')::uuid);
 begin perform public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',c->>'leaseId','scopeVersion','wrong','sourceId','fixture-current-guard','page',1,'batch',0,'batches',1,'notices',jsonb_build_array(n),'removed','[]'::jsonb));exception when insufficient_privilege then failed:=true;end;
 assert failed,'current source cannot bypass scope guard';
 failed:=false;
 begin perform public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',gen_random_uuid(),'scopeVersion',c->>'scopeVersion','sourceId','fixture-current-guard','page',1,'batch',0,'batches',1,'notices',jsonb_build_array(n),'removed','[]'::jsonb));exception when insufficient_privilege then failed:=true;end;
 assert failed,'current source cannot bypass runtime lease';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',c->>'leaseId','retryAfterSeconds',3600));
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 assert c->>'leaseId' is null and jsonb_array_length(c->'sources')=0,'existing invocation-global provider cooldown prevents current claims too';
 assert (select storage_ceiling=16777216 from bid_active_catalog_private.runtime),'16MiB catalog cap is unchanged';
 assert (select storage_ceiling=33554432 from bid_alert_private.runtime),'32MiB total cap is unchanged';
end $$;
do $$declare c jsonb;n jsonb:=pg_temp.sweep_notice('R26CHANGEDAWAY');r jsonb;retry_at timestamptz:=now()+interval '1 hour';begin
 update bid_active_catalog_private.runtime set retry_after_at=null,last_error=null,storage_blocked=false;
 insert into bid_active_catalog_private.deadline_index(type,number,revision,notice,source_updated_at,deadline,opening_at,verified_at,source_version,verified_version)
 values('공사',n->>'number',0,n,(n->>'sourceUpdatedAt')::timestamptz,(n->>'deadline')::timestamptz,null,null,bid_active_catalog_private.source_version(n),null);
 insert into bid_active_catalog_private.verification(type,number,revision,source_updated_at,scope_version,source_version,next_attempt,failures,last_error)
 values('공사',n->>'number',0,(n->>'sourceUpdatedAt')::timestamptz,bid_active_catalog_private.scope_version(),bid_active_catalog_private.source_version(n),retry_at,3,'keep backoff');
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 insert into bid_active_catalog_private.sources(id,type,kind,from_at,to_at,scope_version,claimed_lease)
 values('fixture-current-away','공사','current','1995-10-01T00:00:00+09:00','1995-10-31T23:59:00+09:00',c->>'scopeVersion',(c->>'leaseId')::uuid);
 perform public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',c->>'leaseId','scopeVersion',c->>'scopeVersion','sourceId','fixture-current-away','page',1,'batch',0,'batches',1,'notices','[]'::jsonb,'removed','[]'::jsonb));
 r:=public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',c->>'leaseId','scopeVersion',c->>'scopeVersion','sources',jsonb_build_array(jsonb_build_object('id','fixture-current-away','page',1,'totalCount',1,'receivedCount',1,
 'items','[]'::jsonb,'observed',jsonb_build_array(jsonb_build_object('type','공사','number',n->>'number','revision','001','sourceUpdatedAt',now())),
 'rawIdentities',jsonb_build_array('R26CHANGEDAWAY:001'),'complete',true))));
 assert r->>'ok'='true','nonfocus raw observation can be acknowledged without storing a new unrelated title';
 assert (select revision=1 and source_updated_at=now() from bid_active_catalog_private.verification where number=n->>'number'),'changed-away public focus head queues its newer complete revision history';
 assert (select next_attempt=retry_at and failures=3 and last_error='keep backoff' from bid_active_catalog_private.verification where number=n->>'number'),'current source observations preserve existing failed-check backoff';
 assert not exists(select 1 from bid_active_catalog_private.source_seen where source_id='fixture-current-away'),'completed current source clears its transient all-raw identities';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',c->>'leaseId'));
end $$;

-- Force a physical-budget crossing AFTER the raw identity insert. The entire
-- source acknowledgement rolls back, while its already durable index batch
-- and page checkpoint remain available for an eventual retry.
create or replace function bid_active_catalog_private.storage_bytes()
returns bigint language sql stable security invoker set search_path='' as $$
 select case when exists(select 1 from bid_active_catalog_private.source_seen where source_id='fixture-current-cap') then 16777216 else 1024 end::bigint;
$$;
do $$declare c jsonb;r jsonb;raw_ids jsonb;begin
 update bid_active_catalog_private.runtime set retry_after_at=null,last_error=null,storage_blocked=false;
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 insert into bid_active_catalog_private.sources(id,type,kind,from_at,to_at,scope_version,claimed_lease)
 values('fixture-current-cap','공사','current','1995-10-01T00:00:00+09:00','1995-10-31T23:59:00+09:00',c->>'scopeVersion',(c->>'leaseId')::uuid);
 perform public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',c->>'leaseId','scopeVersion',c->>'scopeVersion','sourceId','fixture-current-cap','page',1,'batch',0,'batches',1,'notices','[]'::jsonb,'removed','[]'::jsonb));
 select jsonb_agg('R26CAP'||lpad(i::text,4,'0')||':000') into raw_ids from generate_series(1,999) i;
 r:=public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',c->>'leaseId','scopeVersion',c->>'scopeVersion','sources',jsonb_build_array(jsonb_build_object('id','fixture-current-cap','page',1,'totalCount',1000,'receivedCount',999,'items','[]'::jsonb,'observed','[]'::jsonb,'rawIdentities',raw_ids,'complete',false))));
 assert r->>'ok'='false' and r->>'storageFull'='true','current all-raw fence never expands the existing physical storage cap';
 assert (select page=1 and processed_count=0 and completed_at is null from bid_active_catalog_private.sources where id='fixture-current-cap'),'budget failure rolls back acknowledgement';
 assert not exists(select 1 from bid_active_catalog_private.source_seen where source_id='fixture-current-cap'),'budget failure rolls back transient raw identity rows';
 assert exists(select 1 from bid_active_catalog_private.index_batches where source_id='fixture-current-cap' and page=1),'already durable index batch survives the failed acknowledgement';
 assert bid_active_catalog_private.current_coverage()->>'complete'='false','storage-blocked current coverage cannot report completion';
end $$;
rollback;
