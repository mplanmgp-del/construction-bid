-- Prefer usable current notices over an old verification backlog. No new
-- discovery range, external API, provider budget or retention limit.
begin;
create or replace function bid_active_catalog_private.collection_priority(p_notice jsonb,p_stamp timestamptz)
returns integer language sql stable security invoker set search_path='' as $$
 select case bid_active_catalog_private.phase(p_notice,p_stamp)
   when '마감 임박' then 0
   when '진행중' then case when bid_active_catalog_private.safe_time(p_notice->>'deadline')>p_stamp then 1 else 2 end
   when '예정' then 3 else 4 end;
$$;

create or replace function bid_active_catalog_private.prioritize_search_verification(p_lease uuid,p_scope text,p_stamp timestamptz)
returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare selected_keys text[];versions jsonb;
begin
 -- Eight current/urgent candidates plus four FIFO and four tracked reserves.
 -- Status precedes search demand; older postings remain eligible if ongoing.
 with facts as materialized (
   select v.*,v.type||':'||v.number key,
     exists(select 1 from bid_active_catalog_private.known_heads() k where k.type=v.type and k.number=v.number) tracked,
     case when g.revision>d.revision or g.revision=d.revision and g.source_updated_at>d.source_updated_at
       then g.latest else coalesce(d.notice,g.latest,'{}'::jsonb) end notice
   from bid_active_catalog_private.verification v
   left join bid_active_catalog_private.deadline_index d using(type,number)
   left join bid_active_catalog_private.groups g using(type,number)
   where v.scope_version=p_scope and v.next_attempt<=p_stamp
 ),eligible as materialized (
   select facts.*,bid_active_catalog_private.collection_priority(notice,p_stamp) urgency,
     bid_active_catalog_private.safe_time(notice->>'deadline') closes_at,
     bid_active_catalog_private.safe_time(notice->>'postedAt') posted_at from facts
 ),current_work as materialized (
   select key,1 bucket,urgency,closes_at,posted_at,search_requested_at,queued_at from eligible
   order by urgency,closes_at nulls last,(search_requested_at is null),posted_at desc nulls last,search_requested_at desc nulls last,queued_at,type,number limit 8
 ),fifo as materialized (
   select key,2 bucket,urgency,closes_at,posted_at,search_requested_at,queued_at from eligible where key not in(select key from current_work)
   order by queued_at,type,number limit 4
 ),tracked as materialized (
   select key,3 bucket,urgency,closes_at,posted_at,search_requested_at,queued_at from eligible where tracked
     and key not in(select key from current_work union all select key from fifo)
   order by urgency,closes_at nulls last,posted_at desc nulls last,queued_at,type,number limit 4
 ),reserved as materialized (
   select * from current_work union all select * from fifo union all select * from tracked
 ),spill as (
   select key,4 bucket,urgency,closes_at,posted_at,search_requested_at,queued_at from eligible where key not in(select key from reserved)
   order by urgency,closes_at nulls last,(search_requested_at is null),posted_at desc nulls last,search_requested_at desc nulls last,queued_at,type,number
   limit greatest(0,16-(select count(*) from reserved))
 ) select coalesce(array_agg(key order by urgency,closes_at nulls last,posted_at desc nulls last,bucket,search_requested_at desc nulls last,queued_at,key),'{}'::text[]) into selected_keys
 from(select * from reserved union all select * from spill) selected;
 -- The base worker holds the existing runtime and shared-alert locks.
 -- Preserve every unselected row, source version, retry delay and counter.
 update bid_active_catalog_private.verification set claimed_lease=null
 where claimed_lease=p_lease and not(type||':'||number=any(selected_keys));
 update bid_active_catalog_private.verification set claimed_lease=p_lease
 where scope_version=p_scope and type||':'||number=any(selected_keys);
 select coalesce(jsonb_agg(jsonb_build_object('type',v.type,'number',v.number,'revision',lpad(v.revision::text,3,'0'),
   'sourceUpdatedAt',v.source_updated_at,'tracked',exists(select 1 from bid_active_catalog_private.known_heads() k where k.type=v.type and k.number=v.number))
   ||case when d.verified_at is not null and d.source_version=d.verified_version and d.revision=v.revision and d.source_updated_at=v.source_updated_at
     then jsonb_build_object('notice',d.notice) else '{}'::jsonb end order by chosen.ordinal),'[]'::jsonb)
 into versions from unnest(selected_keys) with ordinality chosen(key,ordinal)
 join bid_active_catalog_private.verification v on v.type||':'||v.number=chosen.key and v.claimed_lease=p_lease and v.scope_version=p_scope
 left join bid_active_catalog_private.deadline_index d using(type,number);
 return versions;
end $$;

-- Keep the demand function's validation, throttling, cap, rollback savepoint
-- and publication separation intact; only its first hundred choices change.
do $$declare definition text;old_order text:='order by v.search_requested_at nulls first,v.queued_at nulls first,d.deadline,d.type,d.number limit 100';begin
 select pg_get_functiondef('bid_active_catalog_private.request_search_verification(jsonb)'::regprocedure) into definition;
 if position('bid_active_catalog_private.collection_priority(d.notice,stamp)' in definition)=0 then
   if position(old_order in definition)=0 then raise exception 'Search demand order anchor missing';end if;
   definition:=replace(definition,old_order,
     'order by bid_active_catalog_private.collection_priority(d.notice,stamp),d.deadline,bid_active_catalog_private.safe_time(d.notice->>''postedAt'') desc nulls last,v.search_requested_at nulls first,v.queued_at nulls first,d.type,d.number limit 100');
   execute definition;
 end if;
end $$;
revoke all on function bid_active_catalog_private.collection_priority(jsonb,timestamptz) from public,anon,authenticated;
revoke all on function bid_active_catalog_private.prioritize_search_verification(uuid,text,timestamptz) from public,anon,authenticated;
do $$begin
 if bid_active_catalog_private.storage_bytes()>=16777216 or bid_alert_private.storage_bytes()>=33554432 then
   raise exception using errcode='54000',message='Existing storage budget cannot fit priority functions';end if;
end $$;
commit;
