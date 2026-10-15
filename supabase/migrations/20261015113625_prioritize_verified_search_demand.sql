-- A valid search can request bounded verification of its possible matches.
-- No new public RPC, notice bodies, role grants or storage budgets.
begin;
alter table bid_active_catalog_private.verification add column if not exists search_requested_at timestamptz;
alter table bid_active_catalog_private.verification add column if not exists search_request_key text;
create index if not exists bid_catalog_search_requested on bid_active_catalog_private.verification(search_requested_at,queued_at,type,number)
 where search_requested_at is not null;

create or replace function bid_active_catalog_private.request_search_verification(p_payload jsonb)
returns integer language plpgsql volatile security invoker set search_path='' as $$
declare f jsonb;profile jsonb;heads jsonb;new_heads jsonb;scope text;request_key text;stamp timestamptz:=clock_timestamp();needed bigint;requested integer;
 cfg bid_active_catalog_private.runtime%rowtype;business text:=coalesce(p_payload->>'type','공사·용역');title_keyword text;
begin
 -- Called only AFTER search_page has validated this same payload. First-page
 -- demand does not change the page's MVCC snapshot or search generation.
 if coalesce(p_payload->>'cursor','')<>'' then return 0;end if;
 select * into strict cfg from bid_active_catalog_private.runtime where singleton;
 if cfg.storage_blocked or bid_active_catalog_private.storage_bytes()+65536>=cfg.storage_ceiling
   or bid_alert_private.storage_bytes()+65536>=33554432 then return 0;end if;
 scope:=bid_active_catalog_private.scope_version();
 f:='{"keyword":"","excludeKeyword":"","category":"전체","type":"전체","siteProvince":"전체","license":"전체","minAmount":"","maxAmount":"","status":"전체","contractMethod":"전체","deadlineFrom":"","deadlineTo":"","regionView":"all","autoRegion":false,"sort":"deadline"}'::jsonb||coalesce(p_payload->'filters','{}'::jsonb);
 if not (p_payload->'filters'?'keyword') then f:=f||jsonb_build_object('keyword',coalesce(p_payload->>'keyword',''));end if;
 profile:=coalesce(p_payload->'profile','{}'::jsonb);
 title_keyword:=lower(bid_active_catalog_private.clean_search_text(p_payload->>'keyword'));
 -- The default whole-catalog read must not flood the demand lane before a
 -- later focused lookup. Normal FIFO still verifies every such candidate.
 if business='공사·용역' and title_keyword='' and coalesce(f->>'keyword','')='' and coalesce(f->>'excludeKeyword','')=''
   and f->>'category'='전체' and f->>'type'='전체' and f->>'siteProvince'='전체' and f->>'license'='전체'
   and f->>'minAmount'='' and f->>'maxAmount'='' and f->>'status'='전체' and f->>'contractMethod'='전체'
   and f->>'deadlineFrom'='' and f->>'deadlineTo'='' and f->>'regionView'='all' and f->>'autoRegion'='false'
   and (not(f?'regions') or jsonb_array_length(f->'regions')=0) and (not(f?'statuses') or jsonb_array_length(f->'statuses')=0) then return 0;end if;
 request_key:=encode(sha256(convert_to(jsonb_build_object('type',business,'from',p_payload->'from','to',p_payload->'to',
   'keyword',title_keyword,'filters',f,'profile',profile)::text,'UTF8')),'hex');
 select coalesce(jsonb_agg(jsonb_build_object('type',q.type,'number',q.number)),'[]'::jsonb),
   coalesce(jsonb_agg(jsonb_build_object('type',q.type,'number',q.number)) filter(where not q.queued),'[]'::jsonb),count(*) filter(where not q.queued)
 into heads,new_heads,needed from (
   select d.type,d.number,v.number is not null queued
   from bid_active_catalog_private.deadline_index d
   left join bid_active_catalog_private.verification v using(type,number)
   where (d.verified_at is null or d.source_version is distinct from d.verified_version)
     and (business='공사·용역' or d.type=business)
     and (title_keyword='' or strpos(lower(bid_active_catalog_private.clean_search_text(d.notice->>'title')),title_keyword)>0)
     and d.deadline>=((p_payload->>'from')::date::timestamp at time zone 'Asia/Seoul')
     and d.deadline<(((p_payload->>'to')::date+1)::timestamp at time zone 'Asia/Seoul')
     and isfinite(d.deadline) and (d.deadline>stamp or d.opening_at>stamp)
     and (d.opening_at is null or isfinite(d.opening_at) and d.opening_at>stamp)
     and d.notice->>'status' is distinct from '취소' and coalesce(d.notice->>'noticeKind','') not like '%취소%'
     and d.notice->>'openingCompleted' is distinct from 'true'
     and not exists(select 1 from bid_active_catalog_private.deadline_invalidations h where h.type=d.type and h.number=d.number
       and (h.revision>d.revision or h.revision=d.revision and h.source_updated_at>=d.source_updated_at))
     and not exists(select 1 from bid_active_catalog_private.groups g where g.type=d.type and g.number=d.number
       and (g.revision>d.revision or g.revision=d.revision and g.source_updated_at>=d.source_updated_at)
       and not bid_active_catalog_private.ongoing(g.latest,stamp))
     -- This is a POSSIBLE-match prefilter, never a publication decision.
     -- Missing participant facts remain pending in the existing matcher;
     -- missing general facts must not prevent their verification either.
     and bid_active_catalog_private.search_match(d.notice,f
       ||case when jsonb_typeof(d.notice->'estimatedPrice') is distinct from 'number' then '{"minAmount":"","maxAmount":""}'::jsonb else '{}'::jsonb end
       ||case when coalesce(d.notice->>'category','')='' then '{"category":"전체"}'::jsonb else '{}'::jsonb end
       ||case when coalesce(d.notice->>'contractMethod','')='' then '{"contractMethod":"전체"}'::jsonb else '{}'::jsonb end,
       profile,stamp)<>'excluded'
     and (v.search_requested_at is null or v.search_request_key is distinct from request_key or v.search_requested_at<=stamp-interval '10 minutes')
   order by v.search_requested_at nulls first,v.queued_at nulls first,d.deadline,d.type,d.number limit 100
 ) q;
 if jsonb_array_length(heads)=0 or bid_active_catalog_private.storage_bytes()+needed*1536+65536>=cfg.storage_ceiling
   or bid_alert_private.storage_bytes()+needed*1536+65536>=33554432 then return 0;end if;
 -- Existing queue rows retain their lease, source version and retry state.
 -- DO NOTHING also covers a worker inserting a selected new head between
 -- the candidate read above and this insert; the general queue helper's
 -- ON CONFLICT update could otherwise clear that worker's new lease.
 insert into bid_active_catalog_private.verification(type,number,revision,source_updated_at,scope_version,source_version)
 select d.type,d.number,d.revision,d.source_updated_at,scope,d.source_version
 from bid_active_catalog_private.deadline_index d
 where exists(select 1 from jsonb_array_elements(new_heads) n where n->>'type'=d.type and n->>'number'=d.number)
 on conflict(type,number) do nothing;
 update bid_active_catalog_private.verification v set search_requested_at=stamp,search_request_key=request_key
 where v.scope_version=scope and (v.search_requested_at is null or v.search_request_key is distinct from request_key or v.search_requested_at<=stamp-interval '10 minutes')
   and exists(select 1 from jsonb_array_elements(heads) n where n->>'type'=v.type and n->>'number'=v.number);
 get diagnostics requested=row_count;
 if bid_active_catalog_private.storage_bytes()+65536>=cfg.storage_ceiling or bid_alert_private.storage_bytes()+65536>=33554432 then
   raise exception using errcode='54000',message='Search demand exceeds existing capacity';end if;
 return requested;
exception when others then
 -- Ranking is best effort. Its savepoint rolls back all queue writes on any
 -- failure, while a valid read still returns its verified search results.
 return 0;
end $$;

create or replace function bid_active_catalog_private.prioritize_search_verification(p_lease uuid,p_scope text,p_stamp timestamptz)
returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare selected_keys text[];versions jsonb;
begin
 -- Eight requested possible matches are first even if the HTTP worker can
 -- process only the first few. Four FIFO slots guarantee background progress;
 -- four tracked slots retain change/near-opening checks. Empty slots spill.
 with eligible as materialized (
   select v.*,v.type||':'||v.number key,
     exists(select 1 from bid_active_catalog_private.known_heads() k where k.type=v.type and k.number=v.number) tracked
   from bid_active_catalog_private.verification v where v.scope_version=p_scope and v.next_attempt<=p_stamp
 ),demand as materialized (
   select key,1 bucket,search_requested_at priority,queued_at from eligible where search_requested_at is not null
   order by search_requested_at desc,queued_at,type,number limit 8
 ),fifo as materialized (
   select key,2 bucket,queued_at priority,queued_at from eligible where key not in(select key from demand)
   order by queued_at,type,number limit 4
 ),tracked as materialized (
   select key,3 bucket,queued_at priority,queued_at from eligible where tracked
     and key not in(select key from demand union all select key from fifo)
   order by queued_at,type,number limit 4
 ),reserved as materialized (
   select * from demand union all select * from fifo union all select * from tracked
 ),spill as (
   select key,4 bucket,queued_at priority,queued_at from eligible where key not in(select key from reserved)
   order by queued_at,type,number limit greatest(0,16-(select count(*) from reserved))
 ) select coalesce(array_agg(key order by bucket,case when bucket=1 then -extract(epoch from priority) else extract(epoch from priority) end,queued_at,key),'{}'::text[]) into selected_keys
 from(select * from reserved union all select * from spill) selected;
 -- Reorder the base worker's lease-owned choices without deleting any queue
 -- entry. No active foreign lease can exist: the caller holds runtime's lock.
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

-- Retain the complete audited token, scope, source lease, write, generation
-- and budget guards in the existing worker. Assert anchors before patching.
do $$declare definition text;old_claim text;new_claim text;begin
 select pg_get_functiondef('public.bid_active_catalog_worker(text,text,jsonb)'::regprocedure) into definition;
 if position('bid_active_catalog_private.request_search_verification(p_payload)' in definition)=0 then
   if position('if p_action=''search_page'' then return bid_active_catalog_private.search_page(p_payload);end if;' in definition)=0 then
     raise exception 'Verified search demand guard anchor missing';end if;
   definition:=replace(definition,
     'if p_action=''search_page'' then return bid_active_catalog_private.search_page(p_payload);end if;',
     'if p_action=''search_page'' then outcome:=bid_active_catalog_private.search_page(p_payload);perform bid_active_catalog_private.request_search_verification(p_payload);return outcome;end if;');
 end if;
 if position('bid_active_catalog_private.prioritize_search_verification(lease,' in definition)=0 then
   old_claim:=substring(definition from position('     -- Eight existing known heads' in definition)
     for position('     update bid_active_catalog_private.runtime set storage_blocked=false' in definition)-position('     -- Eight existing known heads' in definition));
   if coalesce(length(old_claim),0)=0 or position('into versions from bid_active_catalog_private.verification' in old_claim)=0 then
     raise exception 'Verified claim priority guard anchor missing';end if;
   new_claim:='     versions:=bid_active_catalog_private.prioritize_search_verification(lease,outcome->>''scopeVersion'',stamp);'||chr(10);
   definition:=replace(definition,old_claim,new_claim);
 end if;
 execute definition;
end $$;

revoke all on function bid_active_catalog_private.request_search_verification(jsonb) from public,anon,authenticated;
revoke all on function bid_active_catalog_private.prioritize_search_verification(uuid,text,timestamptz) from public,anon,authenticated;
do $$begin
 if bid_active_catalog_private.storage_bytes()>=16777216 or bid_alert_private.storage_bytes()>=33554432 then
   raise exception using errcode='54000',message='Existing storage budget cannot fit search priority metadata';end if;
end $$;
commit;
