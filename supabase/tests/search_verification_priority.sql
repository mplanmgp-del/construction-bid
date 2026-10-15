-- Disposable PostgreSQL regression; queue demand fixtures never survive.
begin;
update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8'));
update bid_active_catalog_private.runtime set scope_version=bid_active_catalog_private.scope_version(),lease_id=null,lease_until=null,retry_after_at=null,storage_blocked=false;
create function pg_temp.priority_notice(p_number text,p_type text default '공사')
returns jsonb language sql as $$
 select jsonb_build_object('id','g2b:'||p_type||':'||p_number||':000','type',p_type,'number',p_number,'revision','000',
 'title','철거 공사 '||p_number,'agency','공공 기관','category','철거·해체','province','서울특별시','district','강남구',
 'postedAt','2001-01-01T00:00:00+09:00','sourceUpdatedAt',now()-interval '1 minute',
 'biddingStartAt',now()-interval '1 day','deadline',now()+interval '4 days','openingAt',now()+interval '5 days',
 'status','접수중','source','live','licenses',jsonb_build_array('구조물해체ㆍ비계공사업/4995'),
 'allowedRegions',jsonb_build_array('서울특별시'),'regionComplete',false,'licenseComplete',false,
 'contractMethod','제한경쟁','estimatedPrice',100000000);
$$;
create function pg_temp.priority_seed(n jsonb,p_verified boolean default false)
returns void language sql as $$
 insert into bid_active_catalog_private.deadline_index(type,number,revision,notice,source_updated_at,deadline,opening_at,verified_at,source_version,verified_version)
 values(n->>'type',n->>'number',(n->>'revision')::integer,bid_active_catalog_private.compact(n),(n->>'sourceUpdatedAt')::timestamptz,
 (n->>'deadline')::timestamptz,(n->>'openingAt')::timestamptz,case when p_verified then now() end,
 bid_active_catalog_private.source_version(bid_active_catalog_private.compact(n)),case when p_verified then bid_active_catalog_private.source_version(bid_active_catalog_private.compact(n)) end);
$$;
create function pg_temp.priority_query(p_more jsonb default '{}'::jsonb)
returns jsonb language sql as $$select jsonb_build_object('type','공사','from','1995-10-01','to','2100-12-31','keyword','철거',
 'filters',jsonb_build_object('keyword','','regions',jsonb_build_array(jsonb_build_object('province','서울')),
 'license','구조물해체·비계공사업','minAmount','50,000,000'),'limit',50)||p_more$$;

do $$declare bad boolean:=false;before_count bigint;begin
 assert not has_function_privilege('anon','bid_active_catalog_private.request_search_verification(jsonb)','execute'),'demand helper private';
 assert not has_function_privilege('authenticated','bid_active_catalog_private.prioritize_search_verification(uuid,text,timestamptz)','execute'),'priority helper private';
 assert not has_table_privilege('anon','bid_active_catalog_private.verification','update'),'queue cannot be reprioritized by a browser';
 assert (select storage_ceiling=16777216 from bid_active_catalog_private.runtime),'unchanged 16MiB catalog cap';
 assert (select storage_ceiling=33554432 from bid_alert_private.runtime),'unchanged 32MiB total cap';
 select count(*) into before_count from bid_active_catalog_private.verification;
 begin perform public.bid_active_catalog_worker('wrong','search_page',pg_temp.priority_query());exception when insufficient_privilege then bad:=true;end;
 assert bad,'invalid token rejected before any queue write';
 bad:=false;begin perform public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.priority_query('{"from":"bad"}'));exception when invalid_parameter_value then bad:=true;end;
 assert bad,'invalid query rejected before demand';
 assert (select count(*)=before_count from bid_active_catalog_private.verification),'failed authorization/validation has no side effects';
end $$;

do $$declare n jsonb;r jsonb;c jsonb;again jsonb;scope text:=bid_active_catalog_private.scope_version();first_stamp timestamptz;gen bigint;ids text[];before_total bigint;begin
 delete from bid_active_catalog_private.verification;delete from bid_active_catalog_private.deadline_index;delete from bid_active_catalog_private.groups;
 for i in 1..20 loop
   n:=pg_temp.priority_notice('R26FIFO'||lpad(i::text,3,'0'))||'{"title":"도로 신설 공사"}'::jsonb;
   perform pg_temp.priority_seed(n);
 end loop;
 for i in 1..12 loop perform pg_temp.priority_seed(pg_temp.priority_notice('R26DEMAND'||lpad(i::text,3,'0')));end loop;
 perform pg_temp.priority_seed(pg_temp.priority_notice('R26PRICEUNKNOWN')||'{"estimatedPrice":null,"contractMethod":"","category":""}'::jsonb);
 perform pg_temp.priority_seed(pg_temp.priority_notice('R26VERIFIED')||'{"regionComplete":true,"licenseComplete":true}'::jsonb,true);
 perform pg_temp.priority_seed(pg_temp.priority_notice('R26OTHERREGION')||'{"province":"경기도","district":"수원시"}'::jsonb);
 perform pg_temp.priority_seed(pg_temp.priority_notice('R26OTHERTYPE','용역'));
 perform pg_temp.priority_seed(pg_temp.priority_notice('R26LOWPRICE')||'{"estimatedPrice":1}'::jsonb);
 perform bid_active_catalog_private.queue_search_verification();
 update bid_active_catalog_private.verification set queued_at=now()-interval '30 days'+make_interval(secs=>right(number,3)::integer)
 where number like 'R26FIFO%';
 update bid_active_catalog_private.verification set failures=3,next_attempt=now()+interval '1 hour',last_error='retry later' where number='R26DEMAND012';
 select search_generation into gen from bid_active_catalog_private.runtime where singleton;
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.priority_query());
 assert r->>'totalCount'='1','search still returns only fully verified matching heads';
 assert (select search_generation=gen from bid_active_catalog_private.runtime where singleton),'queue demand never changes result generation';
 assert (select count(*)=13 from bid_active_catalog_private.verification where search_requested_at is not null),'all possible scoped candidates requested including unknown general facts';
 assert (select search_requested_at is not null from bid_active_catalog_private.verification where number='R26PRICEUNKNOWN'),'unknown price/category/contract is verified before exclusion';
 assert not exists(select 1 from bid_active_catalog_private.verification where search_requested_at is not null and number in ('R26VERIFIED','R26OTHERREGION','R26OTHERTYPE','R26LOWPRICE')),'known nonmatches and unchanged verified row not prioritized';
 assert (select failures=3 and next_attempt>now() and last_error='retry later' from bid_active_catalog_private.verification where number='R26DEMAND012'),'demand preserves failure backoff';
 select search_requested_at into first_stamp from bid_active_catalog_private.verification where number='R26DEMAND001';
 perform public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.priority_query());
 assert (select search_requested_at=first_stamp from bid_active_catalog_private.verification where number='R26DEMAND001'),'repeated searches are throttled for ten minutes';
 update bid_active_catalog_private.verification set search_requested_at=now()-interval '11 minutes' where number='R26DEMAND001';
 perform public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.priority_query());
 assert (select search_requested_at>now()-interval '1 minute' from bid_active_catalog_private.verification where number='R26DEMAND001'),'older demand can be renewed';
 -- Existing tracked checks are inserted by the inherited base claim.
 for i in 1..6 loop
   n:=pg_temp.priority_notice('R26TRACK'||lpad(i::text,3,'0'))||'{"title":"추적 공사","regionComplete":true,"licenseComplete":true}'::jsonb;
   insert into bid_active_catalog_private.groups(type,number,latest,versions,revision,source_updated_at,next_check_at)
   values('공사',n->>'number',n,jsonb_build_array(n),0,(n->>'sourceUpdatedAt')::timestamptz,now()-interval '1 hour');
 end loop;
 select count(*) into before_total from bid_active_catalog_private.verification;
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 assert jsonb_array_length(c->'verify')=16,'claim remains bounded to sixteen';
 assert (select bool_and(v.search_requested_at is not null) from jsonb_array_elements(c->'verify') with ordinality x(n,ord)
   join bid_active_catalog_private.verification v on v.type=x.n->>'type' and v.number=x.n->>'number' where x.ord<=8),'requested heads occupy the first eight worker positions';
 assert (select count(*)=4 from jsonb_array_elements(c->'verify') with ordinality x(item,ord) where ord between 9 and 12 and item->>'number' like 'R26FIFO%'),'four oldest background candidates progress despite demand';
 assert (select count(*)=4 from jsonb_array_elements(c->'verify') with ordinality x(item,ord) where ord between 13 and 16 and item->>'number' like 'R26TRACK%'),'tracked refreshes retain four reserved positions';
 assert not exists(select 1 from jsonb_array_elements(c->'verify') x where x->>'number'='R26DEMAND012'),'priority cannot bypass provider backoff';
 assert (select count(*)=before_total+6 from bid_active_catalog_private.verification),'claim never drops unselected candidates';
 assert (select count(*)=16 from bid_active_catalog_private.verification where claimed_lease=(c->>'leaseId')::uuid),'exactly selected rows receive lease';
 -- A foreground request during collection must not clear the worker's lease,
 -- even if the raw source was modified since the queued version was stored.
 update bid_active_catalog_private.deadline_index set notice=notice||'{"agency":"원천 변경 기관"}'::jsonb where number=c#>>'{verify,0,number}';
 perform public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.priority_query('{"filters":{"keyword":"원천 변경 기관"}}'));
 assert (select claimed_lease=(c->>'leaseId')::uuid from bid_active_catalog_private.verification where number=c#>>'{verify,0,number}'),'search ranking preserves inflight lease across source updates';
 again:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 assert again->>'leaseId' is null and jsonb_array_length(again->'verify')=0,'concurrent claim cannot steal an active lease';
 assert (select count(*)=16 from bid_active_catalog_private.verification where claimed_lease=(c->>'leaseId')::uuid),'busy retry preserves active choices';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',c->>'leaseId'));
 -- Completing one bounded batch lets the remaining demand AND old FIFO
 -- advance on the next batch. Manual deletion models successful acks only.
 delete from bid_active_catalog_private.verification where claimed_lease=(c->>'leaseId')::uuid;
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 assert exists(select 1 from jsonb_array_elements(c->'verify') x where x->>'number'='R26FIFO005'),'background FIFO is not chronically starved';
 assert exists(select 1 from jsonb_array_elements(c->'verify') x where x->>'number' like 'R26DEMAND%'),'remaining requested conditions continue automatically';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',c->>'leaseId'));
end $$;

do $$declare n jsonb;r jsonb;definition text;before_queue bigint;begin
 delete from bid_active_catalog_private.verification;delete from bid_active_catalog_private.deadline_index;delete from bid_active_catalog_private.groups;
 n:=pg_temp.priority_notice('R26REGIONUNKNOWN','용역')||'{"allowedRegions":[],"licenses":[]}'::jsonb;
 perform pg_temp.priority_seed(n);
 perform public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.priority_query('{"type":"용역"}'));
 assert (select search_requested_at is not null from bid_active_catalog_private.verification where number='R26REGIONUNKNOWN'),'unknown service region/license is demanded even with exclude unknown enabled';
 update bid_active_catalog_private.verification set search_requested_at=null;
 -- Simulated physical post-flight overflow rolls back ALL demand writes,
 -- including queue insertion, but does not turn the existing read into 503.
 delete from bid_active_catalog_private.verification;
 select pg_get_functiondef('bid_active_catalog_private.storage_bytes()'::regprocedure) into definition;
 execute $def$create or replace function bid_active_catalog_private.storage_bytes() returns bigint language sql stable security invoker set search_path='' as $body$
 select case when exists(select 1 from bid_active_catalog_private.verification where search_requested_at is not null) then 16777216::bigint else 0::bigint end$body$ $def$;
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.priority_query('{"type":"용역"}'));
 execute definition;
 assert r->>'totalCount'='0' and r->>'pendingCount'='1','storage pressure still returns honest verified search';
 assert not exists(select 1 from bid_active_catalog_private.verification),'post-flight overflow rolls back queue and ranking';
 -- Other helper failures have the same best-effort savepoint semantics.
 execute $def$create function pg_temp.reject_priority() returns trigger language plpgsql as $body$begin raise exception 'fixture demand failure';end$body$ $def$;
 create trigger fixture_reject_priority before insert or update on bid_active_catalog_private.verification for each row execute function pg_temp.reject_priority();
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.priority_query('{"type":"용역"}'));
 drop trigger fixture_reject_priority on bid_active_catalog_private.verification;
 assert r->>'pendingCount'='1' and not exists(select 1 from bid_active_catalog_private.verification),'ranking failure cannot fail valid result reads';
end $$;

do $$declare r jsonb;requested integer;gen bigint;first_stamp timestamptz;c jsonb;begin
 delete from bid_active_catalog_private.verification;delete from bid_active_catalog_private.deadline_index;
 for i in 1..135 loop perform pg_temp.priority_seed(pg_temp.priority_notice('R26BOUND'||lpad(i::text,3,'0')));end loop;
 select search_generation into gen from bid_active_catalog_private.runtime where singleton;
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.priority_query('{"type":"공사·용역","keyword":"","filters":{}}'));
 assert not exists(select 1 from bid_active_catalog_private.verification),'unfiltered catalog landing does not flood demand before focused queries';
 assert (select search_generation=gen from bid_active_catalog_private.runtime where singleton),'skipped whole-catalog demand leaves generation unchanged';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.priority_query());
 select count(*) into requested from bid_active_catalog_private.verification where search_requested_at is not null;
 assert requested=100,'one read adds at most one hundred demand ranks';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.priority_query());
 assert (select count(*)=135 from bid_active_catalog_private.verification where search_requested_at is not null),'subsequent demand progresses beyond first hundred without duplicating work';
 select search_requested_at into first_stamp from bid_active_catalog_private.verification where number='R26BOUND001';
 -- This candidate was included by a broader prior query. A different focused
 -- condition is not a duplicate and should move it ahead immediately.
 update bid_active_catalog_private.verification set search_requested_at=now()-interval '1 minute';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.priority_query('{"keyword":"R26BOUND135","filters":{"keyword":""}}'));
 assert (select search_requested_at>now()-interval '10 seconds' from bid_active_catalog_private.verification where number='R26BOUND135'),'different focused demand is not throttled by earlier broad demand';
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 assert c#>>'{verify,0,number}'='R26BOUND135','new focused query is first before earlier demand and tracked rows';
 assert jsonb_array_length(c->'verify')=16,'demand hash does not increase claim capacity';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',c->>'leaseId'));
end $$;
rollback;
