-- Regional text must fit the pre-existing compact catalog and alert ledgers.
begin;
do $$declare n jsonb;c jsonb;projection text;next_value jsonb;begin
 n:=jsonb_build_object('id','x','number','R26BUDGET','revision','000','title','철거','agency','기관','type','공사',
   'regionSearchText',repeat(E'서울 "현장"\n😀',1000));
 c:=bid_active_catalog_private.compact(n);projection:=c->>'regionSearchText';
 assert length(projection)<=3000 and octet_length(c::text)<=4096,'Korean, quote, newline and emoji projection fits 4 KiB';
 assert projection=left(n->>'regionSearchText',length(projection)),'the retained text is an intact Unicode prefix';
 next_value:=jsonb_set(c,'{regionSearchText}',to_jsonb(left(n->>'regionSearchText',length(projection)+1)));
 assert octet_length(next_value::text)>4096,'the largest fitting prefix is retained';
 assert length(projection)=1522 and octet_length(c::text)=4096,'shared JS/SQL Unicode and JSONB-spacing fixture';
 n:=jsonb_build_object('id','x','number','R26ASCII','revision','000','type','공사','regionSearchText',repeat('a',5000));
 c:=bid_active_catalog_private.compact(n);
 assert length(c->>'regionSearchText')=3000,'small ASCII still obeys the 3000-character provider cap';
 n:=jsonb_build_object('id','x','title',repeat('가',1300),'regionSearchText',repeat('서울',1000));
 c:=bid_active_catalog_private.compact(n);
 assert octet_length(c::text)<=4096,'a large existing title reduces the text allowance';
 n:=jsonb_build_object('id','x','title',repeat('가',1330),'regionSearchText','서울');
 c:=bid_active_catalog_private.compact(n);
 assert not c?'regionSearchText','optional text is omitted when even its empty property exceeds the allowance';
 n:=jsonb_build_object('id','x','title',repeat('가',2000),'regionSearchText','서울');
 c:=bid_active_catalog_private.compact(n);
 assert not c?'regionSearchText' and octet_length(c::text)>4096,'pre-existing oversized base facts retain the original worker rejection';
 assert octet_length(bid_active_catalog_private.compact(jsonb_build_object('title','철거','regionSearchText',repeat('서울 현장',5000)))::text)<=16384,'compact facts also fit the existing 16 KiB observations constraint';
 assert (select storage_ceiling=25165824 from bid_active_catalog_private.runtime),'catalog cap stays 24 MiB';
 assert (select storage_ceiling=33554432 from bid_alert_private.runtime),'total cap stays 32 MiB';
 assert not has_function_privilege('anon','bid_active_catalog_private.compact(jsonb)','execute'),'compact function remains private';
 assert bid_active_catalog_private.compact(jsonb_build_object('regionSearchDigest',repeat('a',64)))->>'regionSearchDigest'=repeat('a',64),'stable provider digest survives compaction';
 assert not bid_active_catalog_private.compact('{"regionSearchDigest":123}')?'regionSearchDigest','invalid digest is omitted';
end $$;

-- The real source/index fence must accept participant enrichment even though
-- it leaves less room for the optional regional text prefix.
update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8'));
update bid_active_catalog_private.runtime set scope_version=bid_active_catalog_private.scope_version(),lease_id=null,lease_until=null,retry_after_at=null,storage_blocked=false,last_error=null;
delete from bid_active_catalog_private.verification;
delete from bid_active_catalog_private.deadline_index;
delete from bid_active_catalog_private.groups;
do $$declare n jsonb;enriched jsonb;c jsonb;r jsonb;scope text;lease text;job text;regions jsonb;failed boolean;begin
 n:=jsonb_build_object('id','g2b:공사:R26REGIONBOUND:000','number','R26REGIONBOUND','revision','000','type','공사',
   'title','철거 공사','agency','공공 기관','category','철거·해체','province','서울특별시','district','강남구',
   'postedAt',now()-interval '1 day','sourceUpdatedAt',now()-interval '1 minute',
   'biddingStartAt',now()-interval '1 day','deadline',now()+interval '4 days','openingAt',now()+interval '5 days',
   'status','접수중','source','live','licenses','[]'::jsonb,'allowedRegions','[]'::jsonb,
   'regionComplete',false,'licenseComplete',false,'contractMethod','제한경쟁','estimatedPrice',100000000,
   'regionSearchText',repeat('서울 부산 철거 현장 ',500),'regionSearchDigest',repeat('a',64));
 select jsonb_agg('서울특별시 강남구 조건'||i) into regions from generate_series(1,25) i;
 enriched:=bid_active_catalog_private.compact(n||jsonb_build_object('allowedRegions',regions,'licenses',jsonb_build_array('구조물해체·비계공사업'),
   'regionComplete',true,'licenseComplete',true));
 n:=bid_active_catalog_private.compact(n);
 assert length(enriched->>'regionSearchText')<length(n->>'regionSearchText'),'participant facts reduce the projected prefix';
 assert bid_active_catalog_private.source_version(n)=bid_active_catalog_private.source_version(enriched),'participant facts and prefix size do not create source conflicts';
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';scope:=c->>'scopeVersion';
 select x->>'id' into job from jsonb_array_elements(c->'sources') x
   where x->>'type'='공사' and x->>'procurementSource' is distinct from 'private' limit 1;
 assert job is not null,'a leased public source is available';
 r:=public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',lease,'scopeVersion',scope,
   'sourceId',job,'page',1,'batch',0,'batches',1,'notices',jsonb_build_array(n),'removed','[]'::jsonb));
 assert r->>'ok'='true','long regional source indexes within 4 KiB';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease));
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';
 select x->>'id' into job from jsonb_array_elements(c->'sources') x
   where x->>'type'='공사' and x->>'procurementSource' is distinct from 'private' limit 1;
 assert exists(select 1 from jsonb_array_elements(c->'verify') x where x->>'number'='R26REGIONBOUND'),'source is queued for exact verification';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',lease,'scopeVersion',scope,
   'groups',jsonb_build_array(jsonb_build_array(enriched))));
 assert r->>'ok'='true','shorter enriched prefix publishes without same-clock conflict';
 assert exists(select 1 from bid_active_catalog_private.deadline_index where number='R26REGIONBOUND'
   and verified_at is not null and source_version=verified_version and octet_length(notice::text)<=4096),'enriched head remains verified within the original allowance';
 r:=public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',lease,'scopeVersion',scope,
   'sourceId',job,'page',1,'batch',0,'batches',1,'notices',jsonb_build_array(n),'removed','[]'::jsonb));
 assert r->>'ok'='true' and exists(select 1 from bid_active_catalog_private.deadline_index where number='R26REGIONBOUND'
   and verified_at is not null and notice->>'regionComplete'='true' and octet_length(notice::text)<=4096),'repeated listing recompacts cached participant conditions and keeps verification';

 -- Existing installations have no digest until the first fresh provider read.
 update bid_active_catalog_private.deadline_index set notice=notice-'regionSearchDigest' where number='R26REGIONBOUND';
 update bid_active_catalog_private.verification v set source_version=d.source_version
 from bid_active_catalog_private.deadline_index d where v.type=d.type and v.number=d.number and v.number='R26REGIONBOUND';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',lease,'scopeVersion',scope,
   'groups',jsonb_build_array(jsonb_build_array(enriched))));
 assert r->>'ok'='true' and exists(select 1 from bid_active_catalog_private.deadline_index where number='R26REGIONBOUND'
   and notice->>'regionSearchDigest'=repeat('a',64) and verified_at is not null),'unchanged legacy head adopts its first stable provider digest';
 failed:=false;
 begin
   r:=public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',lease,'scopeVersion',scope,
     'groups',jsonb_build_array(jsonb_build_array(enriched||jsonb_build_object('regionSearchDigest',repeat('b',64))))));
   failed:=r->>'retryRequired'='true' and r->>'reason'='source_changed';
 exception when sqlstate 'PBC01' then failed:=true;end;
 assert failed,'a different existing digest still creates a structured conflict';
 update bid_active_catalog_private.deadline_index set notice=notice-'regionSearchDigest' where number='R26REGIONBOUND';
 update bid_active_catalog_private.verification v set source_version=d.source_version
 from bid_active_catalog_private.deadline_index d where v.type=d.type and v.number=d.number and v.number='R26REGIONBOUND';
 failed:=false;
 begin
   r:=public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',lease,'scopeVersion',scope,
     'groups',jsonb_build_array(jsonb_build_array(enriched||'{"title":"실제 변경된 공고"}'::jsonb))));
   failed:=r->>'retryRequired'='true' and r->>'reason'='source_changed';
 exception when sqlstate 'PBC01' then failed:=true;end;
 assert failed,'first digest adoption cannot hide a changed source fact';
end $$;
rollback;
