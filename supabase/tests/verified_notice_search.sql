-- Disposable PostgreSQL regression. No fixtures survive the rollback.
begin;
update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8'));
create function pg_temp.verified_notice(p_number text,p_type text default '공사',p_days integer default 4)
returns jsonb language sql as $$
 select jsonb_build_object('id','g2b:'||p_type||':'||p_number||':000','type',p_type,'number',p_number,'revision','000',
 'title','철거 공사 '||p_number,'agency','공공 기관','category','철거·해체','province','서울특별시','district','강남구',
 'postedAt','2001-01-01T00:00:00+09:00','sourceUpdatedAt',now()-interval '1 minute',
 'biddingStartAt',now()-interval '1 day','deadline',now()+make_interval(days=>p_days),'openingAt',now()+make_interval(days=>p_days+1),
 'status','접수중','source','live','licenses',jsonb_build_array('구조물해체ㆍ비계공사업/4995'),
 'allowedRegions',jsonb_build_array('서울특별시'),'regionComplete',true,'licenseComplete',true,
 'contractMethod','제한경쟁','estimatedPrice',100000000);
$$;
create function pg_temp.seed_verified(n jsonb,p_verified boolean default true)
returns void language sql as $$
 insert into bid_active_catalog_private.deadline_index(type,number,revision,notice,source_updated_at,deadline,opening_at,verified_at,source_version,verified_version)
 values(n->>'type',n->>'number',(n->>'revision')::integer,bid_active_catalog_private.compact(n),(n->>'sourceUpdatedAt')::timestamptz,
 (n->>'deadline')::timestamptz,(n->>'openingAt')::timestamptz,case when p_verified then now() end,
 bid_active_catalog_private.source_version(bid_active_catalog_private.compact(n)),case when p_verified then bid_active_catalog_private.source_version(bid_active_catalog_private.compact(n)) end);
$$;
create function pg_temp.search_query(p_more jsonb default '{}'::jsonb)
returns jsonb language sql as $$select jsonb_build_object('type','공사·용역','from','1995-10-01','to','2100-12-31','keyword','',
 'filters',jsonb_build_object('keyword',''),'limit',50)||p_more$$;

do $$declare r jsonb;n jsonb;claim jsonb;lease text;scope text;job text;failed boolean:=false;begin
 assert not has_function_privilege('anon','bid_active_catalog_private.worker_deadline(text,text,jsonb)','execute'),'no token bypass';
 assert not has_function_privilege('authenticated','bid_active_catalog_private.search_page(jsonb)','execute'),'private search needs token';
 assert not has_table_privilege('anon','bid_active_catalog_private.deadline_index','select'),'candidate table remains private';
 assert has_function_privilege('anon','public.bid_active_catalog_worker(text,text,jsonb)','execute'),'authenticated server RPC available';
 assert (select storage_ceiling=16777216 from bid_active_catalog_private.runtime),'unchanged 16MiB inner cap';
 assert (select storage_ceiling=33554432 from bid_alert_private.runtime),'unchanged 32MiB total cap';
 begin perform public.bid_active_catalog_worker('bad','search_page',pg_temp.search_query());exception when insufficient_privilege then failed:=true;end;
 assert failed,'untrusted token cannot enumerate public/private index';
 claim:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=claim->>'leaseId';scope:=claim->>'scopeVersion';
 assert lease is not null and jsonb_array_length(claim->'rules')=0,'no member rules required for shared collection';
 select x->>'id' into job from jsonb_array_elements(claim->'sources') x where x->>'type'='공사' limit 1;
 n:=pg_temp.verified_notice('R26UNVERIFIED');
 r:=public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',lease,'scopeVersion',scope,
   'sourceId',job,'page',1,'batch',0,'batches',1,'notices',jsonb_build_array(n),'removed','[]'::jsonb));
 assert r->>'ok'='true' and exists(select 1 from bid_active_catalog_private.verification where number='R26UNVERIFIED'),'all common heads queued';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.search_query());
 assert r->>'totalCount'='0' and r->>'pendingCount'='1','unverified candidates withheld with honest pending count';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease));
 claim:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=claim->>'leaseId';
 assert exists(select 1 from jsonb_array_elements(claim->'verify') x where x->>'number'='R26UNVERIFIED'),'common verification independent of personal conditions';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',lease,'scopeVersion',scope,'groups',jsonb_build_array(jsonb_build_array(n))));
 assert r->>'ok'='true','shared publication accepts complete exact history';
 assert not exists(select 1 from bid_active_catalog_private.groups where number='R26UNVERIFIED'),'public head avoids private historical copies';
 assert exists(select 1 from bid_active_catalog_private.verification where number='R26UNVERIFIED' and claimed_lease=lease::uuid),'publish leaves queue until personal acknowledgement';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.search_query());
 assert r->>'totalCount'='1' and r->>'pendingCount'='0' and r#>>'{items,0,sourceVersion}'=r#>>'{items,0,verifiedVersion}','published versions agree';
 perform public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',lease,'scopeVersion',scope,
   'rejectedGroups',jsonb_build_array(jsonb_build_object('type','공사','number','R26UNVERIFIED'))));
 assert not exists(select 1 from bid_active_catalog_private.verification where number='R26UNVERIFIED'),'reject acknowledges only after publication';
 -- A raw repeat of the same general facts preserves verified conditions.
 select x->>'id' into job from jsonb_array_elements(claim->'sources') x where x->>'type'='공사' limit 1;
 n:=n||'{"allowedRegions":[],"licenses":[],"regionComplete":false,"licenseComplete":false}'::jsonb;
 perform public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',lease,'scopeVersion',scope,
   'sourceId',job,'page',1,'batch',0,'batches',1,'notices',jsonb_build_array(n),'removed','[]'::jsonb));
 assert (select verified_at is not null and verified_version=source_version and notice->>'licenseComplete'='true'
   from bid_active_catalog_private.deadline_index where number='R26UNVERIFIED'),'same source preserves exact condition cache';
 assert not exists(select 1 from bid_active_catalog_private.verification where number='R26UNVERIFIED'),'no redundant full history verification';
 -- Same clock with changed provider facts must be verified again.
 n:=n||'{"title":"변경된 철거 공사"}'::jsonb;
 perform public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',lease,'scopeVersion',scope,
   'sourceId',job,'page',1,'batch',0,'batches',1,'notices',jsonb_build_array(n),'removed','[]'::jsonb));
 assert (select verified_at is null and verified_version is null from bid_active_catalog_private.deadline_index where number='R26UNVERIFIED'),'same-clock changed core invalidates verification';
 assert exists(select 1 from bid_active_catalog_private.verification where number='R26UNVERIFIED'),'changed public head requeued';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease));
end $$;

-- Global conditions are applied before paging, across construction and service.
do $$declare n jsonb;r jsonb;q jsonb;cursor_value text;seen text[]:='{}';ids text[];gen text;claim jsonb;bad boolean;body jsonb;secret bytea;begin
 delete from bid_active_catalog_private.deadline_index;delete from bid_active_catalog_private.verification;
 for i in 1..120 loop
   n:=pg_temp.verified_notice('R26PAGE'||lpad(i::text,3,'0'),case when i%2=0 then '공사' else '용역' end)
     ||jsonb_build_object('estimatedPrice',i*1000000,'title',case when i%10=0 then '해체 목표 공사' else '일반 공사' end);
   perform pg_temp.seed_verified(n);
 end loop;
 q:=pg_temp.search_query('{"keyword":"해체","filters":{"keyword":""}}');
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',q);
 assert r->>'totalCount'='12' and jsonb_array_length(r->'items')=12,'real HTTP top-level title keyword is applied';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.search_query('{"keyword":"공공 기관","filters":{"keyword":""}}'));
 assert r->>'totalCount'='0','top title keyword does not widen to agency';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.search_query('{"filters":{"keyword":"공공 기관","minAmount":"100,000,000"}}'));
 assert r->>'totalCount'='21','agency keyword and amount filters cover every page';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.search_query('{"filters":{"excludeKeyword":"해체,존재하지않음"}}'));
 assert r->>'totalCount'='108','literal exclusions apply globally';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.search_query('{"filters":{"type":"용역","license":"구조물해체·비계공사업","contractMethod":"제한경쟁","statuses":["진행중"]}}'));
 assert r->>'totalCount'='60','type, dotted license normalization, contract and phase parity';
 q:=pg_temp.search_query('{"limit":17}');
 loop
   r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',q);
   assert r->>'totalCount'='120','total remains global on all cursor pages';
   select array_agg(x->>'type'||':'||(x->>'number')) into ids from jsonb_array_elements(r->'items') x;
   assert not seen&&ids,'equal date/type cursor keys never duplicate';seen:=seen||ids;
   exit when r->>'hasMore'='false';cursor_value:=r->>'nextCursor';
   assert cursor_value!~'\s','base64 cursor contains no whitespace';q:=q||jsonb_build_object('cursor',cursor_value);
 end loop;
 assert cardinality(seen)=120,'all wide-date integrated-type results reached';
 q:=pg_temp.search_query('{"limit":17}');r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',q);cursor_value:=r->>'nextCursor';gen:=r->>'snapshotVersion';
 update bid_active_catalog_private.runtime set lease_until=now()+interval '1 minute';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',q||jsonb_build_object('cursor',cursor_value));
 assert r->>'snapshotVersion'=gen,'lease/progress changes do not invalidate search';
 bad:=false;begin perform public.bid_active_catalog_worker(repeat('a',64),'search_page',q||jsonb_build_object('cursor',cursor_value,'keyword','새 조건'));
 exception when raise_exception then bad:=sqlerrm='SEARCH_CHANGED';end;assert bad,'query change fails explicitly';
 -- Explicitly begin a distinct generation inside this fixture transaction.
 update bid_active_catalog_private.runtime set search_changed_xid=null;
 update bid_active_catalog_private.deadline_index set notice=notice||'{"title":"실제 변경"}'::jsonb where number='R26PAGE001';
 bad:=false;begin perform public.bid_active_catalog_worker(repeat('a',64),'search_page',q||jsonb_build_object('cursor',cursor_value));
 exception when raise_exception then bad:=sqlerrm='SEARCH_CHANGED';end;assert bad,'catalog changes cannot silently shift pages';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',q);cursor_value:=r->>'nextCursor';
 body:=convert_from(decode(translate(cursor_value,'-_','+/'),'base64'),'UTF8')::jsonb;body:=body-'sig';
 select token_hash into secret from bid_alert_private.runtime where singleton;
 assert (body->>'u')::timestamptz<=(body->>'a')::timestamptz+interval '10 minutes','cursor has fixed TTL';
 body:=body||jsonb_build_object('u',now()-interval '1 second');
 body:=body||jsonb_build_object('sig',encode(sha256(secret||convert_to(body::text,'UTF8')),'hex'));
 bad:=false;begin perform public.bid_active_catalog_worker(repeat('a',64),'search_page',q||jsonb_build_object('cursor',replace(encode(convert_to(body::text,'UTF8'),'base64'),E'\n','')));
 exception when raise_exception then bad:=sqlerrm='SEARCH_CHANGED';end;assert bad,'elapsed time boundary invalidates cursor';
end $$;

do $$declare n jsonb;r jsonb;q jsonb;claim jsonb;ids text[];begin
 delete from bid_active_catalog_private.deadline_index;delete from bid_active_catalog_private.verification;
 n:=pg_temp.verified_notice('R26CONDITION')||'{"regionComplete":false,"licenseComplete":false}'::jsonb;
 perform pg_temp.seed_verified(n);
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.search_query());
 assert r->>'totalCount'='0' and r->>'pendingCount'='1','incomplete legacy participant facts remain pending';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.search_query('{"filters":{"license":"구조물해체·비계공사업"}}'));
 assert r->>'totalCount'='0' and r->>'conditionPendingCount'='1','unknown license reported separately';
 perform pg_temp.seed_verified(pg_temp.verified_notice('R26UNRESTRICTED')||'{"licenses":[]}'::jsonb);
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.search_query('{"filters":{"license":"구조물해체·비계공사업"}}'));
 assert r->>'totalCount'='0' and r->>'conditionPendingCount'='1','verified empty license list is not pending';
 perform pg_temp.seed_verified(pg_temp.verified_notice('R26UNKNOWN','용역')||'{"allowedRegions":[],"regionComplete":false}'::jsonb);
 q:=pg_temp.search_query('{"type":"용역","filters":{"regions":[{"province":"서울"}],"includeUnknownRegions":false}}');
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',q);
 assert r->>'totalCount'='0' and r->>'conditionPendingCount'='1','unknown service eligibility withheld';
 q:=q||'{"filters":{"regions":[{"province":"서울"}],"includeUnknownRegions":true}}'::jsonb;
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',q);
 assert r->>'totalCount'='0' and r->>'conditionPendingCount'='1','include unknown does not bypass incomplete verification';
 update bid_active_catalog_private.deadline_index set notice=notice||'{"allowedRegions":["미확인 지역"],"regionComplete":true}'::jsonb,
   verified_version=source_version,verified_at=now() where number='R26UNKNOWN';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',q);
 assert r->>'totalCount'='1' and r->>'conditionPendingCount'='1','complete but unparseable conditions respect include unknown';
 update bid_active_catalog_private.runtime set lease_id=null,lease_until=null;
 for i in 1..20 loop perform pg_temp.seed_verified(pg_temp.verified_notice('R26QUEUE'||lpad(i::text,3,'0')),false);end loop;
 claim:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 assert jsonb_array_length(claim->'verify')=16,'shared claim expands bounded verification capacity to 16';
 assert exists(select 1 from bid_active_catalog_private.verification where number='R26CONDITION'),'incomplete legacy condition facts are reverified';
 assert exists(select 1 from jsonb_array_elements(claim->'verify') x where x->>'number'='R26CONDITION' and not(x?'notice')),'incomplete legacy source cannot be used as verified cache';
end $$;

do $$declare n jsonb;r jsonb;q jsonb;first_id text;claim jsonb;scope text;lease text;job text;bad boolean;definition text;begin
 delete from bid_active_catalog_private.deadline_index;delete from bid_active_catalog_private.verification;
 perform pg_temp.seed_verified(pg_temp.verified_notice('R26SORTNULL')||'{"estimatedPrice":null,"postedAt":""}'::jsonb);
 perform pg_temp.seed_verified(pg_temp.verified_notice('R26SORTLOW')||'{"estimatedPrice":1,"postedAt":"2025-01-01T00:00:00+09:00"}'::jsonb);
 perform pg_temp.seed_verified(pg_temp.verified_notice('R26SORTHIGH')||'{"estimatedPrice":2,"postedAt":"2026-01-01T00:00:00+09:00"}'::jsonb);
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.search_query('{"filters":{"sort":"amountAsc"}}'));
 assert r#>>'{items,0,number}'='R26SORTLOW' and r#>>'{items,2,number}'='R26SORTNULL','amount ascending puts missing last';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.search_query('{"filters":{"sort":"amountDesc"}}'));
 assert r#>>'{items,0,number}'='R26SORTHIGH' and r#>>'{items,2,number}'='R26SORTNULL','amount descending puts missing last';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.search_query('{"filters":{"sort":"newest"}}'));
 assert r#>>'{items,0,number}'='R26SORTHIGH' and r#>>'{items,2,number}'='R26SORTNULL','newest puts missing last';
 assert r->>'hasMore'='false' and r?'validUntil','final page also expires';
 -- A future-opening notice is refreshed after its submission deadline even
 -- when no member has ever matched it. No unchanged body generation churn.
 n:=pg_temp.verified_notice('R26WAITING')||jsonb_build_object('deadline',now()-interval '1 hour','openingAt',now()+interval '2 hours');
 perform pg_temp.seed_verified(n);
 update bid_active_catalog_private.deadline_index set verified_at=now()-interval '15 minutes' where number='R26WAITING';
 update bid_active_catalog_private.runtime set lease_id=null,lease_until=null;
 claim:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');scope:=claim->>'scopeVersion';lease:=claim->>'leaseId';
 assert exists(select 1 from jsonb_array_elements(claim->'verify') x where x->>'number'='R26WAITING'),'submission-past public head enters periodic verification';
 job:='test:capacity-source';
 insert into bid_active_catalog_private.sources(id,type,kind,from_at,to_at,scope_version,claimed_lease)
 values(job,'공사','history',now()-interval '1 day',now(),scope,lease::uuid);
 -- Atomic post-flight overflow: neither source receipt nor candidate survives.
 select pg_get_functiondef('bid_active_catalog_private.storage_bytes()'::regprocedure) into definition;
 execute $def$create or replace function bid_active_catalog_private.storage_bytes() returns bigint language sql stable security invoker set search_path='' as $body$
 select case when exists(select 1 from bid_active_catalog_private.deadline_index where number='R26CAPINDEX') then 16777216::bigint else 0::bigint end$body$ $def$;
 r:=public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',lease,'scopeVersion',scope,
   'sourceId',job,'page',1,'batch',0,'batches',1,'notices',jsonb_build_array(pg_temp.verified_notice('R26CAPINDEX')),'removed','[]'::jsonb));
 execute definition;
 assert r->>'storageFull'='true' and r->>'ok'='false','physical index overflow is reported';
 assert not exists(select 1 from bid_active_catalog_private.deadline_index where number='R26CAPINDEX'),'overflow leaves no new public row';
 assert not exists(select 1 from bid_active_catalog_private.verification where number='R26CAPINDEX'),'overflow leaves no orphan verification';
 assert not exists(select 1 from bid_active_catalog_private.index_batches where source_id=job),'overflow leaves no source checkpoint receipt';
 assert (select page=1 and completed_at is null from bid_active_catalog_private.sources where id=job),'source checkpoint unchanged';
 -- Terminal verification cannot be undone by a raw replay at the same source
 -- time; the watermark is tiny and contains no historical notice body.
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',lease,'scopeVersion',scope,
   'groups',jsonb_build_array(jsonb_build_array(n||'{"openingCompleted":true}'::jsonb))));
 assert r->>'ok'='true' and not exists(select 1 from bid_active_catalog_private.deadline_index where number='R26WAITING'),'actual completion removes current public head';
 assert exists(select 1 from bid_active_catalog_private.deadline_invalidations where number='R26WAITING'),'completion retains minimal monotonic watermark';
 perform public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',lease,'scopeVersion',scope,
   'sourceId',job,'page',1,'batch',0,'batches',1,'notices',jsonb_build_array(n),'removed','[]'::jsonb));
 assert not exists(select 1 from bid_active_catalog_private.deadline_index where number='R26WAITING'),'same-source raw cannot resurrect completion';
 bad:=false;begin perform public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',lease,'scopeVersion',scope,'groups',jsonb_build_array(jsonb_build_array(n))));
 exception when raise_exception then bad:=true;end;assert bad,'same-source verified replay cannot resurrect completion';
 assert exists(select 1 from bid_active_catalog_private.verification where number='R26WAITING'),'failed publication leaves its queue available for retry';
 r:=public.bid_active_catalog_worker(repeat('a',64),'publish_verified',jsonb_build_object('notices',jsonb_build_array(n)));
 assert r->>'ok'='false' and not exists(select 1 from bid_active_catalog_private.deadline_index where number='R26WAITING'),'alarm publication cannot bypass terminal watermark';
 n:=pg_temp.verified_notice('R26ALARMFLAG')||'{"openingCompleted":true}'::jsonb;
 perform public.bid_active_catalog_worker(repeat('a',64),'publish_verified',jsonb_build_object('notices',jsonb_build_array(n)));
 perform public.bid_active_catalog_worker(repeat('a',64),'publish_verified',jsonb_build_object('notices',jsonb_build_array(n-'openingCompleted')));
 assert not exists(select 1 from bid_active_catalog_private.deadline_index where number='R26ALARMFLAG') and
   (select latest->>'openingCompleted'='true' from bid_active_catalog_private.groups where number='R26ALARMFLAG'),'same-source alarm replay cannot undo completion evidence';
 -- A storage failure during public verification also preserves unverified row,
 -- queue and lease. Private acknowledgement cannot be reached by the worker.
 n:=pg_temp.verified_notice('R26CAPPUBLISH');perform pg_temp.seed_verified(n,false);
 insert into bid_active_catalog_private.verification(type,number,revision,source_updated_at,scope_version,claimed_lease)
 values('공사','R26CAPPUBLISH',0,(n->>'sourceUpdatedAt')::timestamptz,scope,lease::uuid);
 execute $def$create or replace function bid_active_catalog_private.storage_bytes() returns bigint language sql stable security invoker set search_path='' as $body$
 select case when exists(select 1 from bid_active_catalog_private.deadline_index where number='R26CAPPUBLISH' and verified_at is not null) then 16777216::bigint else 0::bigint end$body$ $def$;
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',lease,'scopeVersion',scope,'groups',jsonb_build_array(jsonb_build_array(n))));
 execute definition;
 assert r->>'storageFull'='true' and (select verified_at is null from bid_active_catalog_private.deadline_index where number='R26CAPPUBLISH'),'over-budget publication rolls back verification';
 assert exists(select 1 from bid_active_catalog_private.verification where number='R26CAPPUBLISH' and claimed_lease=lease::uuid),'over-budget publication preserves queue';
 assert not exists(select 1 from bid_active_catalog_private.groups where number='R26CAPPUBLISH'),'over-budget publication never copies personal history';
 assert (select storage_blocked from bid_active_catalog_private.runtime),'storage pause visible to public feedback';
end $$;

-- Known geography aliases, merged search province and legacy company scope.
do $$declare base jsonb:=pg_temp.verified_notice('R26GEO');f jsonb;begin
 f:='{"keyword":"","excludeKeyword":"","category":"전체","type":"전체","status":"전체","contractMethod":"전체","license":"전체","minAmount":"","maxAmount":"","siteProvince":"전체","regionView":"all","autoRegion":false}'::jsonb;
 assert bid_active_catalog_private.search_match(base,f||'{"regions":[{"province":"서울","district":"강남구"}]}','{}',now())='match','construction locality match';
 assert bid_active_catalog_private.search_match(base,f||'{"regions":[{"province":"경기"}]}','{}',now())='excluded','construction site mismatch';
 assert bid_active_catalog_private.search_match(base||'{"province":"광주광역시","district":"북구"}',f||'{"regions":[{"province":"전라남도"}]}','{}',now())='match','search merges supported Jeonnam/Gwangju alias';
 assert bid_active_catalog_private.profile_region_state(base||'{"allowedRegions":["광주광역시"]}', '{"province":"전라남도","district":"나주시"}')='excluded','company participation province does not merge';
 assert bid_active_catalog_private.search_match(base||'{"type":"용역","allowedRegions":["전국"]}',f||'{"regions":[{"province":"서울","district":"강남구"}]}','{}',now())='match','nationwide service eligible';
 assert bid_active_catalog_private.search_match(base||'{"type":"용역","allowedRegions":["미확인 지역"]}',f||'{"regions":[{"province":"서울"}],"includeUnknownRegions":false}','{}',now())='pending','unparsed service region does not claim a match';
 assert bid_active_catalog_private.safe_time('2027-01-01 10:00')='2027-01-01T10:00:00+09:00'::timestamptz,'timezone-free API time interpreted as KST';
 assert bid_active_catalog_private.safe_time('tomorrow') is null,'relative date syntax rejected';
end $$;
rollback;

