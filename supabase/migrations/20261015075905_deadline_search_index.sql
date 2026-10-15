-- One compact public candidate index, independent of personal alarm filters.
-- All rows remain within the EXISTING 16 MiB catalog / 32 MiB alert budgets.
begin;
create table if not exists bid_active_catalog_private.deadline_index (
 type text not null check(type in ('공사','용역')),number text not null check(number~'^[A-Za-z0-9_-]{1,40}$'),
 revision integer not null check(revision between 0 and 999),notice jsonb not null check(octet_length(notice::text)<=4096),
 source_updated_at timestamptz not null,deadline timestamptz not null,opening_at timestamptz,
 indexed_at timestamptz not null default clock_timestamp(),verified_at timestamptz,primary key(type,number)
);
create index if not exists bid_deadline_index_range on bid_active_catalog_private.deadline_index(type,deadline,number);
create index if not exists bid_deadline_index_changes on bid_active_catalog_private.deadline_index(indexed_at,type,number);
-- Only previously retained candidates need an invalidation watermark. Closed
-- rows that were never relevant contribute no ledger record or raw body.
create table if not exists bid_active_catalog_private.deadline_invalidations (
 type text not null check(type in ('공사','용역')),number text not null,revision integer not null check(revision between 0 and 999),
 source_updated_at timestamptz not null,primary key(type,number)
);
create table if not exists bid_active_catalog_private.index_batches (
 source_id text not null references bid_active_catalog_private.sources(id) on delete cascade,
 page integer not null check(page>0),batch integer not null check(batch between 0 and 4),
 batches integer not null check(batches between 1 and 5),primary key(source_id,page,batch),check(batch<batches)
);
alter table bid_active_catalog_private.deadline_index enable row level security;
alter table bid_active_catalog_private.index_batches enable row level security;
alter table bid_active_catalog_private.deadline_invalidations enable row level security;
revoke all on bid_active_catalog_private.deadline_index,bid_active_catalog_private.index_batches,bid_active_catalog_private.deadline_invalidations from public,anon,authenticated;

create or replace function bid_active_catalog_private.scope_version()
returns text language sql immutable security invoker set search_path='' as $$
 select encode(sha256(convert_to('shared-deadline-index-v1','UTF8')),'hex');
$$;

-- Match the UI's schedule phases: a passed submission deadline can still be
-- awaiting a future opening. Missing deadlines never enter this index.
create or replace function bid_active_catalog_private.ongoing(p_notice jsonb,p_now timestamptz default now())
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare closing timestamptz;opening timestamptz;
begin
 if p_notice is null or p_notice->>'status'='취소' or coalesce(p_notice->>'noticeKind','') like '%취소%'
 or p_notice->>'openingCompleted'='true' then return false; end if;
 closing:=nullif(p_notice->>'deadline','')::timestamptz;
 opening:=nullif(p_notice->>'openingAt','')::timestamptz;
 if closing is null or not isfinite(closing) or (opening is not null and (not isfinite(opening) or opening<=p_now)) then return false; end if;
 return closing>p_now or opening>p_now;
exception when invalid_datetime_format or datetime_field_overflow then return false;
end $$;
create or replace function bid_active_catalog_private.active(p_notice jsonb)
returns boolean language sql stable security invoker set search_path='' as $$
 select bid_active_catalog_private.ongoing(p_notice);
$$;
create or replace function bid_active_catalog_private.alarm_active(p_notice jsonb,p_now timestamptz default now())
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare day date;today date:=(p_now at time zone 'Asia/Seoul')::date;current_notice jsonb;
begin
 select q.notice into current_notice from (
   select p_notice notice,coalesce((p_notice->>'revision')::integer,0) revision,nullif(p_notice->>'sourceUpdatedAt','')::timestamptz source_updated_at
   union all select g.latest,g.revision,g.source_updated_at from bid_active_catalog_private.groups g
     where g.type=p_notice->>'type' and g.number=p_notice->>'number'
   union all select d.notice,d.revision,d.source_updated_at from bid_active_catalog_private.deadline_index d
     where d.type=p_notice->>'type' and d.number=p_notice->>'number'
   union all select jsonb_build_object('status','취소'),h.revision,h.source_updated_at from bid_active_catalog_private.deadline_invalidations h
     where h.type=p_notice->>'type' and h.number=p_notice->>'number'
 ) q order by q.revision desc,q.source_updated_at desc nulls last,
   (not bid_active_catalog_private.ongoing(q.notice,p_now)) desc limit 1;
 if not bid_active_catalog_private.ongoing(current_notice,p_now) then return false; end if;
 day:=((current_notice->>'deadline')::timestamptz at time zone 'Asia/Seoul')::date;
 return day between today-7 and today+7;
exception when invalid_datetime_format or datetime_field_overflow then return false;
end $$;
create or replace function bid_active_catalog_private.compact(p_notice jsonb)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare result jsonb;
begin
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into result from jsonb_each(p_notice)
 where key=any(array['id','number','revision','title','agency','demandAgency','type','category','province','district',
 'allowedRegions','estimatedPrice','plannedAmount','contractMethod','status','postedAt','deadline','openingAt',
 'registrationDeadline','biddingStartAt','licenses','specialRegionCondition','revised','source','sourceUpdatedAt',
 'regionComplete','licenseComplete','noticeKind','detailUrl','sourceOmittedDigest','openingCompleted']);
 return result||'{"description":"","duration":"","requirements":[],"documents":[]}'::jsonb;
end $$;

-- Preserve the previous, already verified matches as immediate search seeds.
insert into bid_active_catalog_private.deadline_index(type,number,revision,notice,source_updated_at,deadline,opening_at,indexed_at,verified_at)
select type,number,revision,bid_active_catalog_private.compact(latest),source_updated_at,(latest->>'deadline')::timestamptz,
 nullif(latest->>'openingAt','')::timestamptz,published_at,verified_at from bid_active_catalog_private.groups
where bid_active_catalog_private.ongoing(latest) on conflict do nothing;

-- Keep the mature collection implementation behind a private wrapper. Its
-- coverage scope is now shared, so changing a member filter cannot replay years.
do $$ declare definition text; begin
 if to_regprocedure('bid_active_catalog_private.worker_legacy(text,text,jsonb)') is null then
   alter function public.bid_active_catalog_worker(text,text,jsonb) set schema bid_active_catalog_private;
   alter function bid_active_catalog_private.bid_active_catalog_worker(text,text,jsonb) rename to worker_legacy;
 end if;
 select pg_get_functiondef('bid_active_catalog_private.worker_legacy(text,text,jsonb)'::regprocedure) into definition;
 definition:=replace(definition,' or jsonb_array_length(rule_snapshot)=0 or not auth_cfg.configured',' or not auth_cfg.configured');
 execute definition;
end $$;
revoke all on function bid_active_catalog_private.worker_legacy(text,text,jsonb) from public,anon,authenticated;

create or replace function bid_active_catalog_private.index_coverage()
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('complete',count(*)>0 and count(*) filter(where completed_at is null)=0,
 'pending',count(*) filter(where completed_at is null),'checked',count(*) filter(where completed_at is not null))
 from bid_active_catalog_private.sources where scope_version=bid_active_catalog_private.scope_version() and kind='history';
$$;

create or replace function public.bid_active_catalog_worker(p_token text,p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare auth_cfg bid_alert_private.runtime%rowtype;cfg bid_active_catalog_private.runtime%rowtype;
 stamp timestamptz:=clock_timestamp();lease uuid;job bid_active_catalog_private.sources%rowtype;
 entry jsonb;n jsonb;head jsonb;versions jsonb;prior bid_active_catalog_private.groups%rowtype;indexed bid_active_catalog_private.deadline_index%rowtype;
 typ text;number_value text;revision_value integer;source_time timestamptz;closing timestamptz;opening timestamptz;cost bigint;
 first_day date;last_day date;today date;requested_now timestamptz;page_value integer;size_value integer;limit_value integer;
 keyword_value text;cursor_value text;next_cursor text;items jsonb;rows_value jsonb;coverage jsonb;total bigint;ids text[];outcome jsonb;
begin
 select * into strict auth_cfg from bid_alert_private.runtime where singleton;
 if p_token is null or length(p_token) not between 43 and 128 or auth_cfg.token_hash is null
 or sha256(convert_to(p_token,'UTF8')) is distinct from auth_cfg.token_hash then
 raise exception using errcode='42501',message='공고 수집 작업 인증에 실패했습니다.'; end if;
 if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>2800000 then
 raise exception using errcode='22023',message='공고 색인 요청 형식을 확인해 주세요.'; end if;

 if p_action='deadline_page' then
   if coalesce(p_payload->>'from','')!~'^\d{4}-\d{2}-\d{2}$' or coalesce(p_payload->>'to','')!~'^\d{4}-\d{2}-\d{2}$'
   or coalesce(p_payload->>'type','') not in ('공사','용역') then raise exception using errcode='22023',message='마감 기간과 업무 구분을 확인해 주세요.'; end if;
   first_day:=(p_payload->>'from')::date;last_day:=(p_payload->>'to')::date;
   page_value:=coalesce((p_payload->>'page')::integer,1);size_value:=coalesce((p_payload->>'pageSize')::integer,100);
   keyword_value:=btrim(coalesce(p_payload->>'keyword',''));requested_now:=stamp;
   if first_day>last_day or last_day-first_day>366 or page_value not between 1 and 100000 or size_value not between 1 and 100
   or length(keyword_value)>120 or keyword_value~'[[:cntrl:]]' then raise exception using errcode='22023',message='마감 조회 범위를 확인해 주세요.'; end if;
   if p_payload?'now' then requested_now:=to_timestamp((p_payload->>'now')::double precision/1000); end if;
   if not isfinite(requested_now) then raise exception 'Invalid query clock'; end if;
   select count(*) into total from bid_active_catalog_private.deadline_index d where d.type=p_payload->>'type'
   and d.deadline>=first_day::timestamp at time zone 'Asia/Seoul' and d.deadline<(last_day+1)::timestamp at time zone 'Asia/Seoul'
   and bid_active_catalog_private.ongoing(d.notice,requested_now)
   and not exists(select 1 from bid_active_catalog_private.groups g where g.type=d.type and g.number=d.number
     and (g.revision>d.revision or g.revision=d.revision and g.source_updated_at>=d.source_updated_at)
     and not bid_active_catalog_private.ongoing(g.latest,requested_now))
   and not exists(select 1 from bid_active_catalog_private.deadline_invalidations h where h.type=d.type and h.number=d.number
     and (h.revision>d.revision or h.revision=d.revision and h.source_updated_at>=d.source_updated_at))
   and (keyword_value='' or strpos(lower(d.notice->>'title'),lower(keyword_value))>0);
   select coalesce(jsonb_agg(q.notice order by q.deadline,q.number),'[]'::jsonb) into items from (
    select d.notice,d.deadline,d.number from bid_active_catalog_private.deadline_index d where d.type=p_payload->>'type'
    and d.deadline>=first_day::timestamp at time zone 'Asia/Seoul' and d.deadline<(last_day+1)::timestamp at time zone 'Asia/Seoul'
    and bid_active_catalog_private.ongoing(d.notice,requested_now)
    and not exists(select 1 from bid_active_catalog_private.groups g where g.type=d.type and g.number=d.number
      and (g.revision>d.revision or g.revision=d.revision and g.source_updated_at>=d.source_updated_at)
      and not bid_active_catalog_private.ongoing(g.latest,requested_now))
    and not exists(select 1 from bid_active_catalog_private.deadline_invalidations h where h.type=d.type and h.number=d.number
      and (h.revision>d.revision or h.revision=d.revision and h.source_updated_at>=d.source_updated_at))
    and (keyword_value='' or strpos(lower(d.notice->>'title'),lower(keyword_value))>0)
    order by d.deadline,d.number limit size_value offset (page_value-1)*size_value
   ) q;
   coverage:=bid_active_catalog_private.index_coverage();
   return jsonb_build_object('items',items,'totalCount',total,'page',page_value,'pageSize',size_value,
   'hasMore',page_value::bigint*size_value<total,'fetchedAt',stamp,'source','나라장터 입찰공고 마감일 색인','indexCoverage',coverage,
   'warnings',case when coverage->>'complete'='true' then '[]'::jsonb else '["공통 공고 색인을 수집 중입니다. 확인한 범위의 결과입니다."]'::jsonb end);
 elsif p_action='alarm_page' then
   limit_value:=coalesce((p_payload->>'limit')::integer,100);cursor_value:=coalesce(p_payload->>'cursor','');
   if limit_value not between 1 and 100 or length(cursor_value)>160 then raise exception 'Invalid alarm page'; end if;
   today:=(stamp at time zone 'Asia/Seoul')::date;first_day:=today-7;last_day:=today+7;
   -- Choose the current source head BEFORE filtering status. An old active
   -- original must never win against a newer cancellation or opened revision.
   with keys as (
     select d.type,d.number from bid_active_catalog_private.deadline_index d
       where d.deadline>=first_day::timestamp at time zone 'Asia/Seoul' and d.deadline<(last_day+1)::timestamp at time zone 'Asia/Seoul'
     union select g.type,g.number from bid_active_catalog_private.groups g
       where nullif(g.latest->>'deadline','')::timestamptz>=first_day::timestamp at time zone 'Asia/Seoul'
       and nullif(g.latest->>'deadline','')::timestamptz<(last_day+1)::timestamp at time zone 'Asia/Seoul'
   ), candidates as (
     select d.type,d.number,d.revision,d.source_updated_at,d.notice latest,jsonb_build_array(d.notice) versions,
       d.verified_at,d.indexed_at published_at,1 priority from bid_active_catalog_private.deadline_index d join keys using(type,number)
     union all select g.type,g.number,g.revision,g.source_updated_at,g.latest,g.versions,g.verified_at,g.published_at
       ,0 priority from bid_active_catalog_private.groups g join keys using(type,number)
   ),heads as (
     select distinct on(type,number) * from candidates order by type,number,revision desc,source_updated_at desc,
       (not bid_active_catalog_private.ongoing(latest,stamp)) desc,published_at desc,priority,verified_at desc nulls last
   ), selected as (
     select type||':'||number key,jsonb_build_object('key',type||':'||number,'type',type,'number',number,
       'latest',latest,'versions',heads.versions,'verifiedAt',coalesce(to_jsonb(verified_at),'""'::jsonb)) value
     from heads where type||':'||number>cursor_value
       and (not(p_payload?'types') or type in (select jsonb_array_elements_text(p_payload->'types')))
       and (not(p_payload?'changedSince') or published_at>=(p_payload->>'changedSince')::timestamptz)
       and (not(p_payload?'changedThrough') or published_at<=(p_payload->>'changedThrough')::timestamptz)
       and ((bid_active_catalog_private.alarm_active(latest,stamp)) or (coalesce((p_payload->>'includeInactive')::boolean,false)
         and (nullif(latest->>'deadline','')::timestamptz at time zone 'Asia/Seoul')::date between first_day and last_day
         and not exists(select 1 from bid_active_catalog_private.deadline_invalidations h where h.type=heads.type and h.number=heads.number
           and (h.revision>heads.revision or h.revision=heads.revision and h.source_updated_at>=heads.source_updated_at)
           and bid_active_catalog_private.ongoing(heads.latest,stamp))))
       order by type||':'||number limit limit_value+1
   ) select coalesce(jsonb_agg(value order by key),'[]'::jsonb),case when count(*)>limit_value then (array_agg(key order by key))[limit_value] end
     into rows_value,next_cursor from selected;
   if jsonb_array_length(rows_value)>limit_value then rows_value:=rows_value-(jsonb_array_length(rows_value)-1); end if;
   return jsonb_build_object('groups',rows_value,'nextCursor',next_cursor,'status',bid_active_catalog_private.status());
 end if;

 if p_action not in ('index_upsert','publish_verified','commit','enrich') then
   return bid_active_catalog_private.worker_legacy(p_token,p_action,p_payload);
 end if;
 select * into strict cfg from bid_active_catalog_private.runtime where singleton for update;
 perform 1 from bid_alert_private.runtime where singleton for update;
 if not exists(select 1 from bid_alert_private.runtime where singleton and token_hash=sha256(convert_to(p_token,'UTF8'))) then
 raise exception using errcode='42501',message='공고 수집 작업 인증에 실패했습니다.'; end if;

 if p_action='index_upsert' then
   begin lease:=(p_payload->>'leaseId')::uuid;exception when others then lease:=null;end;
   if lease is null or cfg.lease_id is distinct from lease or cfg.lease_until<=stamp
   or p_payload->>'scopeVersion' is distinct from cfg.scope_version or cfg.scope_version is distinct from bid_active_catalog_private.scope_version()
   then raise exception using errcode='42501',message='공고 색인 작업 임대를 확인해 주세요.'; end if;
   select * into strict job from bid_active_catalog_private.sources where id=p_payload->>'sourceId' and claimed_lease=lease
   and completed_at is null and scope_version=cfg.scope_version and page=(p_payload->>'page')::integer for update;
   page_value:=(p_payload->>'batch')::integer;size_value:=(p_payload->>'batches')::integer;
   if page_value not between 0 and 4 or size_value not between 1 and 5 or page_value>=size_value
   or jsonb_typeof(p_payload->'notices') is distinct from 'array' or jsonb_typeof(p_payload->'removed') is distinct from 'array'
   or jsonb_array_length(p_payload->'notices')+jsonb_array_length(p_payload->'removed')>200
   or exists(select 1 from bid_active_catalog_private.index_batches where source_id=job.id and page=job.page and batches<>size_value)
   then raise exception 'Invalid deadline index batch'; end if;
   cost:=greatest(65536,octet_length(p_payload::text)*3);
   if bid_active_catalog_private.storage_bytes()+cost>=cfg.storage_ceiling or bid_alert_private.storage_bytes()+cost>=33554432 then
     update bid_active_catalog_private.runtime set last_error='기존 저장 한도 안의 공고 색인 공간이 부족해 수집을 대기합니다. 확인 범위는 유지됩니다.' where singleton;
     return jsonb_build_object('ok',false,'storageFull',true); end if;
   begin
     for n in select value from jsonb_array_elements(p_payload->'notices') loop
       if n->>'type' is distinct from job.type or coalesce(n->>'number','')!~'^[A-Za-z0-9_-]{1,40}$'
       or coalesce(n->>'revision','')!~'^[0-9]{3}$' or n->>'source' is distinct from 'live'
       or not bid_active_catalog_private.ongoing(n,stamp) then raise exception 'Invalid deadline index candidate'; end if;
       source_time:=(n->>'sourceUpdatedAt')::timestamptz;
       if source_time is null or not isfinite(source_time) then raise exception 'Invalid deadline index source time'; end if;
       n:=bid_active_catalog_private.compact(n);
       if exists(select 1 from bid_active_catalog_private.groups g where g.type=job.type and g.number=n->>'number'
         and (g.revision>(n->>'revision')::integer or g.revision=(n->>'revision')::integer and g.source_updated_at>=source_time)
         and not bid_active_catalog_private.ongoing(g.latest,stamp)) then continue;end if;
       if exists(select 1 from bid_active_catalog_private.deadline_invalidations h where h.type=job.type and h.number=n->>'number'
         and (h.revision>(n->>'revision')::integer or h.revision=(n->>'revision')::integer and h.source_updated_at>=source_time)) then continue;end if;
       select * into indexed from bid_active_catalog_private.deadline_index where type=job.type and number=n->>'number';
       if found and (indexed.revision>(n->>'revision')::integer or indexed.revision=(n->>'revision')::integer and indexed.source_updated_at>source_time) then continue; end if;
       if found and indexed.revision=(n->>'revision')::integer and indexed.source_updated_at=source_time then
         if indexed.notice->>'openingCompleted'='true' then n:=n||'{"openingCompleted":true}'::jsonb; end if;
         if indexed.notice->>'regionComplete'='true' then n:=n||jsonb_build_object('allowedRegions',indexed.notice->'allowedRegions','regionComplete',true);end if;
         if indexed.notice->>'licenseComplete'='true' then n:=n||jsonb_build_object('licenses',indexed.notice->'licenses','licenseComplete',true);end if;
       end if;
       if not bid_active_catalog_private.ongoing(n,stamp) then continue; end if;
       insert into bid_active_catalog_private.deadline_index(type,number,revision,notice,source_updated_at,deadline,opening_at,indexed_at)
       values(job.type,n->>'number',(n->>'revision')::integer,n,source_time,(n->>'deadline')::timestamptz,nullif(n->>'openingAt','')::timestamptz,stamp)
       on conflict(type,number) do update set revision=excluded.revision,notice=excluded.notice,source_updated_at=excluded.source_updated_at,
       deadline=excluded.deadline,opening_at=excluded.opening_at,indexed_at=excluded.indexed_at,
       verified_at=case when bid_active_catalog_private.deadline_index.notice=excluded.notice
         then bid_active_catalog_private.deadline_index.verified_at end
       where bid_active_catalog_private.deadline_index.notice is distinct from excluded.notice;
     end loop;
     for n in select value from jsonb_array_elements(p_payload->'removed') loop
       if n->>'type' is distinct from job.type or coalesce(n->>'number','')!~'^[A-Za-z0-9_-]{1,40}$'
       or coalesce(n->>'revision','')!~'^[0-9]{3}$' then raise exception 'Invalid removed deadline identity'; end if;
       if exists(select 1 from bid_active_catalog_private.deadline_index d where d.type=job.type and d.number=n->>'number')
       or exists(select 1 from bid_active_catalog_private.groups g where g.type=job.type and g.number=n->>'number') then
         insert into bid_active_catalog_private.deadline_invalidations(type,number,revision,source_updated_at)
         values(job.type,n->>'number',(n->>'revision')::integer,(n->>'sourceUpdatedAt')::timestamptz)
         on conflict(type,number) do update set revision=excluded.revision,source_updated_at=excluded.source_updated_at
         where bid_active_catalog_private.deadline_invalidations.revision<excluded.revision
           or bid_active_catalog_private.deadline_invalidations.revision=excluded.revision and bid_active_catalog_private.deadline_invalidations.source_updated_at<excluded.source_updated_at;
       end if;
       delete from bid_active_catalog_private.deadline_index where type=job.type and number=n->>'number'
       and (revision<(n->>'revision')::integer or revision=(n->>'revision')::integer and source_updated_at<=(n->>'sourceUpdatedAt')::timestamptz);
     end loop;
     delete from bid_active_catalog_private.deadline_index where not bid_active_catalog_private.ongoing(notice,stamp);
     insert into bid_active_catalog_private.index_batches(source_id,page,batch,batches) values(job.id,job.page,page_value,size_value) on conflict do nothing;
     if bid_active_catalog_private.storage_bytes()>=cfg.storage_ceiling or bid_alert_private.storage_bytes()>=33554432 then
       raise exception using errcode='54000',message='Deadline index capacity reached';end if;
   exception when program_limit_exceeded then
     update bid_active_catalog_private.runtime set last_error='기존 저장 한도 안의 공고 색인 공간이 부족해 수집을 대기합니다. 확인 범위는 유지됩니다.' where singleton;
     return jsonb_build_object('ok',false,'storageFull',true);
   end;
   return jsonb_build_object('ok',true);
 elsif p_action='publish_verified' then
   versions:=p_payload->'notices';
   if jsonb_typeof(versions) is distinct from 'array' or jsonb_array_length(versions) not between 1 and 1000 then raise exception 'Invalid complete notice history'; end if;
   typ:=versions->0->>'type';number_value:=versions->0->>'number';ids:='{}';head:=null;items:='[]'::jsonb;
   for n in select value from jsonb_array_elements(versions) order by (value->>'revision')::integer desc loop
     if typ not in ('공사','용역') or number_value!~'^[A-Za-z0-9_-]{1,40}$' or n->>'type' is distinct from typ or n->>'number' is distinct from number_value
     or coalesce(n->>'revision','')!~'^[0-9]{3}$' or n->>'source' is distinct from 'live' or n->>'revision'=any(ids)
     then raise exception 'Invalid verified notice identity';end if;
     source_time:=(n->>'sourceUpdatedAt')::timestamptz;
     if source_time is null or not isfinite(source_time) then raise exception 'Invalid verified notice time'; end if;
     n:=bid_active_catalog_private.compact(n);
     if octet_length(n::text)>4096 then raise exception 'Verified notice exceeded compact budget';end if;
     ids:=array_append(ids,n->>'revision');items:=items||jsonb_build_array(n);
     if head is null then head:=n;end if;
   end loop;
   revision_value:=(head->>'revision')::integer;source_time:=(head->>'sourceUpdatedAt')::timestamptz;
   select * into indexed from bid_active_catalog_private.deadline_index where type=typ and number=number_value;
   if found and (indexed.revision>revision_value or indexed.revision=revision_value and indexed.source_updated_at>source_time) then return jsonb_build_object('ok',false);end if;
   select * into prior from bid_active_catalog_private.groups where type=typ and number=number_value;
   if found and (prior.revision>revision_value or prior.revision=revision_value and prior.source_updated_at>source_time
   or exists(select 1 from jsonb_array_elements(prior.versions) old where not(old->>'revision'=any(ids)))) then return jsonb_build_object('ok',false);end if;
   cost:=greatest(65536,octet_length(items::text)*3);
   if bid_active_catalog_private.storage_bytes()+cost>=cfg.storage_ceiling or bid_alert_private.storage_bytes()+cost>=33554432 then return jsonb_build_object('ok',false,'storageFull',true);end if;
   begin
     insert into bid_active_catalog_private.groups(type,number,revision,latest,versions,source_updated_at,verified_at,published_at,next_check_at)
     values(typ,number_value,revision_value,head,items,source_time,stamp,stamp,stamp+interval '1 hour')
     on conflict(type,number) do update set revision=excluded.revision,latest=excluded.latest,versions=excluded.versions,source_updated_at=excluded.source_updated_at,
     verified_at=excluded.verified_at,next_check_at=excluded.next_check_at,
     published_at=case when bid_active_catalog_private.groups.latest is distinct from excluded.latest or bid_active_catalog_private.groups.versions is distinct from excluded.versions
       then stamp else bid_active_catalog_private.groups.published_at end;
     if bid_active_catalog_private.ongoing(head,stamp) then
       insert into bid_active_catalog_private.deadline_index(type,number,revision,notice,source_updated_at,deadline,opening_at,indexed_at,verified_at)
       values(typ,number_value,revision_value,head,source_time,(head->>'deadline')::timestamptz,nullif(head->>'openingAt','')::timestamptz,stamp,stamp)
       on conflict(type,number) do update set revision=excluded.revision,notice=excluded.notice,source_updated_at=excluded.source_updated_at,
       deadline=excluded.deadline,opening_at=excluded.opening_at,verified_at=excluded.verified_at,
       indexed_at=case when bid_active_catalog_private.deadline_index.notice is distinct from excluded.notice then stamp else bid_active_catalog_private.deadline_index.indexed_at end;
     else delete from bid_active_catalog_private.deadline_index where type=typ and number=number_value;end if;
     delete from bid_active_catalog_private.verification where type=typ and number=number_value;
     if bid_active_catalog_private.storage_bytes()>=cfg.storage_ceiling or bid_alert_private.storage_bytes()>=33554432 then raise exception using errcode='54000',message='Verified history capacity reached';end if;
   exception when program_limit_exceeded then return jsonb_build_object('ok',false,'storageFull',true);end;
   return jsonb_build_object('ok',true);
 elsif p_action='commit' then
   for entry in select value from jsonb_array_elements(coalesce(p_payload->'sources','[]'::jsonb)) loop
     if not exists(select 1 from bid_active_catalog_private.index_batches b where b.source_id=entry->>'id' and b.page=(entry->>'page')::integer
       group by b.source_id,b.page having count(*)=max(b.batches) and min(b.batches)=max(b.batches)) then
       raise exception using errcode='22023',message='전체 공고 색인 저장 전에는 처리 구간을 넘길 수 없습니다.';end if;
   end loop;
   outcome:=bid_active_catalog_private.worker_legacy(p_token,p_action,p_payload);
   if outcome->>'ok'='true' then
     for entry in select value from jsonb_array_elements(coalesce(p_payload->'sources','[]'::jsonb)) loop
       delete from bid_active_catalog_private.index_batches where source_id=entry->>'id' and page=(entry->>'page')::integer;
     end loop;
     for entry in select value from jsonb_array_elements(coalesce(p_payload->'failedSources','[]'::jsonb)) loop
       if entry->>'restart'='true' then delete from bid_active_catalog_private.index_batches where source_id=entry->>'id';end if;
     end loop;
   end if;
   return outcome;
 else
   n:=p_payload->'notice';
   if n?'openingCompleted' then
     if jsonb_typeof(n->'openingCompleted') is distinct from 'boolean' then raise exception 'Invalid opening completion flag';end if;
     select * into prior from bid_active_catalog_private.groups where type=n->>'type' and number=n->>'number' for update;
     if not found or coalesce(n->>'revision','')!~'^[0-9]{3}$' or prior.revision<>(n->>'revision')::integer
       or prior.source_updated_at is distinct from nullif(n->>'sourceUpdatedAt','')::timestamptz then return jsonb_build_object('ok',false);end if;
     -- Completion evidence is monotonic for the same revision/source snapshot.
     if n->>'openingCompleted'='true' and prior.latest->>'openingCompleted' is distinct from 'true' then
       if bid_active_catalog_private.storage_bytes()+65536>=cfg.storage_ceiling or bid_alert_private.storage_bytes()+65536>=33554432 then return jsonb_build_object('ok',false,'storageFull',true);end if;
       select jsonb_agg(case when value->>'revision'=n->>'revision' then value||'{"openingCompleted":true}'::jsonb else value end order by ordinality)
         into items from jsonb_array_elements(prior.versions) with ordinality;
       update bid_active_catalog_private.groups set latest=prior.latest||'{"openingCompleted":true}'::jsonb,versions=items,published_at=stamp
       where type=prior.type and number=prior.number;
       delete from bid_active_catalog_private.deadline_index where type=prior.type and number=prior.number;
     end if;
   end if;
   outcome:=bid_active_catalog_private.worker_legacy(p_token,p_action,p_payload);
   if outcome->>'ok'='true' then
     update bid_active_catalog_private.deadline_index d set notice=g.latest,verified_at=g.verified_at
     from bid_active_catalog_private.groups g where g.type=d.type and g.number=d.number and d.revision=g.revision
       and d.source_updated_at=g.source_updated_at and d.notice is distinct from g.latest;
   end if;
   return outcome;
 end if;
end $$;

-- A queued push is checked against today's CURRENT head, not the old inbox
-- snapshot. This also suppresses items that left the rolling seven-day window.
create or replace function bid_active_catalog_private.delivery_eligible(p_user uuid,p_key text,p_kind text,p_fallback jsonb)
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare current_notice jsonb;
begin
 if p_kind='test' then return true;end if;
 if p_kind='initial' then
   return exists(select 1 from bid_alert_private.memberships m join bid_alert_private.observations o on o.notice_key=m.notice_key
     where m.user_id=p_user and m.initial and bid_active_catalog_private.alarm_active(o.notice));
 end if;
 select q.notice into current_notice from (
   select g.latest notice,g.revision,g.source_updated_at from bid_active_catalog_private.groups g where 'g2b:'||g.type||':'||g.number=p_key
   union all select d.notice,d.revision,d.source_updated_at from bid_active_catalog_private.deadline_index d where 'g2b:'||d.type||':'||d.number=p_key
   union all select o.notice,o.revision,o.source_updated_at from bid_alert_private.observations o where o.notice_key=p_key
 ) q order by q.revision desc,q.source_updated_at desc,(not bid_active_catalog_private.ongoing(q.notice)) desc limit 1;
 return bid_active_catalog_private.alarm_active(coalesce(current_notice,p_fallback));
end $$;
do $$ declare definition text;begin
 select pg_get_functiondef('public.bid_alert_worker(text,text,jsonb)'::regprocedure) into definition;
 if position('bid_active_catalog_private.delivery_eligible' in definition)=0 then
   definition:=replace(definition,
     'update bid_alert_private.deliveries set status=''failed'' where status=''pending'' and attempts>=5',
     'update bid_alert_private.deliveries d set status=''failed'' from public.bid_alert_inbox i where i.id=d.notification_id and d.status=''pending'' and not bid_active_catalog_private.delivery_eligible(i.user_id,i.notice_key,i.kind,i.notice); update bid_alert_private.deliveries set status=''failed'' where status=''pending'' and attempts>=5');
   definition:=replace(definition,
     '(i.kind=''test'' or (p.settings->>''enabled''=''true'' and p.settings->>''pushEnabled''=''true''))',
     '(i.kind=''test'' or (p.settings->>''enabled''=''true'' and p.settings->>''pushEnabled''=''true'')) and bid_active_catalog_private.delivery_eligible(i.user_id,i.notice_key,i.kind,i.notice)');
   execute definition;
 end if;
 select pg_get_functiondef('bid_alert_private.overview(uuid,integer,integer)'::regprocedure) into definition;
 definition:=replace(definition,'bid_active_catalog_private.active(o.notice)','bid_active_catalog_private.alarm_active(o.notice)');
 execute definition;
end $$;

revoke all on all functions in schema bid_active_catalog_private from public,anon,authenticated;
revoke all on function public.bid_active_catalog_worker(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.bid_active_catalog_worker(text,text,jsonb) to anon,authenticated;
commit;
