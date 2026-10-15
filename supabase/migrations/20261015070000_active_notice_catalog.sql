-- Read/discard raw pages; retain only rule-matched compact facts and durable cursors.
-- Shares the EXISTING 32 MiB alert ceiling, with a 16 MiB inner ceiling.
begin;
alter table bid_alert_private.runtime add column if not exists catalog_cursor text;
alter table bid_alert_private.runtime add column if not exists catalog_delta_from text;
alter table bid_alert_private.runtime add column if not exists catalog_delta_through text;
alter table bid_alert_private.runtime add column if not exists catalog_delta_cursor text;
create schema if not exists bid_active_catalog_private;
revoke all on schema bid_active_catalog_private from public,anon,authenticated;
create table if not exists bid_active_catalog_private.runtime (
 singleton boolean primary key default true check(singleton),lease_id uuid,lease_until timestamptz,
 last_checked_at timestamptz,last_error text,scope_version text,retry_after_at timestamptz,
 storage_ceiling bigint not null default 16777216 check(storage_ceiling=16777216)
);
alter table bid_active_catalog_private.runtime add column if not exists scope_version text;
alter table bid_active_catalog_private.runtime add column if not exists retry_after_at timestamptz;
insert into bid_active_catalog_private.runtime(singleton) values(true) on conflict do nothing;
create table if not exists bid_active_catalog_private.scopes (
 version text primary key check(version~'^[a-f0-9]{64}$'),created_at timestamptz not null default clock_timestamp()
);
create table if not exists bid_active_catalog_private.sources (
 id text primary key,type text not null check(type in ('공사','용역')),
 kind text not null check(kind in ('history','registered','modified')),from_at timestamptz not null,to_at timestamptz not null,
 page integer not null default 1 check(page>0),expected_total integer,completed_at timestamptz,
 claimed_lease uuid,next_attempt timestamptz not null default now(),failures integer not null default 0,last_error text,
 scope_version text not null default '',processed_count bigint not null default 0 check(processed_count>=0),
 check(from_at<=to_at)
);
alter table bid_active_catalog_private.sources add column if not exists scope_version text not null default '';
alter table bid_active_catalog_private.sources add column if not exists processed_count bigint not null default 0 check(processed_count>=0);
create index if not exists bid_active_sources_pending on bid_active_catalog_private.sources(kind,next_attempt,from_at desc) where completed_at is null;
create table if not exists bid_active_catalog_private.source_seen (
 source_id text not null references bid_active_catalog_private.sources(id) on delete cascade,
 identity text not null,primary key(source_id,identity)
);
create table if not exists bid_active_catalog_private.live_cursors (
 type text not null check(type in ('공사','용역')),kind text not null check(kind in ('registered','modified')),
 cursor_at timestamptz not null,scope_version text not null,primary key(scope_version,type,kind)
);
create table if not exists bid_active_catalog_private.groups (
 type text not null check(type in ('공사','용역')),number text not null check(number~'^[A-Za-z0-9_-]{1,40}$'),
 latest jsonb not null,versions jsonb not null check(jsonb_typeof(versions)='array'),
 revision integer not null check(revision between 0 and 999),source_updated_at timestamptz not null,
 verified_at timestamptz not null default now(),published_at timestamptz not null default clock_timestamp(),
 next_check_at timestamptz not null default now()+interval '1 hour',
 primary key(type,number)
);
alter table bid_active_catalog_private.groups add column if not exists published_at timestamptz not null default clock_timestamp();
create index if not exists bid_active_groups_published on bid_active_catalog_private.groups(published_at,type,number);
create table if not exists bid_active_catalog_private.verification (
 type text not null check(type in ('공사','용역')),number text not null check(number~'^[A-Za-z0-9_-]{1,40}$'),
 revision integer not null default 0 check(revision between 0 and 999),source_updated_at timestamptz,
 queued_at timestamptz not null default now(),next_attempt timestamptz not null default now(),
 failures integer not null default 0,last_error text,claimed_lease uuid,scope_version text not null default '',primary key(type,number)
);
alter table bid_active_catalog_private.verification add column if not exists scope_version text not null default '';
alter table bid_active_catalog_private.runtime enable row level security;
alter table bid_active_catalog_private.sources enable row level security;
alter table bid_active_catalog_private.source_seen enable row level security;
alter table bid_active_catalog_private.live_cursors enable row level security;
alter table bid_active_catalog_private.groups enable row level security;
alter table bid_active_catalog_private.verification enable row level security;
alter table bid_active_catalog_private.scopes enable row level security;

create or replace function bid_active_catalog_private.rules()
returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('userId',s.user_id,'settings',s.settings,'profile',w.data->'profile') order by s.user_id),'[]'::jsonb)
 from public.bid_alert_settings s left join public.bid_member_workspaces w on w.user_id=s.user_id
 where s.settings->>'enabled'='true';
$$;
create or replace function bid_active_catalog_private.scope_version()
returns text language sql stable security invoker set search_path='' as $$
 -- Delivery toggles and save timestamps do not change discovery eligibility.
 select encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('userId',r->'userId',
 'filter',r#>'{settings,filter}','profile',r->'profile') order by r->>'userId'),'[]'::jsonb)::text,'UTF8')),'hex')
 from jsonb_array_elements(bid_active_catalog_private.rules()) r;
$$;
alter table bid_active_catalog_private.sources alter column scope_version set default bid_active_catalog_private.scope_version();
alter table bid_active_catalog_private.verification alter column scope_version set default bid_active_catalog_private.scope_version();

create or replace function bid_active_catalog_private.storage_bytes()
returns bigint language sql stable security invoker set search_path='' as $$
 select coalesce(sum(pg_total_relation_size(c.oid)),0)::bigint from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where c.relkind='r' and n.nspname='bid_active_catalog_private';
$$;
create or replace function bid_alert_private.storage_bytes()
returns bigint language sql stable security invoker set search_path='' as $$
 select coalesce(sum(pg_total_relation_size(c.oid)),0)::bigint from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where c.relkind='r' and (n.nspname in ('bid_alert_private','bid_active_catalog_private')
 or (n.nspname='public' and c.relname in ('bid_alert_settings','bid_alert_inbox')));
$$;
create or replace function bid_active_catalog_private.active(p_notice jsonb)
returns boolean language plpgsql stable security invoker set search_path='' as $$
begin
 if p_notice->>'status' in ('취소','마감') or coalesce(p_notice->>'noticeKind','') like '%취소%' then return false; end if;
 if nullif(p_notice->>'deadline','') is null then return true; end if;
 return (p_notice->>'deadline')::timestamptz>now();
exception when invalid_datetime_format or datetime_field_overflow then return true;
end $$;
create or replace function bid_active_catalog_private.compact(p_notice jsonb)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare result jsonb;
begin
 -- Allowlist public mapped fields; details and documents are fetched on demand.
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into result from jsonb_each(p_notice)
 where key=any(array['id','number','revision','title','agency','demandAgency','type','category','province','district',
 'allowedRegions','estimatedPrice','plannedAmount','contractMethod','status','postedAt','deadline','openingAt',
 'registrationDeadline','biddingStartAt','licenses','specialRegionCondition','revised','source','sourceUpdatedAt',
 'regionComplete','licenseComplete','noticeKind','detailUrl','sourceOmittedDigest']);
 return result||'{"description":"","duration":"","requirements":[],"documents":[]}'::jsonb;
end $$;
create or replace function bid_active_catalog_private.known_heads()
returns table(type text,number text,revision integer,source_updated_at timestamptz)
language sql stable security invoker set search_path='' as $$
 -- The old notification ledger remains authoritative for already tracked IDs
 -- until their first complete catalog verification; do not replay raw history.
 select distinct on(k.type,k.number) k.type,k.number,k.revision,k.source_updated_at from (
 select c.type,c.number,c.revision,c.source_updated_at from bid_active_catalog_private.groups c
 union all
 select o.notice->>'type',o.notice->>'number',o.revision,o.source_updated_at from bid_alert_private.observations o
 where o.notice->>'type' in ('공사','용역') and o.notice->>'number'~'^[A-Za-z0-9_-]{1,40}$' and o.revision between 0 and 999
 ) k order by k.type,k.number,k.revision desc,k.source_updated_at desc;
$$;
create or replace function bid_active_catalog_private.status()
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare cfg bid_active_catalog_private.runtime%rowtype; covered text;
begin
 select * into strict cfg from bid_active_catalog_private.runtime where singleton;
 select case when count(*)=2 then to_char(max(first_at) at time zone 'Asia/Seoul','YYYY-MM-DD') end into covered
 from (select s.type,min(s.from_at) first_at from bid_active_catalog_private.sources s
 where s.kind='history' and s.scope_version=cfg.scope_version and s.completed_at is not null and not exists(
 select 1 from bid_active_catalog_private.sources gap where gap.kind='history' and gap.type=s.type and gap.scope_version=s.scope_version
 and gap.from_at>=s.from_at and gap.completed_at is null) group by s.type) q;
 return jsonb_build_object('groupCount',(select count(*) from bid_active_catalog_private.groups),
 'activeCount',(select count(*) from bid_active_catalog_private.groups where bid_active_catalog_private.active(latest)),
 'pendingSources',(select count(*) from bid_active_catalog_private.sources where scope_version=cfg.scope_version and completed_at is null),
 'completedSources',(select count(*) from bid_active_catalog_private.sources where scope_version=cfg.scope_version and kind='history' and completed_at is not null),
 'pendingVerification',(select count(*) from bid_active_catalog_private.verification),
 'coverageFrom',covered,'bootstrapComplete',exists(select 1 from bid_active_catalog_private.sources where scope_version=cfg.scope_version and kind='history') and
 not exists(select 1 from bid_active_catalog_private.sources where scope_version=cfg.scope_version and kind='history' and completed_at is null),
 'lastCheckedAt',cfg.last_checked_at,'error',cfg.last_error,'storageBytes',bid_active_catalog_private.storage_bytes(),
 'storageCeiling',least(cfg.storage_ceiling,greatest(0,33554432-bid_alert_private.storage_bytes()+bid_active_catalog_private.storage_bytes())));
end $$;

create or replace function public.bid_active_catalog_worker(p_token text,p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg bid_active_catalog_private.runtime%rowtype; auth_cfg bid_alert_private.runtime%rowtype;
 lease uuid; item jsonb; n jsonb; g jsonb; latest jsonb; compact_versions jsonb; ids text[]; identity_value text;
 job bid_active_catalog_private.sources%rowtype; prior bid_active_catalog_private.groups%rowtype; candidate bid_active_catalog_private.verification%rowtype;
 stamp timestamptz:=clock_timestamp(); endpoint_at timestamptz; start_at timestamptz; typ text; kind_value text;
 number_value text; revision_value integer; source_time timestamptz; old_source_time timestamptz; has_prior boolean;
 expected integer; received integer; last_page boolean; p_limit integer; cursor_value text; result_groups jsonb; next_cursor text;
 selected_ids text[]; selected_keys text[]; cost bigint; warning_value text; enriched jsonb; changed boolean; prior_notice jsonb;
 rule_snapshot jsonb; scope_value text;
begin
 select * into strict auth_cfg from bid_alert_private.runtime where singleton;
 if p_token is null or length(p_token) not between 43 and 128 or auth_cfg.token_hash is null or
 sha256(convert_to(p_token,'UTF8')) is distinct from auth_cfg.token_hash then
 raise exception using errcode='42501',message='공고 수집 작업 인증에 실패했습니다.'; end if;
 if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>3000000 then
 raise exception using errcode='22023',message='공고 수집 요청 형식을 확인해 주세요.'; end if;

 if p_action='page' then
   p_limit:=coalesce((p_payload->>'limit')::integer,100);
   if p_limit not between 1 and 100 or length(coalesce(p_payload->>'cursor',''))>100
   or (p_payload?'types' and (jsonb_typeof(p_payload->'types') is distinct from 'array' or
   exists(select 1 from jsonb_array_elements_text(p_payload->'types') v where v not in ('공사','용역')))) then
   raise exception using errcode='22023',message='공고 조회 범위를 확인해 주세요.'; end if;
   cursor_value:=coalesce(p_payload->>'cursor','');
   select coalesce(jsonb_agg(q.value order by q.key),'[]'::jsonb),case when count(*)>p_limit then max(q.key) filter(where q.ordinal=p_limit) end
   into result_groups,next_cursor from (
     select z.*,row_number() over(order by z.key) ordinal from (
       select c.type||':'||c.number as key,jsonb_build_object('key',c.type||':'||c.number,'type',c.type,'number',c.number,
       'latest',c.latest,'versions',c.versions,'verifiedAt',c.verified_at) value from bid_active_catalog_private.groups c
       where c.type||':'||c.number>cursor_value and (coalesce((p_payload->>'includeInactive')::boolean,false) or bid_active_catalog_private.active(c.latest))
       and (not(p_payload?'types') or c.type in (select jsonb_array_elements_text(p_payload->'types')))
       -- Discovery can precede verification by hours during the first scan.
       -- Compare publication time so a delayed verified head is not stranded
       -- behind an alert watermark that already passed its provider timestamp.
       and (not(p_payload?'changedSince') or c.published_at>=(p_payload->>'changedSince')::timestamptz)
       and (not(p_payload?'changedThrough') or c.published_at<=(p_payload->>'changedThrough')::timestamptz)
       order by c.type||':'||c.number limit p_limit+1
     ) z
   ) q;
   -- The look-ahead row decides continuation and is never published twice.
   if jsonb_array_length(result_groups)>p_limit then result_groups:=result_groups-(jsonb_array_length(result_groups)-1); end if;
   return jsonb_build_object('groups',result_groups,'nextCursor',next_cursor,'status',bid_active_catalog_private.status());
 end if;
 select * into strict cfg from bid_active_catalog_private.runtime where singleton for update;
 -- Recheck token under the shared alert lock before any mutation.
 perform 1 from bid_alert_private.runtime where singleton for update;
 if not exists(select 1 from bid_alert_private.runtime where singleton and token_hash=sha256(convert_to(p_token,'UTF8'))) then
 raise exception using errcode='42501',message='공고 수집 작업 인증에 실패했습니다.'; end if;
 if p_action='enrich' then
   n:=p_payload->'notice';typ:=n->>'type';number_value:=n->>'number';
   if jsonb_typeof(n) is distinct from 'object' or typ not in ('공사','용역') or coalesce(n->>'revision','')!~'^[0-9]{3}$'
   or (n?'regionComplete' and jsonb_typeof(n->'regionComplete') is distinct from 'boolean')
   or (n?'licenseComplete' and jsonb_typeof(n->'licenseComplete') is distinct from 'boolean') then raise exception 'Invalid condition enrichment'; end if;
   select * into prior from bid_active_catalog_private.groups where type=typ and number=number_value for update;
   if not found then return jsonb_build_object('ok',false); end if;
   source_time:=nullif(n->>'sourceUpdatedAt','')::timestamptz;changed:=false;compact_versions:='[]'::jsonb;
   if (n->>'revision')::integer<>prior.revision or source_time is distinct from prior.source_updated_at then return jsonb_build_object('ok',false); end if;
   for g in select value from jsonb_array_elements(prior.versions) loop
     enriched:=g;
     if g->>'revision'=n->>'revision' and source_time=(g->>'sourceUpdatedAt')::timestamptz then
       if n->>'regionComplete'='true' then
         if (jsonb_typeof(n->'allowedRegions') is distinct from 'array' and jsonb_typeof(n->'allowedRegions') is distinct from 'null') or
         (jsonb_typeof(n->'allowedRegions')='array' and (jsonb_array_length(n->'allowedRegions')>100 or exists(
         select 1 from jsonb_array_elements(n->'allowedRegions') x where jsonb_typeof(x)<>'string' or length(x#>>'{}')>120))) then raise exception 'Invalid region enrichment'; end if;
         enriched:=enriched||jsonb_build_object('allowedRegions',n->'allowedRegions','regionComplete',true);
       end if;
       if n->>'licenseComplete'='true' then
         if jsonb_typeof(n->'licenses') is distinct from 'array' or jsonb_array_length(n->'licenses')>100 or exists(
         select 1 from jsonb_array_elements(n->'licenses') x where jsonb_typeof(x)<>'string' or length(x#>>'{}')>160) then raise exception 'Invalid license enrichment'; end if;
         enriched:=enriched||jsonb_build_object('licenses',n->'licenses','licenseComplete',true);
       end if;
       if octet_length(enriched::text)>4096 then raise exception 'Condition enrichment exceeded compact budget'; end if;
       changed:=changed or enriched<>g;
     end if;
     compact_versions:=compact_versions||jsonb_build_array(enriched);
   end loop;
   if not changed then return jsonb_build_object('ok',true); end if;
   cost:=greatest(65536,octet_length(compact_versions::text)*3);
   if bid_active_catalog_private.storage_bytes()+cost>=cfg.storage_ceiling or bid_alert_private.storage_bytes()+cost>=33554432 then
     return jsonb_build_object('ok',false,'storageFull',true); end if;
   update bid_active_catalog_private.groups set versions=compact_versions,latest=compact_versions->0,published_at=stamp where type=typ and number=number_value;
   return jsonb_build_object('ok',true);
 end if;
 if p_action='claim' then
   rule_snapshot:=bid_active_catalog_private.rules();scope_value:=bid_active_catalog_private.scope_version();
   if jsonb_array_length(rule_snapshot)>200 then raise exception 'Too many active notification rules'; end if;
   if scope_value is distinct from cfg.scope_version then
     -- A changed eligible scope receives its own coverage log. Old completed pages
     -- remain recorded; stale workers cannot advance the replacement scope.
     update bid_active_catalog_private.runtime set scope_version=scope_value,lease_id=null,lease_until=null where singleton;
     update bid_alert_private.runtime set catalog_cursor=null,catalog_delta_from=null,catalog_delta_through=null,catalog_delta_cursor=null,
       lease_id=null,lease_until=null,lease_collecting=false,last_checked_at=null where singleton;
     cfg.scope_version:=scope_value;cfg.lease_until:=null;
     insert into bid_active_catalog_private.scopes(version) values(scope_value) on conflict do nothing;
     delete from bid_active_catalog_private.verification where scope_version<>scope_value;
   end if;
   if cfg.lease_until>stamp or cfg.retry_after_at>stamp or jsonb_array_length(rule_snapshot)=0 or not auth_cfg.configured
   or coalesce((select locked from public.bid_menu_settings where menu_key='notices'),true) then
     return jsonb_build_object('leaseId',null,'scopeVersion',scope_value,'rules',rule_snapshot,'sources','[]'::jsonb,'verify','[]'::jsonb,'status',bid_active_catalog_private.status()); end if;
   -- Delta cursors are durable; finished transport metadata is disposable.
   -- Keep all historical coverage and public/member records intact.
   delete from bid_active_catalog_private.sources where kind in ('registered','modified') and completed_at is not null;
   if bid_active_catalog_private.storage_bytes()+65536>=cfg.storage_ceiling or bid_alert_private.storage_bytes()+65536>=33554432 then
     update bid_active_catalog_private.runtime set last_error='기존 저장 한도 안의 공고 색인 공간이 부족해 수집을 대기합니다. 기존 자료는 보존됩니다.' where singleton;
     return jsonb_build_object('leaseId',null,'scopeVersion',scope_value,'rules',rule_snapshot,'sources','[]'::jsonb,'verify','[]'::jsonb,'status',bid_active_catalog_private.status());
   end if;
   insert into bid_active_catalog_private.sources(id,type,kind,from_at,to_at,scope_version)
     select scope_value||':history:'||t.type||':'||to_char(m,'YYYY-MM'),t.type,'history',m at time zone 'Asia/Seoul',
     least((m+interval '1 month') at time zone 'Asia/Seoul'-interval '1 minute',date_trunc('minute',stamp)),scope_value
     from generate_series('1995-10-01T00:00:00'::timestamp,date_trunc('month',stamp at time zone 'Asia/Seoul'),interval '1 month') m
     cross join (values('공사'),('용역')) t(type) on conflict do nothing;
   -- Independent new/changed streams keep running while historical pages progress.
   insert into bid_active_catalog_private.live_cursors(type,kind,cursor_at,scope_version)
     select t.type,k.kind,date_trunc('minute',stamp)-interval '20 minutes',scope_value from (values('공사'),('용역')) t(type)
     cross join (values('registered'),('modified')) k(kind) on conflict do nothing;
   for typ,kind_value,start_at in select type,kind,cursor_at from bid_active_catalog_private.live_cursors where scope_version=scope_value loop
     if not exists(select 1 from bid_active_catalog_private.sources where type=typ and kind=kind_value and scope_version=scope_value and completed_at is null)
     and start_at<=date_trunc('minute',stamp)-interval '10 minutes' then
       endpoint_at:=least(date_trunc('minute',stamp),start_at+interval '1 hour');
       insert into bid_active_catalog_private.sources(id,type,kind,from_at,to_at,scope_version)
       values(scope_value||':'||kind_value||':'||typ||':'||extract(epoch from endpoint_at)::bigint,typ,kind_value,start_at-interval '2 minutes',endpoint_at,scope_value) on conflict do nothing;
     end if;
   end loop;
   insert into bid_active_catalog_private.verification(type,number,revision,source_updated_at,scope_version)
     select c.type,c.number,c.revision,c.source_updated_at,scope_value from bid_active_catalog_private.groups c where c.next_check_at<=stamp
     and bid_active_catalog_private.active(c.latest) on conflict do nothing;
   insert into bid_active_catalog_private.verification(type,number,revision,source_updated_at,scope_version)
     select o.notice->>'type',o.notice->>'number',o.revision,o.source_updated_at,scope_value from bid_alert_private.observations o
     where bid_active_catalog_private.active(o.notice) and o.notice->>'type' in ('공사','용역')
     and o.notice->>'number'~'^[A-Za-z0-9_-]{1,40}$' and o.revision between 0 and 999
     and not exists(select 1 from bid_active_catalog_private.groups c where c.type=o.notice->>'type' and c.number=o.notice->>'number')
     on conflict do nothing;
   lease:=gen_random_uuid();
   select array_agg(id) into selected_ids from (
     select id from bid_active_catalog_private.sources where scope_version=scope_value and completed_at is null and next_attempt<=stamp
     order by case when kind='history' then 1 else 0 end,case when kind='history' then -extract(epoch from from_at) else extract(epoch from from_at) end,type,kind limit 6
   ) q;
   select array_agg(type||':'||number) into selected_keys from (
     select v.type,v.number from bid_active_catalog_private.verification v where v.scope_version=scope_value and v.next_attempt<=stamp
     order by case when exists(select 1 from bid_active_catalog_private.known_heads() known where known.type=v.type and known.number=v.number) then 0 else 1 end,
     v.queued_at,v.type,v.number limit 8
   ) q;
   update bid_active_catalog_private.sources set claimed_lease=lease where id=any(coalesce(selected_ids,'{}'::text[]));
   update bid_active_catalog_private.verification set claimed_lease=lease where type||':'||number=any(coalesce(selected_keys,'{}'::text[]));
   update bid_active_catalog_private.runtime set lease_id=lease,lease_until=stamp+interval '120 seconds',last_error=null where singleton;
   return jsonb_build_object('leaseId',lease,'scopeVersion',scope_value,'rules',rule_snapshot,'sources',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'type',type,'kind',kind,'from',from_at,'to',to_at,
   'page',page,'pageSize',999,'totalCount',expected_total) order by case when kind='history' then 1 else 0 end,from_at desc,type,kind),'[]'::jsonb)
   from bid_active_catalog_private.sources where claimed_lease=lease),'verify',(select coalesce(jsonb_agg(jsonb_build_object('type',v.type,'number',v.number,
   'revision',lpad(v.revision::text,3,'0'),'sourceUpdatedAt',v.source_updated_at,
   'tracked',exists(select 1 from bid_active_catalog_private.known_heads() k where k.type=v.type and k.number=v.number)) order by v.queued_at,v.type,v.number),'[]'::jsonb)
   from bid_active_catalog_private.verification v where v.claimed_lease=lease),'status',bid_active_catalog_private.status());
 end if;
 begin lease:=(p_payload->>'leaseId')::uuid; exception when others then lease:=null; end;
 if lease is null or lease is distinct from cfg.lease_id or cfg.lease_until<=stamp then raise exception using errcode='42501',message='공고 수집 작업 임대가 만료되었습니다.'; end if;
 if p_action='finish' then
   update bid_active_catalog_private.runtime set lease_id=null,lease_until=null,last_error=coalesce(nullif(left(p_payload->>'error',300),''),last_error),
   retry_after_at=case when p_payload?'retryAfterSeconds' then stamp+make_interval(secs=>greatest(1,least(86400,(p_payload->>'retryAfterSeconds')::integer))) else retry_after_at end,
   last_checked_at=case when nullif(p_payload->>'error','') is null then stamp else last_checked_at end where singleton;
   return jsonb_build_object('ok',true);
 elsif p_action<>'commit' then raise exception using errcode='22023',message='지원하지 않는 공고 수집 작업입니다.'; end if;
 if p_payload->>'scopeVersion' is distinct from cfg.scope_version or cfg.scope_version is distinct from bid_active_catalog_private.scope_version() then
   raise exception using errcode='42501',message='알림 조건이 바뀌어 이전 수집 결과를 적용하지 않습니다.'; end if;
 foreach kind_value in array array['sources','groups','failedSources','failedGroups','rejectedGroups'] loop
   if p_payload?kind_value and (jsonb_typeof(p_payload->kind_value) is distinct from 'array' or jsonb_array_length(p_payload->kind_value)>16) then
   raise exception using errcode='22023',message='공고 수집 배치를 확인해 주세요.'; end if;
 end loop;
 cost:=greatest(65536,octet_length(p_payload::text)*3);
 if bid_active_catalog_private.storage_bytes()+cost>=cfg.storage_ceiling or bid_alert_private.storage_bytes()+cost>=33554432 then
   update bid_active_catalog_private.runtime set last_error='기존 저장 한도 안의 공고 색인 공간이 부족해 수집을 대기합니다. 기존 자료는 보존됩니다.' where singleton;
   return jsonb_build_object('ok',false,'storageFull',true);
 end if;
 for item in select value from jsonb_array_elements(coalesce(p_payload->'failedSources','[]'::jsonb)) loop
   update bid_active_catalog_private.sources set page=case when item->>'restart'='true' then 1 else page end,
   expected_total=case when item->>'restart'='true' then null else expected_total end,
   processed_count=case when item->>'restart'='true' then 0 else processed_count end,claimed_lease=null,failures=failures+1,
   next_attempt=stamp+make_interval(secs=>least(3600,60*power(2,least(failures,6)))::integer),last_error=left(item->>'error',300)
   where id=item->>'id' and claimed_lease=lease and completed_at is null;
   if found and item->>'restart'='true' then delete from bid_active_catalog_private.source_seen where source_id=item->>'id'; end if;
   warning_value:=coalesce(warning_value,'일부 공고 범위를 확인하지 못해 같은 범위에서 다시 시도합니다.');
 end loop;
 for item in select value from jsonb_array_elements(coalesce(p_payload->'failedGroups','[]'::jsonb)) loop
   update bid_active_catalog_private.verification set claimed_lease=null,failures=failures+1,
   next_attempt=stamp+make_interval(secs=>least(3600,60*power(2,least(failures,6)))::integer),last_error=left(item->>'error',300)
   where type=item->>'type' and number=item->>'number' and claimed_lease=lease;
   warning_value:=coalesce(warning_value,'일부 공고의 전체 차수를 확인하지 못해 기존 상태를 유지합니다.');
 end loop;
 for item in select value from jsonb_array_elements(coalesce(p_payload->'sources','[]'::jsonb)) loop
   select * into strict job from bid_active_catalog_private.sources where id=item->>'id' and scope_version=cfg.scope_version and claimed_lease=lease and completed_at is null for update;
   if coalesce(item->>'page','')!~'^[1-9][0-9]*$' or (item->>'page')::integer<>job.page or coalesce(item->>'totalCount','')!~'^[0-9]+$'
   or coalesce(item->>'receivedCount','')!~'^[0-9]+$'
   or jsonb_typeof(item->'observed') is distinct from 'array' or jsonb_typeof(item->'items') is distinct from 'array'
   or jsonb_typeof(item->'complete') is distinct from 'boolean' then raise exception 'Invalid source page'; end if;
   expected:=(item->>'totalCount')::integer;received:=(item->>'receivedCount')::integer;
   last_page:=job.page*999>=expected;
   if received<>greatest(0,least(999,expected-(job.page-1)*999)) or jsonb_array_length(item->'items')>received
   or jsonb_array_length(item->'observed')>received or last_page is distinct from (item->>'complete')::boolean
   or (job.expected_total is not null and job.expected_total<>expected) then raise exception 'Incomplete or unstable source page'; end if;
   if exists(select 1 from jsonb_array_elements(item->'items') candidate_item
     join bid_active_catalog_private.source_seen seen on seen.source_id=job.id
       and seen.identity=(candidate_item->>'number')||':'||(candidate_item->>'revision'))
     or (select count(*)<>count(distinct (x->>'number')||':'||(x->>'revision')) from jsonb_array_elements(item->'items') x) then
     -- Stable totals do not guarantee stable ordering. Reset the unstable source
     -- atomically instead of treating a cross-page duplicate as a storage outage.
     update bid_active_catalog_private.sources set page=1,expected_total=null,processed_count=0,claimed_lease=null,
       next_attempt=stamp+interval '1 minute',failures=failures+1,
       last_error='페이지 사이 공고 순서가 바뀌어 이 구간을 처음부터 다시 확인합니다.' where id=job.id;
     delete from bid_active_catalog_private.source_seen where source_id=job.id;
     update bid_active_catalog_private.runtime set last_error='페이지 사이 공고 순서가 바뀌어 이 구간을 처음부터 다시 확인합니다.' where singleton;
     return jsonb_build_object('ok',true,'restartRequired',true);
   end if;
   -- The raw page is gone. Only transient identities of already retained heads
   -- can enqueue their cancellation/eligibility changes; unrelated IDs are never stored.
   for n in select value from jsonb_array_elements(item->'observed') loop
     if n->>'type' is distinct from job.type or coalesce(n->>'number','')!~'^[A-Za-z0-9_-]{1,40}$' then raise exception 'Invalid observed identity'; end if;
     if n?'revision' and coalesce(n->>'revision','')!~'^[0-9]{3}$' then raise exception 'Invalid observed revision'; end if;
     source_time:=nullif(n->>'sourceUpdatedAt','')::timestamptz;
     insert into bid_active_catalog_private.verification(type,number,revision,source_updated_at,scope_version)
     select c.type,c.number,greatest(c.revision,coalesce((n->>'revision')::integer,c.revision)),
     case when (n->>'revision')::integer>c.revision then source_time
       when (n->>'revision')::integer=c.revision then greatest(c.source_updated_at,source_time) else c.source_updated_at end,cfg.scope_version
     from bid_active_catalog_private.known_heads() c
     where c.type=job.type and c.number=n->>'number'
     on conflict(type,number) do update set scope_version=excluded.scope_version,
       revision=greatest(bid_active_catalog_private.verification.revision,excluded.revision),
       source_updated_at=case when excluded.revision>bid_active_catalog_private.verification.revision then excluded.source_updated_at
       when excluded.revision=bid_active_catalog_private.verification.revision then greatest(bid_active_catalog_private.verification.source_updated_at,excluded.source_updated_at)
       else bid_active_catalog_private.verification.source_updated_at end,next_attempt=least(bid_active_catalog_private.verification.next_attempt,stamp);
   end loop;
   for n in select value from jsonb_array_elements(item->'items') loop
     if n->>'type' is distinct from job.type or coalesce(n->>'number','')!~'^[A-Za-z0-9_-]{1,40}$' or coalesce(n->>'revision','')!~'^[0-9]{3}$' then raise exception 'Invalid source notice identity'; end if;
     identity_value:=(n->>'number')||':'||(n->>'revision');
     insert into bid_active_catalog_private.source_seen(source_id,identity) values(job.id,identity_value);
     if not exists(select 1 from jsonb_array_elements(item->'observed') o where o->>'type'=job.type and o->>'number'=n->>'number') then raise exception 'Unobserved candidate'; end if;
     -- items contain only relaxed potential matches from this exact rule scope.
     -- Exact conditions and complete revision history are verified before groups persist.
       source_time:=nullif(n->>'sourceUpdatedAt','')::timestamptz;
       insert into bid_active_catalog_private.verification(type,number,revision,source_updated_at,scope_version)
       values(job.type,n->>'number',(n->>'revision')::integer,source_time,cfg.scope_version)
       on conflict(type,number) do update set revision=greatest(bid_active_catalog_private.verification.revision,excluded.revision),
       source_updated_at=case when excluded.revision>bid_active_catalog_private.verification.revision then excluded.source_updated_at
       when excluded.revision=bid_active_catalog_private.verification.revision then greatest(bid_active_catalog_private.verification.source_updated_at,excluded.source_updated_at)
       else bid_active_catalog_private.verification.source_updated_at end,scope_version=excluded.scope_version,
       next_attempt=least(bid_active_catalog_private.verification.next_attempt,stamp);
   end loop;
   update bid_active_catalog_private.sources set page=case when last_page then page else page+1 end,expected_total=expected,processed_count=processed_count+received,
   completed_at=case when last_page then stamp end,claimed_lease=null,failures=0,last_error=null where id=job.id;
   if last_page then
     delete from bid_active_catalog_private.source_seen where source_id=job.id;
     if job.kind<>'history' then update bid_active_catalog_private.live_cursors set cursor_at=greatest(cursor_at,job.to_at) where scope_version=cfg.scope_version and type=job.type and kind=job.kind; end if;
   end if;
 end loop;
 for g in select value from jsonb_array_elements(coalesce(p_payload->'groups','[]'::jsonb)) loop
   if jsonb_typeof(g) is distinct from 'array' or jsonb_array_length(g) not between 1 and 1000 then raise exception 'Incomplete notice history'; end if;
   typ:=g->0->>'type';number_value:=g->0->>'number';
   select * into strict candidate from bid_active_catalog_private.verification where type=typ and number=number_value and scope_version=cfg.scope_version and claimed_lease=lease for update;
   select * into prior from bid_active_catalog_private.groups where type=typ and number=number_value for update;has_prior:=found;
   ids:='{}';latest:=null;compact_versions:='[]'::jsonb;
   for n in select value from jsonb_array_elements(g) order by (value->>'revision')::integer desc loop
     if n->>'type' is distinct from typ or n->>'number' is distinct from number_value or coalesce(n->>'revision','')!~'^[0-9]{3}$'
     or n->>'source' is distinct from 'live' or n->>'revision'=any(ids)
     or (n?'sourceOmittedDigest' and coalesce(n->>'sourceOmittedDigest','')!~'^[0-9a-f]{64}$') then raise exception 'Invalid or duplicate history identity'; end if;
     source_time:=nullif(n->>'sourceUpdatedAt','')::timestamptz;
     if source_time is null or not isfinite(source_time) then raise exception 'Invalid source update time'; end if;
     ids:=array_append(ids,n->>'revision');
     n:=bid_active_catalog_private.compact(n);
     if has_prior then
       select value into prior_notice from jsonb_array_elements(prior.versions) where value->>'revision'=n->>'revision'
       and (value->>'sourceUpdatedAt')::timestamptz=source_time;
       if found then
         if n->>'regionComplete' is distinct from 'true' and prior_notice->>'regionComplete'='true' then
           n:=n||jsonb_build_object('allowedRegions',prior_notice->'allowedRegions','regionComplete',true); end if;
         if n->>'licenseComplete' is distinct from 'true' and prior_notice->>'licenseComplete'='true' then
           n:=n||jsonb_build_object('licenses',prior_notice->'licenses','licenseComplete',true); end if;
       end if;
     end if;
     if octet_length(n::text)>4096 then raise exception 'Compact notice exceeded storage budget'; end if;
     compact_versions:=compact_versions||jsonb_build_array(n);
     if latest is null then latest:=n; end if;
   end loop;
   revision_value:=(latest->>'revision')::integer;source_time:=(latest->>'sourceUpdatedAt')::timestamptz;
   if revision_value<candidate.revision or (revision_value=candidate.revision and candidate.source_updated_at is not null and source_time<candidate.source_updated_at)
   or (has_prior and (revision_value<prior.revision or (revision_value=prior.revision and source_time<prior.source_updated_at)))
   or (has_prior and exists(select 1 from jsonb_array_elements(prior.versions) old where not (old->>'revision'=any(ids)))) then raise exception 'Stale or incomplete notice history'; end if;
   -- The authenticated server sends only exact rule matches, plus previously
   -- retained heads whose cancellation/closing must reach their existing members.
   if has_prior or bid_active_catalog_private.active(latest) or
     exists(select 1 from bid_alert_private.observations o where o.notice_key='g2b:'||typ||':'||number_value) then
     insert into bid_active_catalog_private.groups(type,number,latest,versions,revision,source_updated_at,verified_at,published_at,next_check_at)
     values(typ,number_value,latest,compact_versions,revision_value,source_time,stamp,stamp,stamp+interval '1 hour')
     on conflict(type,number) do update set latest=excluded.latest,versions=excluded.versions,revision=excluded.revision,
     source_updated_at=excluded.source_updated_at,verified_at=excluded.verified_at,next_check_at=excluded.next_check_at,
     published_at=case when bid_active_catalog_private.groups.latest is distinct from excluded.latest
       or bid_active_catalog_private.groups.versions is distinct from excluded.versions then excluded.published_at
       else bid_active_catalog_private.groups.published_at end;
   end if;
   delete from bid_active_catalog_private.verification where type=typ and number=number_value;
 end loop;
 for item in select value from jsonb_array_elements(coalesce(p_payload->'rejectedGroups','[]'::jsonb)) loop
   delete from bid_active_catalog_private.verification where scope_version=cfg.scope_version and claimed_lease=lease
   and type=item->>'type' and number=item->>'number';
 end loop;
 update bid_active_catalog_private.runtime set last_error=coalesce(warning_value,last_error) where singleton;
 return jsonb_build_object('ok',true);
end $$;

-- Preserve existing event keys and hashes while admitting a newly published revision.
do $migration$ declare definition text; begin
 select pg_get_functiondef('public.bid_alert_worker(text,text,jsonb)'::regprocedure) into definition;
 if position('accepted_observations jsonb' in definition)=0 then
 definition:=replace(definition,'finalize boolean:=false;','finalize boolean:=false; accepted_observations jsonb:=''[]''::jsonb;');
 definition:=replace(definition,'if (fingerprint_value=prior.fingerprint and version_value<>prior.version) or',
 'if (fingerprint_value=prior.fingerprint and version_value<>prior.version and not (revision_value>prior.revision and version_value=prior.version+1)) or');
 definition:=replace(definition,'observation_count:=observation_count+1;','observation_count:=observation_count+1; accepted_observations:=accepted_observations||jsonb_build_array(item);');
 definition:=replace(definition,'select notice into notice_value from bid_alert_private.observations where notice_key=key_value and version=version_value;',
 'select x->''notice'' into notice_value from jsonb_array_elements(accepted_observations) x where x->>''key''=key_value and (x->>''version'')::integer=version_value; if not found then select notice into notice_value from bid_alert_private.observations where notice_key=key_value and version=version_value; end if;');
 definition:=replace(definition,'not exists(select 1 from bid_alert_private.observations where notice_key=key_value and version=version_value) then continue; end if;',
 'not (exists(select 1 from bid_alert_private.observations where notice_key=key_value and version=version_value) or exists(select 1 from jsonb_array_elements(accepted_observations) x where x->>''key''=key_value and (x->>''version'')::integer=version_value)) then continue; end if;');
 execute definition;
 end if;
 select pg_get_functiondef('public.bid_alert_worker(text,text,jsonb)'::regprocedure) into definition;
 if position('''catalogCursor'',cfg.catalog_cursor' in definition)=0 then
 definition:=replace(definition,'''cursor'',cfg.cursor_value,','''catalogCursor'',cfg.catalog_cursor,''cursor'',cfg.cursor_value,');
 definition:=replace(definition,'length(coalesce(checkpoint->>''coverageFrom'',''''))>100 or',
 'length(coalesce(checkpoint->>''coverageFrom'',''''))>100 or length(coalesce(checkpoint->>''catalogCursor'',''''))>160 or');
 definition:=replace(definition,'cursor_value=case when cfg.lease_collecting',
 'catalog_cursor=case when cfg.lease_collecting and checkpoint?''catalogCursor'' then checkpoint->>''catalogCursor'' else catalog_cursor end, cursor_value=case when cfg.lease_collecting');
 execute definition;
 end if;
 select pg_get_functiondef('bid_alert_private.overview(uuid,integer,integer)'::regprocedure) into definition;
 if position('bid_active_catalog_private.sources' in definition)=0 then
 definition:=replace(definition,'''backfillPending'',cfg.backfill_day is not null',
 '''backfillPending'',cfg.catalog_cursor is distinct from ''__complete__'' or cfg.catalog_delta_through is not null or exists(select 1 from bid_active_catalog_private.sources where scope_version=(select scope_version from bid_active_catalog_private.runtime where singleton) and kind=''history'' and completed_at is null) or exists(select 1 from bid_active_catalog_private.verification)');
 execute definition;
 end if;
 select pg_get_functiondef('public.bid_alert_worker(text,text,jsonb)'::regprocedure) into definition;
 if position('''catalogDeltaFrom'',cfg.catalog_delta_from' in definition)=0 then
 definition:=replace(definition,'''catalogCursor'',cfg.catalog_cursor,',
 '''catalogDeltaFrom'',cfg.catalog_delta_from,''catalogDeltaThrough'',cfg.catalog_delta_through,''catalogDeltaCursor'',cfg.catalog_delta_cursor,''catalogCursor'',cfg.catalog_cursor,');
 definition:=replace(definition,'length(coalesce(checkpoint->>''catalogCursor'',''''))>160 or',
 'length(coalesce(checkpoint->>''catalogDeltaCursor'',''''))>160 or length(coalesce(checkpoint->>''catalogDeltaFrom'',''''))>100 or length(coalesce(checkpoint->>''catalogDeltaThrough'',''''))>100 or length(coalesce(checkpoint->>''catalogCursor'',''''))>160 or');
 definition:=replace(definition,'catalog_cursor=case when cfg.lease_collecting',
 'catalog_delta_from=case when cfg.lease_collecting and checkpoint?''catalogDeltaFrom'' then checkpoint->>''catalogDeltaFrom'' else catalog_delta_from end, catalog_delta_through=case when cfg.lease_collecting and checkpoint?''catalogDeltaThrough'' then checkpoint->>''catalogDeltaThrough'' else catalog_delta_through end, catalog_delta_cursor=case when cfg.lease_collecting and checkpoint?''catalogDeltaCursor'' then checkpoint->>''catalogDeltaCursor'' else catalog_delta_cursor end, catalog_cursor=case when cfg.lease_collecting');
 execute definition;
 end if;
 select pg_get_functiondef('public.bid_alert_worker(text,text,jsonb)'::regprocedure) into definition;
 if position('cfg.catalog_delta_through is not null or (cfg.catalog_cursor is distinct from ''__complete__''' in definition)=0 then
 definition:=replace(definition,
 'cfg.last_checked_at<=clock_timestamp()-interval ''9 minutes'' or cfg.last_error is not null)',
 'cfg.last_checked_at<=clock_timestamp()-interval ''9 minutes'' or cfg.last_error is not null or cfg.catalog_delta_through is not null or (cfg.catalog_cursor is distinct from ''__complete__'' and exists(select 1 from bid_active_catalog_private.scopes s where s.version=(select scope_version from bid_active_catalog_private.runtime where singleton))))');
 execute definition;
 end if;
 select pg_get_functiondef('bid_alert_private.overview(uuid,integer,integer)'::regprocedure) into definition;
 if position('where m.user_id=p_user and m.initial and bid_active_catalog_private.active(o.notice)' in definition)=0 then
 definition:=replace(definition,'where m.user_id=p_user and m.initial order by',
 'where m.user_id=p_user and m.initial and bid_active_catalog_private.active(o.notice) order by');
 definition:=replace(definition,
 '''existingHasMore'',(select count(*)>p_existing_offset+30 from bid_alert_private.memberships where user_id=p_user and initial)',
 '''existingHasMore'',(select count(*)>p_existing_offset+30 from bid_alert_private.memberships m join bid_alert_private.observations o on o.notice_key=m.notice_key where m.user_id=p_user and m.initial and bid_active_catalog_private.active(o.notice))');
 definition:=replace(definition,'bid_alert_private.inbox_json(q)',
 'case when q.kind=''initial'' then bid_alert_private.inbox_json(q)||jsonb_build_object(''existingCount'',(select count(*) from bid_alert_private.memberships m join bid_alert_private.observations o on o.notice_key=m.notice_key where m.user_id=p_user and m.initial and bid_active_catalog_private.active(o.notice))) else bid_alert_private.inbox_json(q) end');
 execute definition;
 end if;
 select pg_get_functiondef('public.bid_alert_user(text,jsonb)'::regprocedure) into definition;
 if position('set catalog_cursor=null,backfill_day=' in definition)=0 then
 definition:=replace(definition,'set backfill_day=','set catalog_cursor=null,backfill_day=');
 execute definition;
 end if;
end $migration$;
revoke all on all tables in schema bid_active_catalog_private from public,anon,authenticated;
revoke all on all functions in schema bid_active_catalog_private from public,anon,authenticated;
revoke all on function public.bid_active_catalog_worker(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.bid_active_catalog_worker(text,text,jsonb) to anon,authenticated;
commit;
