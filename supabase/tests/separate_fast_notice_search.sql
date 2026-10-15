-- Fast results retain the audited membership/cursor semantics without status work.
begin;
update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8'));
update bid_active_catalog_private.runtime set scope_version=bid_active_catalog_private.scope_version(),lease_id=null,lease_until=null,retry_after_at=null,storage_blocked=false,last_error=null;
delete from bid_active_catalog_private.verification;delete from bid_active_catalog_private.deadline_index;delete from bid_active_catalog_private.groups;delete from bid_active_catalog_private.deadline_invalidations;
create function pg_temp.speed_notice(p_number text,p_more jsonb default '{}'::jsonb) returns jsonb language sql as $$
 select jsonb_build_object('id','g2b:공사:'||p_number||':000','number',p_number,'revision','000','type','공사','title','학교 철거 해체 석면 건설폐기물 공사',
 'agency','공공 기관','demandAgency','교육청','category','철거·해체','province','서울특별시','district','강남구','postedAt',now()-interval '1 day',
 'sourceUpdatedAt',now()-interval '1 minute','biddingStartAt',now()-interval '2 days','deadline',now()+interval '7 days','openingAt',now()+interval '8 days',
 'status','접수중','source','live','regionComplete',true,'licenseComplete',true,'licenses',jsonb_build_array('구조물해체·비계공사업'),'allowedRegions',jsonb_build_array('서울특별시'),
 'contractMethod','제한경쟁','estimatedPrice',100000000,'sourceOmittedDigest',repeat('a',64))||p_more;
$$;
create function pg_temp.speed_seed(n jsonb) returns void language sql as $$
 insert into bid_active_catalog_private.deadline_index(type,number,revision,notice,source_updated_at,deadline,opening_at,verified_at,source_version,verified_version)
 values(n->>'type',n->>'number',(n->>'revision')::integer,bid_active_catalog_private.compact(n),(n->>'sourceUpdatedAt')::timestamptz,
 (n->>'deadline')::timestamptz,(n->>'openingAt')::timestamptz,now(),bid_active_catalog_private.source_version(bid_active_catalog_private.compact(n)),bid_active_catalog_private.source_version(bid_active_catalog_private.compact(n)));
$$;
create function pg_temp.speed_query(p_more jsonb default '{}'::jsonb) returns jsonb language sql as $$
 select jsonb_build_object('type','공사·용역','from','1995-10-01','to','2100-12-31','keyword','철거','filters','{}'::jsonb,'limit',7)||p_more;
$$;
do $$declare i integer;n jsonb;q jsonb;old_page jsonb;fast_page jsonb;old_all jsonb;fast_all jsonb;projection jsonb;status_page jsonb;before_queue bigint;begin
 for i in 1..81 loop
   n:=pg_temp.speed_notice('R26FAST'||lpad(i::text,3,'0'),jsonb_build_object('estimatedPrice',i*10000000,'postedAt',now()-make_interval(hours=>i),
     'title',case when i%4=0 then '철거 공사' when i%4=1 then '학교 해체 공사' when i%4=2 then '석면 제거 용역' else '건설폐기물 처리' end,
     'deadline',now()+case when i%3=0 then interval '8 hours' else interval '5 days' end,
     'biddingStartAt',now()+case when i%7=0 then interval '1 day' else interval '-1 day' end));
   if i%2=0 then n:=n||jsonb_build_object('id','g2b:용역:'||(n->>'number')||':000','type','용역');end if;
   perform pg_temp.speed_seed(n);
 end loop;
 perform pg_temp.speed_seed(pg_temp.speed_notice('R26UNVERIFIED','{"regionComplete":false,"licenseComplete":false}'));
 perform pg_temp.speed_seed(pg_temp.speed_notice('R26INVALIDATED'));
 insert into bid_active_catalog_private.deadline_invalidations(type,number,revision,source_updated_at) values('공사','R26INVALIDATED',1,now());
 perform pg_temp.speed_seed(pg_temp.speed_notice('R26OPENED','{"openingCompleted":true}'));
 perform pg_temp.speed_seed(pg_temp.speed_notice('R26CANCELLED','{"status":"취소","noticeKind":"취소공고"}'));
 foreach q in array array[
   pg_temp.speed_query(),pg_temp.speed_query('{"keyword":"해체"}'),pg_temp.speed_query('{"keyword":"석면","type":"용역"}'),pg_temp.speed_query('{"keyword":"건설폐기물"}'),
   pg_temp.speed_query('{"keyword":"","filters":{"excludeKeyword":"학교","sort":"newest"}}'),
   pg_temp.speed_query('{"keyword":"","filters":{"sort":"amountAsc","minAmount":"100,000,000","license":"구조물해체·비계공사업","regions":[{"province":"서울"}]}}'),
   pg_temp.speed_query('{"keyword":"","filters":{"sort":"amountDesc","autoRegion":true},"profile":{"province":"서울특별시","district":"강남구"}}')
 ] loop
   old_all:='[]';fast_all:='[]';old_page:=public.bid_active_catalog_worker(repeat('a',64),'search_page',q);
   fast_page:=public.bid_active_catalog_worker(repeat('a',64),'search_results',q);
   loop
     select jsonb_object_agg(key,value) into projection from jsonb_each(old_page) where key=any(array['items','totalCount','page','pageSize','hasMore','fetchedAt','source','nextCursor','snapshotVersion','asOf','validUntil']);
     assert fast_page=projection,'fast page exactly preserves legacy fields, contents, order, snapshot and signed cursor';
     assert not exists(select 1 from jsonb_array_elements(fast_page->'items') x where x->>'number' in ('R26UNVERIFIED','R26INVALIDATED','R26OPENED','R26CANCELLED')),'fast path never bypasses latest cancellation, opening or condition verification';
     old_all:=old_all||(old_page->'items');fast_all:=fast_all||(fast_page->'items');
     exit when old_page->>'nextCursor' is null;
     old_page:=public.bid_active_catalog_worker(repeat('a',64),'search_page',q||jsonb_build_object('cursor',old_page->>'nextCursor'));
     fast_page:=public.bid_active_catalog_worker(repeat('a',64),'search_results',q||jsonb_build_object('cursor',fast_page->>'nextCursor'));
   end loop;
   assert fast_all=old_all,'complete cursor traversal has identical membership';
   assert (select count(*)=count(distinct x->>'id') from jsonb_array_elements(fast_all) x),'complete traversal has no duplicates';
 end loop;
 q:=pg_temp.speed_query();fast_page:=public.bid_active_catalog_worker(repeat('a',64),'search_results',q);
 status_page:=public.bid_active_catalog_worker(repeat('a',64),'search_status',q||jsonb_build_object('asOf',fast_page->>'asOf','snapshotVersion',fast_page->>'snapshotVersion'));
 assert status_page->>'asOf'=fast_page->>'asOf' and status_page->>'snapshotVersion'=fast_page->>'snapshotVersion','separate metadata is anchored to the exact result snapshot';
 assert not status_page?'items' and not status_page?'totalCount' and not status_page?'nextCursor','metadata action does not generate result pages';
 assert status_page->>'pendingCount'='1' and status_page->>'conditionPendingCount'='0','general pending verification is separate from requested participant conditions';
 q:=pg_temp.speed_query('{"filters":{"license":"구조물해체·비계공사업"}}');
 fast_page:=public.bid_active_catalog_worker(repeat('a',64),'search_results',q);
 status_page:=public.bid_active_catalog_worker(repeat('a',64),'search_status',q||jsonb_build_object('asOf',fast_page->>'asOf','snapshotVersion',fast_page->>'snapshotVersion'));
 assert status_page->>'pendingCount'='1' and status_page->>'conditionPendingCount'='1','requested participant-condition pending counts remain query-specific';
 assert (select search_requested_at is not null from bid_active_catalog_private.verification where number='R26UNVERIFIED'),'separate metadata still requests bounded verification in the background path';
 assert not has_function_privilege('anon','bid_active_catalog_private.search_results(jsonb)','execute') and not has_function_privilege('authenticated','bid_active_catalog_private.search_status(jsonb)','execute'),'both helpers remain private';
end $$;

do $$declare q jsonb:=pg_temp.speed_query();p jsonb;bad boolean:=false;begin
 p:=public.bid_active_catalog_worker(repeat('a',64),'search_results',q);
 begin perform public.bid_active_catalog_worker(repeat('a',64),'search_status',q);exception when invalid_parameter_value then bad:=true;end;
 assert bad,'metadata requires an explicit result anchor';bad:=false;
 begin perform public.bid_active_catalog_worker(repeat('a',64),'search_status',q||jsonb_build_object('asOf','bad','snapshotVersion',p->>'snapshotVersion'));exception when invalid_parameter_value then bad:=true;end;
 assert bad,'metadata rejects malformed anchor times';bad:=false;
 begin perform public.bid_active_catalog_worker(repeat('a',64),'search_status',q||jsonb_build_object('asOf',now()-interval '11 minutes','snapshotVersion',p->>'snapshotVersion'));exception when raise_exception then bad:=sqlerrm='SEARCH_CHANGED';end;
 assert bad,'metadata cannot reuse an expired result anchor';bad:=false;
 begin perform public.bid_active_catalog_worker(repeat('a',64),'search_results',q||'{"from":"bad"}');exception when invalid_parameter_value then bad:=true;end;
 assert bad,'fast query retains normal input validation';bad:=false;
 begin perform public.bid_active_catalog_worker('wrong','search_results',q);exception when insufficient_privilege then bad:=true;end;
 assert bad,'fast query cannot bypass the worker token';bad:=false;
 -- Model the next ingestion transaction while this disposable fixture stays
 -- inside one rollback-only transaction.
 update bid_active_catalog_private.runtime set search_changed_xid=null;
 update bid_active_catalog_private.deadline_index set notice=notice||'{"agency":"새 발주기관"}'::jsonb where number='R26FAST004';
 begin perform public.bid_active_catalog_worker(repeat('a',64),'search_status',q||jsonb_build_object('asOf',p->>'asOf','snapshotVersion',p->>'snapshotVersion'));exception when raise_exception then bad:=sqlerrm='SEARCH_CHANGED';end;
 assert bad,'metadata cannot attach a changed generation to older results';bad:=false;
 begin perform public.bid_active_catalog_worker(repeat('a',64),'search_results',q||jsonb_build_object('cursor',p->>'nextCursor'));exception when raise_exception then bad:=sqlerrm='SEARCH_CHANGED';end;
 assert bad,'fast continuation cannot bypass a generation change';
end $$;

do $$declare q jsonb:=pg_temp.speed_query();n jsonb;generation text;bad boolean:=false;begin
 n:=pg_temp.speed_notice('R26FASTBOUNDARY',jsonb_build_object('biddingStartAt',now()-interval '1 second'));
 perform pg_temp.speed_seed(n);
 select search_generation::text into generation from bid_active_catalog_private.runtime where singleton;
 begin perform public.bid_active_catalog_worker(repeat('a',64),'search_status',q||jsonb_build_object('asOf',now()-interval '2 seconds','snapshotVersion',generation));
 exception when raise_exception then bad:=sqlerrm='SEARCH_CHANGED';end;
 assert bad,'metadata rejects a crossed schedule boundary even inside the ten-minute anchor lifetime';
end $$;

-- Trap every forbidden status/size/demand helper at its actual execution point.
create or replace function bid_active_catalog_private.current_coverage() returns jsonb language plpgsql stable set search_path='' as $$begin raise exception 'forbidden fast coverage';end$$;
create or replace function bid_active_catalog_private.index_coverage() returns jsonb language plpgsql stable set search_path='' as $$begin raise exception 'forbidden fast history';end$$;
create or replace function bid_active_catalog_private.status() returns jsonb language plpgsql stable set search_path='' as $$begin raise exception 'forbidden fast status';end$$;
create or replace function bid_active_catalog_private.storage_bytes() returns bigint language plpgsql stable set search_path='' as $$begin raise exception 'forbidden fast catalog size';end$$;
create or replace function bid_alert_private.storage_bytes() returns bigint language plpgsql stable set search_path='' as $$begin raise exception 'forbidden fast combined size';end$$;
create or replace function bid_active_catalog_private.request_search_verification(p_payload jsonb) returns integer language plpgsql volatile set search_path='' as $$begin raise exception 'forbidden fast demand';end$$;
do $$declare p jsonb;before_queue bigint;begin
 select count(*) into before_queue from bid_active_catalog_private.verification;
 p:=public.bid_active_catalog_worker(repeat('a',64),'search_results',pg_temp.speed_query());
 assert (p->>'totalCount')::integer>0 and jsonb_array_length(p->'items')>0,'fast results execute with all collection helpers unavailable';
 assert (select count(*)=before_queue from bid_active_catalog_private.verification),'fast query never mutates the verification queue';
end $$;
rollback;
