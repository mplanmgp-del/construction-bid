-- Disposable tests: urgent and current public notices must precede old backlog.
begin;
update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8'));
update bid_active_catalog_private.runtime set scope_version=bid_active_catalog_private.scope_version(),lease_id=null,lease_until=null,retry_after_at=null,storage_blocked=false;
create function pg_temp.action_notice(p_number text,p_phase text,p_close interval,p_posted text default '2026-10-01T00:00:00+09:00')
returns jsonb language sql as $$
 select jsonb_build_object('id','g2b:공사:'||p_number||':000','type','공사','number',p_number,'revision','000',
 'title','철거 공사 '||p_number,'agency','공공 기관','category','철거·해체','province','서울특별시','district','강남구',
 'postedAt',p_posted,'sourceUpdatedAt',now()-interval '1 minute','biddingStartAt',
 case when p_phase='scheduled' then now()+interval '1 day' else now()-interval '1 day' end,
 'deadline',now()+p_close,'openingAt',now()+interval '60 days','status','접수중','source','live',
 'licenses',jsonb_build_array(),'allowedRegions',null,'regionComplete',false,'licenseComplete',false,
 'contractMethod','제한경쟁','estimatedPrice',100000000);
$$;
create function pg_temp.action_seed(n jsonb) returns void language sql as $$
 insert into bid_active_catalog_private.deadline_index(type,number,revision,notice,source_updated_at,deadline,opening_at,source_version)
 values('공사',n->>'number',0,bid_active_catalog_private.compact(n),(n->>'sourceUpdatedAt')::timestamptz,
 (n->>'deadline')::timestamptz,(n->>'openingAt')::timestamptz,bid_active_catalog_private.source_version(bid_active_catalog_private.compact(n)));
$$;

do $$declare c jsonb;ids text[];begin
 delete from bid_active_catalog_private.verification;delete from bid_active_catalog_private.deadline_index;delete from bid_active_catalog_private.groups;
 perform pg_temp.action_seed(pg_temp.action_notice('R26URGENT_NEAR','urgent',interval '2 hours'));
 perform pg_temp.action_seed(pg_temp.action_notice('R26URGENT_LATER','urgent',interval '20 hours'));
 perform pg_temp.action_seed(pg_temp.action_notice('R26ACTIVE_OLD','active',interval '4 days','1995-10-02T00:00:00+09:00'));
 perform pg_temp.action_seed(pg_temp.action_notice('R26ACTIVE_NEW','active',interval '4 days','2026-10-15T00:00:00+09:00'));
 perform pg_temp.action_seed(pg_temp.action_notice('R26WAITING','active',interval '-1 day'));
 perform pg_temp.action_seed(pg_temp.action_notice('R26SCHEDULED','scheduled',interval '30 days'));
 perform bid_active_catalog_private.queue_search_verification();
 update bid_active_catalog_private.verification set search_requested_at=now() where number in ('R26SCHEDULED','R26WAITING','R26URGENT_LATER');
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 select array_agg(item->>'number' order by ord) into ids from jsonb_array_elements(c->'verify') with ordinality x(item,ord);
 assert ids=array['R26URGENT_NEAR','R26URGENT_LATER','R26ACTIVE_NEW','R26ACTIVE_OLD','R26WAITING','R26SCHEDULED'],
   'verification must prioritize urgent, actionable ongoing, opening-wait, then scheduled; newest wins equal deadlines';
 assert exists(select 1 from jsonb_array_elements(c->'verify') x where x->>'number'='R26ACTIVE_OLD'),'an old posted ongoing notice is retained';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',c->>'leaseId'));
end $$;

do $$declare c jsonb;scope text:=bid_active_catalog_private.scope_version();total_before bigint;begin
 delete from bid_active_catalog_private.verification;delete from bid_active_catalog_private.deadline_index;delete from bid_active_catalog_private.groups;
 for i in 1..24 loop
   perform pg_temp.action_seed(pg_temp.action_notice('R26BACKLOG'||lpad(i::text,3,'0'),'active',interval '4 days'));
 end loop;
 for i in 1..10 loop perform pg_temp.action_seed(pg_temp.action_notice('R26URGENT'||lpad(i::text,3,'0'),'urgent',interval '6 hours'));end loop;
 perform bid_active_catalog_private.queue_search_verification();
 update bid_active_catalog_private.verification set queued_at=now()-interval '30 days',search_requested_at=now() where number like 'R26BACKLOG%';
 -- A high priority item cannot skip its existing retry delay.
 update bid_active_catalog_private.verification set next_attempt=now()+interval '1 hour',failures=3 where number='R26URGENT010';
 select count(*) into total_before from bid_active_catalog_private.verification;
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 assert jsonb_array_length(c->'verify')=16,'same bounded claim capacity';
 assert (select count(*)=9 from jsonb_array_elements(c->'verify') with ordinality x(item,ord) where ord<=9 and item->>'number' like 'R26URGENT%'),
   'urgent unrequested notices cannot be displaced by requested ongoing backlog';
 assert not exists(select 1 from jsonb_array_elements(c->'verify') x where x->>'number'='R26URGENT010'),'urgency preserves retry backoff';
 assert (select count(*)=total_before from bid_active_catalog_private.verification),'reprioritization retains all pending work';
 assert (select count(*)=16 from bid_active_catalog_private.verification where claimed_lease=(c->>'leaseId')::uuid),'only selected jobs hold the existing lease';
 assert exists(select 1 from jsonb_array_elements(c->'verify') x where x->>'number' like 'R26BACKLOG%'),'background work still gets bounded reserved slots';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',c->>'leaseId'));
end $$;

do $$declare r jsonb;begin
 delete from bid_active_catalog_private.verification;delete from bid_active_catalog_private.deadline_index;delete from bid_active_catalog_private.groups;
 -- Raw deadline order would consume all 100 demand marks on submission-closed rows.
 for i in 1..105 loop perform pg_temp.action_seed(pg_temp.action_notice('R26PAST'||lpad(i::text,3,'0'),'active',interval '-1 day'));end loop;
 perform pg_temp.action_seed(pg_temp.action_notice('R26URGENT_DEMAND','urgent',interval '3 hours'));
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',jsonb_build_object('type','공사','from','1995-10-01','to','2100-12-31','keyword','철거','filters','{}'::jsonb,'limit',50));
 assert r->>'totalCount'='0' and r->>'pendingCount'='106','priority cannot publish unverified candidates';
 assert (select search_requested_at is not null from bid_active_catalog_private.verification where number='R26URGENT_DEMAND'),'first search marks urgent before older opening-wait backlog';
 assert (select count(*)=100 from bid_active_catalog_private.verification where search_requested_at is not null),'one search retains its hundred-candidate cap';
 assert not has_function_privilege('anon','bid_active_catalog_private.prioritize_search_verification(uuid,text,timestamptz)','execute'),'helper stays private';
 assert (select storage_ceiling=16777216 from bid_active_catalog_private.runtime),'catalog storage cap unchanged';
end $$;
rollback;
