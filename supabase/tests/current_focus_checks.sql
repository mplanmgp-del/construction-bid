begin;
update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8'));
update bid_active_catalog_private.runtime set scope_version=bid_active_catalog_private.scope_version(),lease_id=null,lease_until=null,retry_after_at=null,storage_blocked=false;
create function pg_temp.focus_seed(p_number text,p_title text,p_deadline interval,p_start interval default interval '-1 day') returns void language plpgsql as $$
declare n jsonb;begin
 n:=jsonb_build_object('id','g2b:공사:'||p_number||':000','type','공사','number',p_number,'revision','000','title',p_title,
 'agency','공공 기관','category','기타','province','서울특별시','district','강남구','postedAt','2001-01-01T00:00:00+09:00',
 'sourceUpdatedAt',now()-interval '1 minute','biddingStartAt',now()+p_start,'deadline',now()+p_deadline,'openingAt',now()+interval '30 days',
 'status','접수중','source','live','licenses','[]'::jsonb,'allowedRegions',null,'regionComplete',false,'licenseComplete',false,'contractMethod','제한경쟁','estimatedPrice',100000000);
 insert into bid_active_catalog_private.deadline_index(type,number,revision,notice,source_updated_at,deadline,opening_at,source_version)
 values('공사',p_number,0,bid_active_catalog_private.compact(n),(n->>'sourceUpdatedAt')::timestamptz,(n->>'deadline')::timestamptz,(n->>'openingAt')::timestamptz,bid_active_catalog_private.source_version(bid_active_catalog_private.compact(n)));
end $$;
do $$declare c jsonb;ids text[];before_count bigint;begin
 delete from bid_active_catalog_private.verification;delete from bid_active_catalog_private.deadline_index;delete from bid_active_catalog_private.groups;
 for i in 1..24 loop perform pg_temp.focus_seed('R26OTHER'||lpad(i::text,3,'0'),'도로 정비 공사',interval '1 hour');end loop;
 perform pg_temp.focus_seed('R26FOCUSURGENT','건물 철거공사',interval '8 hours');
 perform pg_temp.focus_seed('R26FOCUSASBESTOS','학교 석면 제거',interval '4 days');
 perform pg_temp.focus_seed('R26FOCUSDEMOLITION','시설 해체 용역',interval '3 days');
 perform pg_temp.focus_seed('R26FOCUSWASTE','건설폐기물 처리',interval '2 days');
 perform pg_temp.focus_seed('R26FOCUSWAITING','철거공사 개찰 대기',interval '-1 day');
 perform pg_temp.focus_seed('R26FOCUSPLANNED','철거공사 예정',interval '20 days',interval '1 day');
 perform bid_active_catalog_private.queue_search_verification();
 select count(*) into before_count from bid_active_catalog_private.verification;
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 select array_agg(n->>'number' order by ord) into ids from jsonb_array_elements(c->'verify') with ordinality x(n,ord) where ord<=4;
 assert ids=array['R26FOCUSURGENT','R26FOCUSWASTE','R26FOCUSDEMOLITION','R26FOCUSASBESTOS'],'actionable interest fields precede unrelated backlog; urgent then deadline';
 assert c#>>'{verify,0,notice,title}'='건물 철거공사','claim includes public source hint before participant verification';
 assert c#>>'{verify,0,notice,regionComplete}'='false' and c#>>'{verify,0,notice,licenseComplete}'='false','source hint cannot turn incomplete conditions into complete ones';
 assert not exists(select 1 from bid_active_catalog_private.deadline_index where verified_at is not null),'priority never publishes unverified source hints';
 assert (select count(*)=before_count from bid_active_catalog_private.verification),'unselected unrelated and planned work retained';
 assert jsonb_array_length(c->'verify')=16,'existing claim capacity preserved';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',c->>'leaseId'));
end $$;
rollback;
