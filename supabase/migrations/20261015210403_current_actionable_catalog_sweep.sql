-- Separate filtered CURRENT posting coverage from the unfiltered archive.
-- Uses existing runtime leases, provider limits and the fixed 16/32 MiB caps.
begin;
alter table bid_active_catalog_private.runtime add column if not exists current_sweep_started_at timestamptz;
alter table bid_active_catalog_private.runtime add column if not exists current_sweep_scope_version text;
alter table bid_active_catalog_private.sources drop constraint if exists sources_kind_check;
alter table bid_active_catalog_private.sources add constraint sources_kind_check check(kind in ('history','current','registered','modified'));

create or replace function bid_active_catalog_private.current_focus(p_notice jsonb)
returns boolean language sql immutable security invoker set search_path='' as $$
 select bid_active_catalog_private.clean_search_text(p_notice->>'title')~'(철거|해체|석면|건설폐기물)';
$$;

create or replace function bid_active_catalog_private.current_coverage()
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare cfg bid_active_catalog_private.runtime%rowtype;cutoff timestamptz;checked_count bigint;pending_count bigint;
 verification_count bigint;unknown_count bigint;expected_count bigint;live_ready boolean;stamp timestamptz:=statement_timestamp();
 required_through timestamptz;synced_through timestamptz;
begin
 select * into strict cfg from bid_active_catalog_private.runtime where singleton;
 if cfg.current_sweep_scope_version=cfg.scope_version||':demolition-title-v1' and cfg.scope_version=bid_active_catalog_private.scope_version()
 then cutoff:=cfg.current_sweep_started_at;end if;
 select count(*) filter(where completed_at is not null),count(*) filter(where completed_at is null)
 into checked_count,pending_count from bid_active_catalog_private.sources
 where scope_version=cfg.scope_version and kind='current' and id like cfg.scope_version||':current:demolition-title-v1:%';
 select greatest(cutoff,max(completed_at)) into required_through from bid_active_catalog_private.sources
 where scope_version=cfg.scope_version and kind='current' and id like cfg.scope_version||':current:demolition-title-v1:%';
 select 2*count(*) into expected_count
 from generate_series('1995-10-01T00:00:00'::timestamp,date_trunc('month',cutoff at time zone 'Asia/Seoul'),interval '1 month');
 -- A current source page is not proof of current eligibility: complete latest
 -- revisions and participant conditions must also have been verified.
 with queue_facts as materialized (
   select v.type,v.number,case when g.revision>d.revision or g.revision=d.revision and g.source_updated_at>d.source_updated_at
     then g.latest else coalesce(d.notice,g.latest,'{}'::jsonb) end notice
   from bid_active_catalog_private.verification v
   left join bid_active_catalog_private.deadline_index d using(type,number)
   left join bid_active_catalog_private.groups g using(type,number)
   where v.scope_version=cfg.scope_version
 ),pending as (
   select d.type,d.number from bid_active_catalog_private.deadline_index d
   where bid_active_catalog_private.current_focus(d.notice) and d.deadline>stamp and bid_active_catalog_private.phase(d.notice,stamp) in ('마감 임박','진행중')
     and (d.verified_at is null or d.source_version is distinct from d.verified_version
       or d.notice->>'regionComplete' is distinct from 'true' or d.notice->>'licenseComplete' is distinct from 'true')
   union
   select q.type,q.number from queue_facts q where bid_active_catalog_private.current_focus(q.notice) and bid_active_catalog_private.safe_time(q.notice->>'deadline')>stamp
     and bid_active_catalog_private.phase(q.notice,stamp) in ('마감 임박','진행중')
 ) select (select count(*) from pending),
   (select count(*) from queue_facts q where (q.notice='{}'::jsonb or bid_active_catalog_private.safe_time(q.notice->>'deadline') is null)
     and coalesce(q.notice->>'noticeKind','') not like '%취소%' and coalesce(q.notice->>'status','')<>'취소'
     and q.notice->>'openingCompleted' is distinct from 'true')
 into verification_count,unknown_count;
 select count(*)=4 and bool_and(cursor_at>=required_through),case when count(*)=4 then min(cursor_at) end into live_ready,synced_through
 from bid_active_catalog_private.live_cursors where scope_version=cfg.scope_version;
 return jsonb_build_object('scope','demolition-title-v1','keywords',jsonb_build_array('철거','해체','석면','건설폐기물'),
   'cutoff',cutoff,'checked',checked_count,'pending',pending_count,
   'requiredThrough',required_through,'syncedThrough',synced_through,
   'verificationPending',verification_count,'globalUnknownPending',unknown_count,
   'complete',cutoff is not null and expected_count>0 and checked_count=expected_count and pending_count=0
     and verification_count=0 and coalesce(live_ready,false)
     and not cfg.storage_blocked and cfg.last_error is null and (cfg.retry_after_at is null or cfg.retry_after_at<=stamp));
end $$;

-- Keep the legacy claim limited to streams that it understands. Its auth,
-- configured/menu/quota/storage checks and lock order remain untouched.
do $$declare definition text;old_select text;new_select text;old_observed text;new_observed text;retry_anchor text;raw_anchor text;raw_guard text;seen_anchor text;begin
 select pg_get_functiondef('bid_active_catalog_private.worker_legacy(text,text,jsonb)'::regprocedure) into definition;
 if position('current-sweep-excluded-from-legacy' in definition)=0 then
   old_select:=$anchor$select id from bid_active_catalog_private.sources where scope_version=scope_value and completed_at is null and next_attempt<=stamp$anchor$;
   new_select:=$replacement$select id from bid_active_catalog_private.sources where scope_version=scope_value and completed_at is null and next_attempt<=stamp
     and kind<>'current' -- current-sweep-excluded-from-legacy$replacement$;
   if position(old_select in definition)=0 then raise exception 'Legacy source claim anchor changed';end if;
   definition:=replace(definition,old_select,new_select);
   if position('if job.kind<>''history'' then update bid_active_catalog_private.live_cursors' in definition)=0 then raise exception 'Live cursor source-kind anchor changed';end if;
   definition:=replace(definition,'if job.kind<>''history'' then update bid_active_catalog_private.live_cursors',
     'if job.kind in (''registered'',''modified'') then update bid_active_catalog_private.live_cursors');
   old_observed:=$anchor$from bid_active_catalog_private.known_heads() c
     where c.type=job.type and c.number=n->>'number'$anchor$;
   new_observed:=$replacement$from (
       select known.* from bid_active_catalog_private.known_heads() known
       union all
       -- A current scan reads raw identities even for a changed-away title.
       -- Recheck the old focused public head instead of silently keeping it.
       select d.type,d.number,d.revision,d.source_updated_at from bid_active_catalog_private.deadline_index d
       where job.kind='current' and bid_active_catalog_private.current_focus(d.notice)
         and d.type=job.type and d.number=n->>'number'
         and ((n->>'revision')::integer>d.revision or (n->>'revision')::integer=d.revision and source_time>d.source_updated_at)
         and not exists(select 1 from bid_active_catalog_private.known_heads() known where known.type=d.type and known.number=d.number)
     ) c
     where c.type=job.type and c.number=n->>'number'$replacement$;
   if position(old_observed in definition)=0 then raise exception 'Observed public current-head anchor changed';end if;
   definition:=replace(definition,old_observed,new_observed);
   retry_anchor:='next_attempt=least(bid_active_catalog_private.verification.next_attempt,stamp)';
   if position(retry_anchor in definition)=0 then raise exception 'Observed source retry anchor changed';end if;
   definition:=replace(definition,retry_anchor,
     'next_attempt=case when job.kind=''current'' then bid_active_catalog_private.verification.next_attempt else least(bid_active_catalog_private.verification.next_attempt,stamp) end');
   raw_anchor:=$a$expected:=(item->>'totalCount')::integer;received:=(item->>'receivedCount')::integer;$a$;
   raw_guard:=$a$expected:=(item->>'totalCount')::integer;received:=(item->>'receivedCount')::integer;
   if job.kind='current' then
     if jsonb_typeof(item->'rawIdentities') is distinct from 'array' or jsonb_array_length(item->'rawIdentities')<>received
       or exists(select 1 from jsonb_array_elements(item->'rawIdentities') raw where jsonb_typeof(raw)<>'string' or (raw#>>'{}')!~'^[A-Za-z0-9_-]{1,40}:[0-9]{3}$')
       or (select count(*)<>count(distinct raw#>>'{}') from jsonb_array_elements(item->'rawIdentities') raw) then
       raise exception 'Incomplete current raw source identities';end if;
     if exists(select 1 from jsonb_array_elements(item->'items') x where not ((x->>'number')||':'||(x->>'revision') in (select jsonb_array_elements_text(item->'rawIdentities'))))
       or exists(select 1 from jsonb_array_elements(item->'observed') x where x?'revision'
         and not ((x->>'number')||':'||(x->>'revision') in (select jsonb_array_elements_text(item->'rawIdentities')))) then
       raise exception 'Unobserved current raw source identity';end if;
   end if;$a$;
   if position(raw_anchor in definition)=0 then raise exception 'Current raw identity validation anchor changed';end if;
   definition:=replace(definition,raw_anchor,raw_guard);
   raw_anchor:=$a$or (select count(*)<>count(distinct (x->>'number')||':'||(x->>'revision')) from jsonb_array_elements(item->'items') x) then$a$;
   raw_guard:=$a$or (select count(*)<>count(distinct (x->>'number')||':'||(x->>'revision')) from jsonb_array_elements(item->'items') x)
     or (job.kind='current' and exists(select 1 from jsonb_array_elements_text(item->'rawIdentities') raw
       join bid_active_catalog_private.source_seen seen on seen.source_id=job.id and seen.identity=raw)) then$a$;
   if position(raw_anchor in definition)=0 then raise exception 'Current raw duplicate guard anchor changed';end if;
   definition:=replace(definition,raw_anchor,raw_guard);
   raw_anchor:=$a$-- The raw page is gone. Only transient identities of already retained heads$a$;
   raw_guard:=$a$if job.kind='current' then
     insert into bid_active_catalog_private.source_seen(source_id,identity)
       select job.id,raw from jsonb_array_elements_text(item->'rawIdentities') raw;
   end if;
   -- The raw page is gone. Only transient identities of already retained heads$a$;
   if position(raw_anchor in definition)=0 then raise exception 'Current raw identity persistence anchor changed';end if;
   definition:=replace(definition,raw_anchor,raw_guard);
   seen_anchor:=$a$insert into bid_active_catalog_private.source_seen(source_id,identity) values(job.id,identity_value);$a$;
   if position(seen_anchor in definition)=0 then raise exception 'Current personal identity persistence anchor changed';end if;
   definition:=replace(definition,seen_anchor,
     'if job.kind<>''current'' then '||seen_anchor||' end if;');
   execute definition;
 end if;
end $$;

do $$begin
 if to_regprocedure('bid_active_catalog_private.status_before_current()') is null then
   alter function bid_active_catalog_private.status() rename to status_before_current;
 end if;
 if to_regprocedure('bid_active_catalog_private.worker_before_current(text,text,jsonb)') is null then
   alter function public.bid_active_catalog_worker(text,text,jsonb) set schema bid_active_catalog_private;
   alter function bid_active_catalog_private.bid_active_catalog_worker(text,text,jsonb) rename to worker_before_current;
 end if;
end $$;
create or replace function bid_active_catalog_private.status()
returns jsonb language sql stable security invoker set search_path='' as $$
 select bid_active_catalog_private.status_before_current()||jsonb_build_object(
 'pendingSources',(select count(*) from bid_active_catalog_private.sources where scope_version=bid_active_catalog_private.scope_version() and kind<>'current' and completed_at is null),
 'currentCoverage',bid_active_catalog_private.current_coverage());
$$;

create or replace function public.bid_active_catalog_worker(p_token text,p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare outcome jsonb;cfg bid_active_catalog_private.runtime%rowtype;lease uuid;scope_value text;stamp timestamptz:=clock_timestamp();
 coverage jsonb;selected_ids text[];source_rows jsonb;missing_count bigint;cost bigint;cutoff timestamptz;initial_sweep boolean;current_limit integer:=8;focused_count bigint;
begin
 -- Every action first passes the existing audited token and payload gates.
 -- A successful claim already holds runtime and shared-alert row locks.
 if p_action='commit' then
   begin
     outcome:=bid_active_catalog_private.worker_before_current(p_token,p_action,p_payload);
     if outcome->>'ok'='true' and exists(select 1 from jsonb_array_elements(coalesce(p_payload->'sources','[]'::jsonb)) s
       join bid_active_catalog_private.sources source on source.id=s->>'id' where source.kind='current')
       and (bid_active_catalog_private.storage_bytes()>=16777216 or bid_alert_private.storage_bytes()>=33554432) then
       raise exception using errcode='54000',message='Current raw source identity capacity reached';end if;
     return outcome;
   exception when program_limit_exceeded then
     update bid_active_catalog_private.runtime set storage_blocked=true,last_error='기존 저장 한도 안의 현재 공고 확인 공간이 부족해 수집을 대기합니다.' where singleton;
     return jsonb_build_object('ok',false,'storageFull',true);
   end;
 end if;
 outcome:=bid_active_catalog_private.worker_before_current(p_token,p_action,p_payload);
 if p_action<>'claim' or outcome->>'leaseId' is null then return outcome;end if;
 if p_payload?'currentLimit' then
   if jsonb_typeof(p_payload->'currentLimit') is distinct from 'number' or p_payload->>'currentLimit'!~'^[0-9]+$'
     or (p_payload->>'currentLimit')::numeric not between 1 and 32 then
     raise exception using errcode='22023',message='현재 공고의 서버 수집 배치를 확인해 주세요.';end if;
   current_limit:=(p_payload->>'currentLimit')::integer;
 end if;
 lease:=(outcome->>'leaseId')::uuid;scope_value:=outcome->>'scopeVersion';
 select * into strict cfg from bid_active_catalog_private.runtime where singleton for update;
 if cfg.lease_id is distinct from lease or cfg.lease_until<=stamp or cfg.scope_version is distinct from scope_value
   or scope_value is distinct from bid_active_catalog_private.scope_version() then raise exception using errcode='42501',message='현재 공고 수집 임대를 확인해 주세요.';end if;
 begin
   initial_sweep:=cfg.current_sweep_started_at is null or cfg.current_sweep_scope_version is distinct from scope_value||':demolition-title-v1';
   if initial_sweep then
     cutoff:=date_trunc('minute',stamp);
     update bid_active_catalog_private.runtime set current_sweep_started_at=cutoff,current_sweep_scope_version=scope_value||':demolition-title-v1' where singleton;
   else cutoff:=cfg.current_sweep_started_at;end if;
   select count(*) into missing_count from generate_series('1995-10-01T00:00:00'::timestamp,date_trunc('month',cutoff at time zone 'Asia/Seoul'),interval '1 month') m
     cross join (values('공사'),('용역')) t(type)
     where not exists(select 1 from bid_active_catalog_private.sources s where s.id=scope_value||':current:demolition-title-v1:'||t.type||':'||to_char(m,'YYYY-MM'));
   select count(*) into focused_count from bid_active_catalog_private.deadline_index d where initial_sweep
     and bid_active_catalog_private.current_focus(d.notice) and d.deadline>stamp
     and bid_active_catalog_private.phase(d.notice,stamp) in ('마감 임박','진행중')
     and not exists(select 1 from bid_active_catalog_private.verification v where v.type=d.type and v.number=d.number);
   cost:=missing_count*1024+focused_count*1536+65536;
   if bid_active_catalog_private.storage_bytes()+cost>=cfg.storage_ceiling or bid_alert_private.storage_bytes()+cost>=33554432 then
     raise exception using errcode='54000',message='Current source coverage metadata exceeded existing capacity';end if;
   insert into bid_active_catalog_private.sources(id,type,kind,from_at,to_at,scope_version)
   select scope_value||':current:demolition-title-v1:'||t.type||':'||to_char(m,'YYYY-MM'),t.type,'current',m at time zone 'Asia/Seoul',
     least((m+interval '1 month') at time zone 'Asia/Seoul'-interval '1 minute',cutoff),scope_value
   from generate_series('1995-10-01T00:00:00'::timestamp,date_trunc('month',cutoff at time zone 'Asia/Seoul'),interval '1 month') m
     cross join (values('공사'),('용역')) t(type) on conflict do nothing;
   -- A filtered provider list can omit a latest cancellation entirely. Recheck
   -- previously retained focused heads once so old verified facts cannot turn
   -- absence from the filtered list into a false completeness claim.
   insert into bid_active_catalog_private.verification(type,number,revision,source_updated_at,scope_version,source_version)
   select d.type,d.number,d.revision,d.source_updated_at,scope_value,d.source_version
   from bid_active_catalog_private.deadline_index d where initial_sweep and bid_active_catalog_private.current_focus(d.notice)
     and d.deadline>stamp and bid_active_catalog_private.phase(d.notice,stamp) in ('마감 임박','진행중')
   on conflict(type,number) do nothing;
   if bid_active_catalog_private.storage_bytes()+65536>=cfg.storage_ceiling or bid_alert_private.storage_bytes()+65536>=33554432 then
     raise exception using errcode='54000',message='Current source coverage capacity reached';end if;
 exception when program_limit_exceeded then
   -- Savepoint rolls back only current metadata; preserve all existing queues,
   -- leases, retries, source checkpoints and previously collected records.
   update bid_active_catalog_private.runtime set storage_blocked=true,last_error='기존 저장 한도 안의 현재 공고 확인 공간이 부족해 수집을 대기합니다.' where singleton;
 end;
 coverage:=bid_active_catalog_private.current_coverage();
 if coverage->>'complete' is distinct from 'true' then
   update bid_active_catalog_private.sources set claimed_lease=null where claimed_lease=lease and kind='history';
 end if;
 select coalesce(array_agg(id order by from_at desc,type,id),'{}'::text[]) into selected_ids from (
   select id,from_at,type from bid_active_catalog_private.sources where scope_version=scope_value and kind='current'
     and id like scope_value||':current:demolition-title-v1:%' and completed_at is null and next_attempt<=stamp
     order by from_at desc,type,id limit current_limit
 ) chosen;
 update bid_active_catalog_private.sources set claimed_lease=lease where id=any(selected_ids);
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'type',type,'kind',kind,'from',from_at,'to',to_at,
   'page',page,'pageSize',999,'totalCount',expected_total)
   order by case when kind in ('registered','modified') then 0 when kind='current' then 1 else 2 end,from_at desc,type,kind),'[]'::jsonb)
 into source_rows from bid_active_catalog_private.sources where claimed_lease=lease and scope_version=scope_value;
 return outcome||jsonb_build_object('sources',source_rows,'status',bid_active_catalog_private.status());
end $$;

-- Expose honest current-only coverage beside the unchanged historical field.
-- This is transport metadata, so it does not invalidate signed result pages.
do $$declare definition text;anchor text:=$a$'indexCoverage',coverage,'sourceSyncedThrough',synced$a$;begin
 select pg_get_functiondef('bid_active_catalog_private.search_page(jsonb)'::regprocedure) into definition;
 if position('''currentCoverage'',bid_active_catalog_private.current_coverage()' in definition)=0 then
   if position(anchor in definition)=0 then raise exception 'Search coverage response anchor changed';end if;
   definition:=replace(definition,anchor,$a$'indexCoverage',coverage,'currentCoverage',bid_active_catalog_private.current_coverage(),'sourceSyncedThrough',synced$a$);
   execute definition;
 end if;
end $$;
revoke all on function bid_active_catalog_private.current_coverage() from public,anon,authenticated;
revoke all on function bid_active_catalog_private.current_focus(jsonb) from public,anon,authenticated;
revoke all on function bid_active_catalog_private.status_before_current() from public,anon,authenticated;
revoke all on function bid_active_catalog_private.status() from public,anon,authenticated;
revoke all on function bid_active_catalog_private.worker_before_current(text,text,jsonb) from public,anon,authenticated;
revoke all on function public.bid_active_catalog_worker(text,text,jsonb) from public;
grant execute on function public.bid_active_catalog_worker(text,text,jsonb) to anon,authenticated;
do $$begin
 if bid_active_catalog_private.storage_bytes()>=16777216 or bid_alert_private.storage_bytes()>=33554432 then
   raise exception using errcode='54000',message='Existing storage budget cannot fit current source coverage';end if;
end $$;
commit;
