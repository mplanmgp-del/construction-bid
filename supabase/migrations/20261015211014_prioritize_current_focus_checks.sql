-- Verify actionable demolition-related candidates before unrelated backlog.
-- Notice hints are discovery facts; existing version checks still govern reuse.
begin;
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
   select facts.*,
     (case when bid_active_catalog_private.clean_search_text(notice->>'title') ~ '철거|해체|석면|건설폐기물'
        and bid_active_catalog_private.safe_time(notice->>'deadline')>p_stamp
        and bid_active_catalog_private.phase(notice,p_stamp) in ('마감 임박','진행중')
       then -10 else 0 end) + bid_active_catalog_private.collection_priority(notice,p_stamp) urgency,
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
   ||case when d.notice is not null
     then jsonb_build_object('notice',d.notice) else '{}'::jsonb end order by chosen.ordinal),'[]'::jsonb)
 into versions from unnest(selected_keys) with ordinality chosen(key,ordinal)
 join bid_active_catalog_private.verification v on v.type||':'||v.number=chosen.key and v.claimed_lease=p_lease and v.scope_version=p_scope
 left join bid_active_catalog_private.deadline_index d using(type,number);
 return versions;
end $$;
revoke all on function bid_active_catalog_private.prioritize_search_verification(uuid,text,timestamptz) from public,anon,authenticated;
commit;
