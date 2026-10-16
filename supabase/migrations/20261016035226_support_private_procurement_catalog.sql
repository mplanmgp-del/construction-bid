-- Private Nuri notices share compact storage, authenticated leases and budgets.
-- Real submission deadlines remain nullable; only an explicitly separate search
-- date may use a private notice's posting date. Opening time is never a deadline.
begin;
alter table bid_active_catalog_private.deadline_index alter column deadline drop not null;
alter table bid_active_catalog_private.deadline_index add column if not exists search_at timestamptz
 generated always as (coalesce(deadline,case when notice->>'procurementSource'='private'
   then bid_active_catalog_private.safe_time(notice->>'postedAt') end)) stored;
create index if not exists bid_notice_search_range on bid_active_catalog_private.deadline_index(search_at,type,number);
alter table bid_active_catalog_private.sources add column if not exists procurement_source text not null default 'public'
 check(procurement_source in ('public','private'));
alter table bid_active_catalog_private.verification add column if not exists procurement_source text
 check(procurement_source in ('public','private'));
alter table bid_active_catalog_private.runtime add column if not exists private_sweep_started_at timestamptz;
alter table bid_active_catalog_private.runtime add column if not exists private_sweep_scope_version text;
-- Do not mix provider cursors: the public provider exposes registered/modified;
-- private transport maps registered to registration div1 and modified to posting
-- div2. There is no assumed private modification endpoint.
create table if not exists bid_active_catalog_private.private_cursors (
 type text not null check(type in ('공사','용역')),kind text not null check(kind in ('registered','modified')),
 cursor_at timestamptz not null,scope_version text not null,primary key(scope_version,type,kind)
);
alter table bid_active_catalog_private.private_cursors enable row level security;
revoke all on bid_active_catalog_private.private_cursors from public,anon,authenticated;
create or replace function bid_active_catalog_private.verification_provider_hint()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.procurement_source is null then
   select coalesce(d.notice->>'procurementSource',g.latest->>'procurementSource') into new.procurement_source
   from(values(1))seed(n)
   left join bid_active_catalog_private.deadline_index d on d.type=new.type and d.number=new.number
   left join bid_active_catalog_private.groups g on g.type=new.type and g.number=new.number;
 end if;
 return new;
end $$;
drop trigger if exists bid_verification_provider_hint on bid_active_catalog_private.verification;
create trigger bid_verification_provider_hint before insert or update on bid_active_catalog_private.verification
for each row execute function bid_active_catalog_private.verification_provider_hint();
revoke all on function bid_active_catalog_private.verification_provider_hint() from public,anon,authenticated;

create or replace function bid_active_catalog_private.ongoing(p_notice jsonb,p_now timestamptz default now())
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare closing timestamptz;opening timestamptz;
begin
 if p_notice is null or p_notice->>'status'='취소' or coalesce(p_notice->>'noticeKind','') like '%취소%'
   or p_notice->>'openingCompleted'='true' then return false;end if;
 closing:=bid_active_catalog_private.safe_time(p_notice->>'deadline');
 opening:=bid_active_catalog_private.safe_time(p_notice->>'openingAt');
 if closing is null and btrim(coalesce(p_notice->>'deadline',''))<>'' then return false;end if;
 if opening is null and btrim(coalesce(p_notice->>'openingAt',''))<>'' then return false;end if;
 if opening is not null and (not isfinite(opening) or opening<=p_now) then return false;end if;
 if closing is null then
   return coalesce(p_notice->>'procurementSource'='private',false) and opening is not null and isfinite(opening) and opening>p_now;
 end if;
 if not isfinite(closing) then return false;end if;
 return coalesce(closing>p_now or opening>p_now,false);
end $$;

-- Public coverage continues to describe exactly its original provider. The
-- private monthly sources have their own ID namespace and coverage object.
do $$declare definition text;fn text;begin
 foreach fn in array array['bid_active_catalog_private.status_before_current()',
   'bid_active_catalog_private.status()','bid_active_catalog_private.index_coverage()',
   'bid_active_catalog_private.current_coverage()'] loop
   select replace(pg_get_functiondef(fn::regprocedure),E'\r\n',E'\n') into definition;
   if position('private-public-coverage-isolated-v1' in definition)>0 then continue;end if;
   definition:=replace(definition,'from bid_active_catalog_private.sources where ',
     'from bid_active_catalog_private.sources where procurement_source=''public'' /* private-public-coverage-isolated-v1 */ and ');
   definition:=replace(definition,'where s.kind=', 'where s.procurement_source=''public'' and s.kind=');
   definition:=replace(definition,'where gap.kind=', 'where gap.procurement_source=''public'' and gap.kind=');
   if fn like '%current_coverage%' then
     definition:=replace(definition,'where scope_version=cfg.scope_version and kind=''current''',
       'where procurement_source=''public'' /* private-public-coverage-isolated-v1 */ and scope_version=cfg.scope_version and kind=''current''');
     definition:=replace(definition,'where bid_active_catalog_private.current_focus(d.notice)',
       'where coalesce(d.notice->>''procurementSource'',''public'')=''public'' and bid_active_catalog_private.current_focus(d.notice)');
     definition:=replace(definition,'where v.scope_version=cfg.scope_version',
       'where v.scope_version=cfg.scope_version and coalesce(v.procurement_source,''public'')=''public''');
     definition:=replace(definition,'from queue_facts q where ',
       'from queue_facts q where coalesce(q.notice->>''procurementSource'',''public'')=''public'' and ');
   end if;
   execute definition;
 end loop;
end $$;

-- Retain the previous public phase logic and add one truthful review state.
do $$declare definition text;anchor text;begin
 select replace(pg_get_functiondef('bid_active_catalog_private.phase(jsonb,timestamptz)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('private-unknown-deadline-phase-v1' in definition)=0 then
   anchor:=$a$if starting>p_at or starting is null$a$;
   if position(anchor in definition)=0 then raise exception 'Audited schedule phase anchor changed';end if;
   execute replace(definition,anchor,$a$-- private-unknown-deadline-phase-v1
 if closing is null and p_notice->>'procurementSource'='private' and opening>p_at then return '확인필요';end if;
 if starting>p_at or starting is null$a$);
 end if;
 select replace(pg_get_functiondef('bid_active_catalog_private.compact(jsonb)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('''procurementSource''' in definition)=0 then
   anchor:=$a$'sourceOmittedDigest','openingCompleted'$a$;
   if position(anchor in definition)=0 then raise exception 'Audited compact allowlist anchor changed';end if;
   execute replace(definition,anchor,$a$'sourceOmittedDigest','openingCompleted','procurementSource','bidMethod'$a$);
 end if;
 select replace(pg_get_functiondef('bid_active_catalog_private.search_match(jsonb,jsonb,jsonb,timestamptz)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('private-real-deadline-filter-v1' in definition)=0 then
   anchor:=$a$closing_day:=(bid_active_catalog_private.safe_time(p_notice->>'deadline') at time zone 'Asia/Seoul')::date;$a$;
   if position(anchor in definition)=0 then raise exception 'Audited real deadline filter anchor changed';end if;
   execute replace(definition,anchor,anchor||$a$
 -- private-real-deadline-filter-v1: explicit deadline filters require a real deadline.
 if closing_day is null and (coalesce(p_filters->>'deadlineFrom','')<>'' or coalesce(p_filters->>'deadlineTo','')<>'') then return 'excluded';end if;$a$);
 end if;
end $$;

-- Null handling changes only actual deadline writes. All existing source-version,
-- invalidation, source-page/index fences, publication and capacity gates remain.
do $$declare definition text;fn text;anchor text;replacement text;source_start integer;source_end integer;source_body text;begin
 foreach fn in array array['bid_active_catalog_private.worker_deadline(text,text,jsonb)',
   'bid_active_catalog_private.worker_before_current(text,text,jsonb)'] loop
   select replace(pg_get_functiondef(fn::regprocedure),E'\r\n',E'\n') into definition;
   definition:=replace(definition,$a$(n->>'deadline')::timestamptz$a$,$a$nullif(n->>'deadline','')::timestamptz$a$);
   definition:=replace(definition,$a$(head->>'deadline')::timestamptz$a$,$a$nullif(head->>'deadline','')::timestamptz$a$);
   if fn like '%worker_deadline%' and position('private-source-candidate-v1' in definition)=0 then
     anchor:=$a$if n->>'type' is distinct from job.type or coalesce(n->>'number','')!~'^[A-Za-z0-9_-]{1,40}$'$a$;
     if position(anchor in definition)=0 then raise exception 'Audited source candidate identity gate changed';end if;
     -- Applies to candidate and removal loops: neither provider can masquerade
     -- as the other for an already leased source.
     replacement:=$a$if n->>'type' is distinct from job.type
       or coalesce(n->>'procurementSource','public') is distinct from job.procurement_source -- private-source-candidate-v1
       or coalesce(n->>'number','')!~'^[A-Za-z0-9_-]{1,40}$'$a$;
     -- Removed identity transport intentionally has no provider field. Only the
     -- first candidate loop receives this guard; removal uses its leased job.
     definition:=overlay(definition placing replacement from position(anchor in definition) for length(anchor));
   end if;
   execute definition;
 end loop;
 select replace(pg_get_functiondef('bid_active_catalog_private.worker_legacy(text,text,jsonb)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('private-cursors-isolated-v1' in definition)=0 then
   anchor:=$a$where type=typ and kind=kind_value and scope_version=scope_value and completed_at is null$a$;
   if position(anchor in definition)=0 then raise exception 'Audited public live source guard changed';end if;
   definition:=replace(definition,anchor,anchor||$a$ and procurement_source='public'$a$);
   anchor:=$a$and kind<>'current' -- current-sweep-excluded-from-legacy$a$;
   if position(anchor in definition)=0 then raise exception 'Audited public source selection changed';end if;
   definition:=replace(definition,anchor,$a$and kind<>'current' and procurement_source='public' -- current-sweep-excluded-from-legacy; private-cursors-isolated-v1$a$);
   anchor:=$a$if job.kind in ('registered','modified') then update bid_active_catalog_private.live_cursors$a$;
   if position(anchor in definition)=0 then raise exception 'Audited public cursor acknowledgement changed';end if;
   definition:=replace(definition,anchor,$a$if job.kind in ('registered','modified') and job.procurement_source='public' then update bid_active_catalog_private.live_cursors$a$);
   execute definition;
 end if;
 if position('private-source-queue-provider-v1' in definition)=0 then
   source_start:=position($a$for item in select value from jsonb_array_elements(coalesce(p_payload->'sources','[]'::jsonb)) loop$a$ in definition);
   source_end:=position($a$for g in select value from jsonb_array_elements(coalesce(p_payload->'groups','[]'::jsonb)) loop$a$ in definition);
   if source_start<=0 or source_end<=source_start then raise exception 'Audited source enqueue boundaries changed';end if;
   source_body:=substring(definition from source_start for source_end-source_start);
   anchor:='insert into bid_active_catalog_private.verification(type,number,revision,source_updated_at,scope_version)';
   if (length(source_body)-length(replace(source_body,anchor,'')))/length(anchor)<>2 then raise exception 'Audited source verification enqueues changed';end if;
   source_body:=replace(source_body,anchor,'insert into bid_active_catalog_private.verification(type,number,revision,source_updated_at,scope_version,procurement_source)');
   source_body:=replace(source_body,',cfg.scope_version',',cfg.scope_version,job.procurement_source');
   source_body:=replace(source_body,'scope_version=excluded.scope_version','scope_version=excluded.scope_version,procurement_source=excluded.procurement_source');
   definition:=overlay(definition placing E'-- private-source-queue-provider-v1\n '||source_body from source_start for source_end-source_start);
   execute definition;
 end if;
end $$;

-- Use search_at only for the outer query range and expiration boundary scan.
-- Deadline sorting and schedule phases continue to use the actual nullable field.
do $$declare definition text;fn text;changed boolean:=false;begin
 foreach fn in array array['bid_active_catalog_private.search_page(jsonb)',
   'bid_active_catalog_private.search_results(jsonb)','bid_active_catalog_private.search_status(jsonb)',
   'bid_active_catalog_private.request_search_verification(jsonb)'] loop
   select replace(pg_get_functiondef(fn::regprocedure),E'\r\n',E'\n') into definition;
   if position('private-search-date-v1' in definition)>0 then continue;end if;
   if position('d.deadline>=' in definition)=0 or position('isfinite(d.deadline)' in definition)=0 then
     raise exception 'Audited range boundary changed for %',fn;end if;
   definition:=replace(replace(definition,'d.deadline>=','d.search_at>='),'d.deadline<(','d.search_at<(');
   definition:=replace(definition,'isfinite(d.deadline)','isfinite(d.search_at)');
   -- Query safety still requires a future actual deadline or future opening.
   definition:=replace(definition,'begin',E'begin\n -- private-search-date-v1\n');
   execute definition;changed:=true;
 end loop;
 if changed then update bid_active_catalog_private.runtime set search_generation=search_generation+1,search_changed_xid=txid_current() where singleton;end if;
end $$;

create or replace function bid_active_catalog_private.private_coverage()
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare cfg bid_active_catalog_private.runtime%rowtype;checked_count bigint;pending_count bigint;expected_count bigint;
 verification_count bigint;synced timestamptz;live_ready boolean;
begin
 select * into strict cfg from bid_active_catalog_private.runtime where singleton;
 select count(*) filter(where completed_at is not null),count(*) filter(where completed_at is null) into checked_count,pending_count
 from bid_active_catalog_private.sources where procurement_source='private' and kind='current' and scope_version=cfg.scope_version
   and id like cfg.scope_version||':private-current:%';
 select 2*count(*) into expected_count from generate_series('1995-10-01T00:00:00'::timestamp,
   date_trunc('month',cfg.private_sweep_started_at at time zone 'Asia/Seoul'),interval '1 month');
 select count(*) into verification_count from(
   select d.type,d.number from bid_active_catalog_private.deadline_index d
   where d.notice->>'procurementSource'='private' and bid_active_catalog_private.ongoing(d.notice)
     and (d.verified_at is null or d.source_version is distinct from d.verified_version)
   union select v.type,v.number from bid_active_catalog_private.verification v
   left join bid_active_catalog_private.deadline_index d using(type,number)
   left join bid_active_catalog_private.groups g using(type,number)
   where v.scope_version=cfg.scope_version and coalesce(v.procurement_source,d.notice->>'procurementSource',g.latest->>'procurementSource')='private'
 )pending;
 select count(*)=4 and bool_and(cursor_at>=cfg.private_sweep_started_at),case when count(*)=4 then min(cursor_at) end into live_ready,synced
 from bid_active_catalog_private.private_cursors where scope_version=cfg.scope_version;
 return jsonb_build_object('scope','private-nuri-v1','cutoff',cfg.private_sweep_started_at,'checked',checked_count,'pending',pending_count,
   'verificationPending',verification_count,'syncedThrough',synced,
   'complete',cfg.private_sweep_started_at is not null and expected_count>0 and checked_count=expected_count and pending_count=0
     and verification_count=0 and coalesce(live_ready,false) and not cfg.storage_blocked and cfg.last_error is null);
end $$;
revoke all on function bid_active_catalog_private.private_coverage() from public,anon,authenticated;

-- Preserve the existing public function chain; only the token-authenticated
-- wrapper can seed/claim the provider's independent sources or expose coverage.
do $$begin
 if to_regprocedure('bid_active_catalog_private.worker_before_private(text,text,jsonb)') is null then
   alter function public.bid_active_catalog_worker(text,text,jsonb) set schema bid_active_catalog_private;
   alter function bid_active_catalog_private.bid_active_catalog_worker(text,text,jsonb) rename to worker_before_private;
 end if;
end $$;
do $$declare definition text;anchor text;begin
 select replace(pg_get_functiondef('bid_active_catalog_private.worker_before_private(text,text,jsonb)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('private-public-claim-isolated-v1' in definition)=0 then
   definition:=replace(definition,'where scope_version=scope_value and kind=''current''',
     'where procurement_source=''public'' /* private-public-claim-isolated-v1 */ and scope_version=scope_value and kind=''current''');
   definition:=replace(definition,'from bid_active_catalog_private.sources where claimed_lease=lease and scope_version=scope_value',
     'from bid_active_catalog_private.sources where procurement_source=''public'' and claimed_lease=lease and scope_version=scope_value');
   definition:=replace(definition,'where scope_version=bid_active_catalog_private.scope_version() and kind<>''current''',
     'where procurement_source=''public'' and scope_version=bid_active_catalog_private.scope_version() and kind<>''current''');
   definition:=replace(definition,'where initial_sweep and bid_active_catalog_private.current_focus(d.notice)',
     'where initial_sweep and coalesce(d.notice->>''procurementSource'',''public'')=''public'' and bid_active_catalog_private.current_focus(d.notice)');
   execute definition;
 end if;
 select replace(pg_get_functiondef('bid_active_catalog_private.prioritize_search_verification(uuid,text,timestamptz)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('private-verification-provider-hint-v1' in definition)=0 then
   anchor:=$a$'sourceUpdatedAt',v.source_updated_at,'tracked',$a$;
   if position(anchor in definition)=0 then raise exception 'Audited verification provider projection changed';end if;
   execute replace(definition,anchor,$a$'sourceUpdatedAt',v.source_updated_at,
   'procurementSource',coalesce(v.procurement_source,d.notice->>'procurementSource',(select g.latest->>'procurementSource' from bid_active_catalog_private.groups g
     where g.type=v.type and g.number=v.number),'public'), -- private-verification-provider-hint-v1
   'tracked',$a$);
 end if;
end $$;
create or replace function public.bid_active_catalog_worker(p_token text,p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare outcome jsonb;cfg bid_active_catalog_private.runtime%rowtype;stamp timestamptz:=clock_timestamp();lease uuid;scope_value text;
 cutoff timestamptz;missing_count bigint;cost bigint;selected_ids text[];private_rows jsonb;coverage jsonb;
 typ text;kind_value text;start_at timestamptz;endpoint_at timestamptz;
begin
 -- Authentication/payload/lease guards and the catalog -> alert lock order are
 -- enforced by the audited worker before any new private-schema operation.
 outcome:=bid_active_catalog_private.worker_before_private(p_token,p_action,p_payload);
 if p_action in ('search_page','search_status') then
   coverage:=bid_active_catalog_private.private_coverage();
   return outcome||jsonb_build_object('privateCoverage',coverage,'warnings',coalesce(outcome->'warnings','[]'::jsonb)
     ||case when coverage->>'complete'='true' then '[]'::jsonb else '["민간누리 공고 수집·검증이 진행 중입니다. 민간 공고는 확인한 범위의 결과입니다."]'::jsonb end);
 end if;
 if p_action='commit' and outcome->>'ok'='true' then
   -- Only a successfully committed final page advances its matching private
   -- cursor. Failed, restarted, unindexed or stale pages cannot reach this path.
   update bid_active_catalog_private.private_cursors cursor set cursor_at=greatest(cursor.cursor_at,s.to_at)
   from bid_active_catalog_private.sources s where s.procurement_source='private' and s.completed_at is not null
     and s.id in(select x->>'id' from jsonb_array_elements(coalesce(p_payload->'sources','[]'::jsonb)) x)
     and cursor.scope_version=s.scope_version and cursor.type=s.type and cursor.kind=s.kind;
   return outcome;
 end if;
 if p_action<>'claim' or outcome->>'leaseId' is null then return outcome;end if;
 lease:=(outcome->>'leaseId')::uuid;scope_value:=outcome->>'scopeVersion';
 select * into strict cfg from bid_active_catalog_private.runtime where singleton for update;
 if cfg.lease_id is distinct from lease or cfg.lease_until<=stamp or cfg.scope_version is distinct from scope_value
   or scope_value is distinct from bid_active_catalog_private.scope_version() then raise exception using errcode='42501',message='민간 공고 수집 임대를 확인해 주세요.';end if;
 begin
   if cfg.private_sweep_started_at is null or cfg.private_sweep_scope_version is distinct from scope_value then
     cutoff:=date_trunc('minute',stamp);
     update bid_active_catalog_private.runtime set private_sweep_started_at=cutoff,private_sweep_scope_version=scope_value where singleton;
   else cutoff:=cfg.private_sweep_started_at;end if;
   select count(*) into missing_count from generate_series('1995-10-01T00:00:00'::timestamp,date_trunc('month',cutoff at time zone 'Asia/Seoul'),interval '1 month') m
     cross join(values('공사'),('용역')) t(type) where not exists(select 1 from bid_active_catalog_private.sources s
       where s.id=scope_value||':private-current:'||t.type||':'||to_char(m,'YYYY-MM'));
   cost:=missing_count*1024+8192+65536;
   if bid_active_catalog_private.storage_bytes()+cost>=cfg.storage_ceiling or bid_alert_private.storage_bytes()+cost>=33554432 then
     raise exception using errcode='54000',message='Private source metadata exceeds existing allocation';end if;
   insert into bid_active_catalog_private.sources(id,type,kind,from_at,to_at,scope_version,procurement_source)
   select scope_value||':private-current:'||t.type||':'||to_char(m,'YYYY-MM'),t.type,'current',m at time zone 'Asia/Seoul',
     least((m+interval '1 month') at time zone 'Asia/Seoul'-interval '1 minute',cutoff),scope_value,'private'
   from generate_series('1995-10-01T00:00:00'::timestamp,date_trunc('month',cutoff at time zone 'Asia/Seoul'),interval '1 month') m
     cross join(values('공사'),('용역')) t(type) on conflict do nothing;
   insert into bid_active_catalog_private.private_cursors(type,kind,cursor_at,scope_version)
   select t.type,k.kind,date_trunc('minute',stamp)-interval '20 minutes',scope_value from(values('공사'),('용역'))t(type)
     cross join(values('registered'),('modified'))k(kind) on conflict do nothing;
   for typ,kind_value,start_at in select type,kind,cursor_at from bid_active_catalog_private.private_cursors where scope_version=scope_value loop
     if not exists(select 1 from bid_active_catalog_private.sources where procurement_source='private' and type=typ and kind=kind_value
       and scope_version=scope_value and completed_at is null) and start_at<=date_trunc('minute',stamp)-interval '10 minutes' then
       endpoint_at:=least(date_trunc('minute',stamp),start_at+interval '1 hour');
       insert into bid_active_catalog_private.sources(id,type,kind,from_at,to_at,scope_version,procurement_source)
       values(scope_value||':private:'||kind_value||':'||typ||':'||extract(epoch from endpoint_at)::bigint,typ,kind_value,
         start_at-interval '2 minutes',endpoint_at,scope_value,'private') on conflict do nothing;
     end if;
   end loop;
   if bid_active_catalog_private.storage_bytes()+65536>=cfg.storage_ceiling or bid_alert_private.storage_bytes()+65536>=33554432 then
     raise exception using errcode='54000',message='Private source capacity reached';end if;
 exception when program_limit_exceeded then
   update bid_active_catalog_private.runtime set storage_blocked=true,last_error='기존 저장 한도 안의 민간 공고 확인 공간이 부족해 수집을 대기합니다.' where singleton;
 end;
 -- Four independent recent streams and two monthly windows receive bounded
 -- early call slots; public jobs keep their existing order after these jobs.
 select coalesce(array_agg(id order by lane,from_at desc,type,kind),'{}'::text[]) into selected_ids from(
   (select id,from_at,type,kind,0 lane from bid_active_catalog_private.sources where procurement_source='private' and kind in('registered','modified')
      and scope_version=scope_value and completed_at is null and next_attempt<=stamp order by from_at,type,kind limit 4)
   union all
   (select id,from_at,type,kind,1 lane from bid_active_catalog_private.sources where procurement_source='private' and kind='current'
      and scope_version=scope_value and completed_at is null and next_attempt<=stamp order by from_at desc,type,kind limit 2)
 ) selected;
 update bid_active_catalog_private.sources set claimed_lease=lease where id=any(selected_ids);
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'type',s.type,'kind',s.kind,'from',s.from_at,'to',s.to_at,
   'page',s.page,'pageSize',999,'totalCount',s.expected_total,'procurementSource','private') order by chosen.ordinal),'[]'::jsonb)
 into private_rows from unnest(selected_ids) with ordinality chosen(id,ordinal) join bid_active_catalog_private.sources s using(id);
 coverage:=bid_active_catalog_private.private_coverage();
 return outcome||jsonb_build_object('sources',private_rows||coalesce(outcome->'sources','[]'::jsonb),
   'status',coalesce(outcome->'status','{}'::jsonb)||jsonb_build_object('privateCoverage',coverage));
end $$;
revoke all on function bid_active_catalog_private.worker_before_private(text,text,jsonb) from public,anon,authenticated;
revoke all on function public.bid_active_catalog_worker(text,text,jsonb) from public;
grant execute on function public.bid_active_catalog_worker(text,text,jsonb) to anon,authenticated;
do $$begin
 if bid_active_catalog_private.storage_bytes()>=(select storage_ceiling from bid_active_catalog_private.runtime where singleton)
   or bid_alert_private.storage_bytes()>=33554432 then
   raise exception using errcode='54000',message='Private notice metadata does not fit existing allocation';end if;
end $$;
commit;
