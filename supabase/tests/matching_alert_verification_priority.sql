-- Disposable matching demand regression; no real provider, cron or push calls.
begin;
update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8'));
update public.bid_menu_settings set locked=false where menu_key='notices';
insert into auth.users(id,email)values('74747474-7474-4474-8474-747474747474','matching-priority@example.invalid');
insert into public.bid_alert_settings(user_id,settings)
values('74747474-7474-4474-8474-747474747474',bid_alert_private.defaults()||jsonb_build_object('enabled',true,'activatedAt',now()-interval '1 day'));
create function pg_temp.matching_priority_notice(p_number text,p_days integer default 30)
returns jsonb language sql as $$select jsonb_build_object('id','g2b:공사:'||p_number||':000','number',p_number,'revision','000','type','공사',
 'title',case when p_number like 'R26URGENT%' then '석면 공사' else '철거 공사' end,'agency','공공기관','category','철거·해체',
 'province','서울특별시','district','강남구','postedAt',now()-interval '2 days','sourceUpdatedAt',now()-interval '1 day',
 'biddingStartAt',now()-interval '1 day','deadline',now()+make_interval(days=>p_days),'openingAt',now()+make_interval(days=>p_days+1),
 'source','live','status','접수중','allowedRegions','[]'::jsonb,'licenses','[]'::jsonb,'regionComplete',true,'licenseComplete',true)$$;
create function pg_temp.seed_matching_priority(n jsonb)
returns void language sql as $$insert into bid_active_catalog_private.deadline_index(type,number,revision,notice,source_updated_at,deadline,opening_at,verified_at,source_version,verified_version)
 values(n->>'type',n->>'number',0,bid_active_catalog_private.compact(n),(n->>'sourceUpdatedAt')::timestamptz,(n->>'deadline')::timestamptz,(n->>'openingAt')::timestamptz,
 now(),bid_active_catalog_private.source_version(bid_active_catalog_private.compact(n)),bid_active_catalog_private.source_version(bid_active_catalog_private.compact(n)))$$;
create function pg_temp.matching_priority_payload(p_lease text,p_number text)
returns jsonb language sql as $$select jsonb_build_object('leaseId',p_lease,'observations',jsonb_build_array(jsonb_build_object('key','g2b:공사:'||p_number,
 'version',1,'fingerprint',repeat('a',64),'notice',pg_temp.matching_priority_notice(p_number))),'matchingKeys',jsonb_build_array('g2b:공사:'||p_number))$$;
create temporary table matching_priority_state(lease text,scope text,rule_key text);
do $$declare c jsonb;l text;s text;n jsonb;p jsonb;r jsonb;before_state jsonb;key_value text;i integer;retry_at timestamptz;failed boolean;begin
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');s:=c->>'scopeVersion';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',c->>'leaseId'));
 c:=public.bid_alert_worker(repeat('a',64),'claim','{}');l:=c->>'leaseId';assert l is not null;
 for i in 1..4 loop
  key_value:='R26MATCH'||i;n:=pg_temp.matching_priority_notice(key_value);perform pg_temp.seed_matching_priority(n);
  p:=pg_temp.matching_priority_payload(l,key_value);r:=public.bid_alert_worker(repeat('a',64),'commit',p);assert r->>'storageFull'='false';
 end loop;
 assert(select count(*)=4 from bid_active_catalog_private.verification where number like 'R26MATCH%'),'accepted matching keys enqueue every current matching head';
 key_value:='alerts:'||encode(sha256(convert_to(bid_active_catalog_private.rules()::text,'UTF8')),'hex');
 assert(select bool_and(v.search_request_key=key_value and v.search_requested_at is not null and v.revision=d.revision
   and v.source_updated_at=d.source_updated_at and v.source_version=d.source_version)from bid_active_catalog_private.verification v
   join bid_active_catalog_private.deadline_index d using(type,number)where v.number like 'R26MATCH%'),'queue markers and minimum facts use current rules and indexed heads';
 insert into matching_priority_state values(l,s,key_value);
 -- Repeated matches can raise priority but never erase failure/backoff/lease or newer facts.
 retry_at:=clock_timestamp()+interval '1 hour';
 update bid_active_catalog_private.verification set next_attempt=retry_at,failures=3,last_error='keep retry',claimed_lease=gen_random_uuid()where number='R26MATCH1';
 select to_jsonb(v)-array['search_request_key','search_requested_at']into before_state from bid_active_catalog_private.verification v where number='R26MATCH1';
 perform public.bid_alert_worker(repeat('a',64),'commit',pg_temp.matching_priority_payload(l,'R26MATCH1'));
 assert(select to_jsonb(v)-array['search_request_key','search_requested_at']=before_state from bid_active_catalog_private.verification v where number='R26MATCH1'),'existing retry state and lease survive repeated matching demand';
 update bid_active_catalog_private.verification set revision=1,source_updated_at=now(),source_version=repeat('f',64)where number='R26MATCH2';
 perform public.bid_alert_worker(repeat('a',64),'commit',pg_temp.matching_priority_payload(l,'R26MATCH2'));
 assert(select revision=1 and source_updated_at=now() and source_version=repeat('f',64)from bid_active_catalog_private.verification where number='R26MATCH2'),'current index demand never downgrades a newer queued minimum';
 update bid_active_catalog_private.verification set source_updated_at=null,source_version=null where number='R26MATCH3';
 perform public.bid_alert_worker(repeat('a',64),'commit',pg_temp.matching_priority_payload(l,'R26MATCH3'));
 assert(select v.source_updated_at=d.source_updated_at and v.source_version=d.source_version from bid_active_catalog_private.verification v
  join bid_active_catalog_private.deadline_index d using(type,number)where v.number='R26MATCH3'),'legacy unknown queue minimum receives the current indexed source clock and hash';
 update bid_active_catalog_private.verification set next_attempt=clock_timestamp(),claimed_lease=null where number like 'R26MATCH%';
 for i in 1..24 loop
  n:=pg_temp.matching_priority_notice('R26URGENT'||lpad(i::text,2,'0'),1);perform pg_temp.seed_matching_priority(n);
  insert into bid_active_catalog_private.verification(type,number,revision,source_updated_at,scope_version,source_version,queued_at)
  select d.type,d.number,d.revision,d.source_updated_at,s,d.source_version,now()-interval '2 days'from bid_active_catalog_private.deadline_index d where d.number=n->>'number';
 end loop;
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 assert jsonb_array_length(c->'verify')=16,'existing verification claim cap remains sixteen';
 assert(select count(*)=4 and bool_and(v->>'refreshMatching'='true')from jsonb_array_elements(c->'verify')with ordinality t(v,ordinal)where ordinal<=4 and v->>'number' like 'R26MATCH%'),'all four current matches precede a much larger urgent backlog and force participant refresh';
 assert(select count(*)=28 from bid_active_catalog_private.verification where number like 'R26MATCH%'or number like 'R26URGENT%'),'priority selection never drops unselected work';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',c->>'leaseId'));
 -- A browser query cannot erase valid alert priority on an unverified head.
 update bid_active_catalog_private.deadline_index set verified_at=null,verified_version=null where number='R26MATCH4';
 perform bid_active_catalog_private.request_search_verification('{"type":"공사·용역","from":"1995-10-01","to":"2100-12-31","keyword":"철거","filters":{"keyword":""}}');
 assert(select search_request_key=key_value from bid_active_catalog_private.verification where number='R26MATCH4'),'normal search demand preserves a valid current alert marker';
 -- Changing any saved rule makes old matching markers ineligible without a global scope reset.
 update public.bid_alert_settings set settings=jsonb_set(settings,'{filter,keywords}','["석면"]')where user_id='74747474-7474-4474-8474-747474747474';
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 assert c#>>'{verify,0,number}'like 'R26URGENT%','old rule fingerprint loses its matching priority';
 assert not exists(select 1 from jsonb_array_elements(c->'verify')v where v->>'refreshMatching'='true'),'old matching marker never forces participant refresh';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',c->>'leaseId'));
 -- Invalid or unobserved keys reject the whole batch, including its observations.
 failed:=false;begin perform public.bid_alert_worker(repeat('a',64),'commit',pg_temp.matching_priority_payload(l,'R26MATCH1')||'{"matchingKeys":["g2b:공사:R26UNOBSERVED"]}'::jsonb);
 exception when invalid_parameter_value then failed:=true;end;assert failed,'priority cannot be supplied for an unaccepted observation';
 for n in select value from jsonb_array_elements('[1,"key",null,{},[1],["bad"],["g2b:공사:R26MATCH1","g2b:공사:R26MATCH1"]]'::jsonb)loop
  failed:=false;begin perform public.bid_alert_worker(repeat('a',64),'commit',pg_temp.matching_priority_payload(l,'R26MATCH1')||jsonb_build_object('matchingKeys',n));
  exception when invalid_parameter_value then failed:=true;end;assert failed,'matching keys require a bounded unique identity array';
 end loop;
 failed:=false;begin perform public.bid_alert_worker('wrong','commit',pg_temp.matching_priority_payload(l,'R26MATCH1'));
 exception when insufficient_privilege then failed:=true;end;assert failed,'matching demand does not bypass the server token';
 assert(select storage_ceiling=25165824 from bid_active_catalog_private.runtime)and(select storage_ceiling=33554432 from bid_alert_private.runtime),'storage budgets unchanged';
end $$;

-- Physical overflow caused by a NEW queue row rolls back observations and queue together.
select pg_temp.seed_matching_priority(pg_temp.matching_priority_notice('R26CAPMATCH'));
create or replace function bid_active_catalog_private.storage_bytes()returns bigint language sql stable security invoker set search_path='' as $$
 select case when exists(select 1 from bid_active_catalog_private.verification where number='R26CAPMATCH')then 25165824 else 1000 end$$;
create or replace function bid_alert_private.storage_bytes()returns bigint language sql stable security invoker set search_path='' as $$select 1000::bigint$$;
do $$declare l text;failed boolean:=false;begin
 select lease into l from matching_priority_state;
 begin perform public.bid_alert_worker(repeat('a',64),'commit',pg_temp.matching_priority_payload(l,'R26CAPMATCH'));
 exception when program_limit_exceeded then failed:=true;end;
 assert failed and not exists(select 1 from bid_active_catalog_private.verification where number='R26CAPMATCH')
 and not exists(select 1 from bid_alert_private.observations where notice_key='g2b:공사:R26CAPMATCH'),'catalog physical limit atomically rolls back new matching queue and observation';
end $$;
create or replace function bid_active_catalog_private.storage_bytes()returns bigint language sql stable security invoker set search_path='' as $$select 1000::bigint$$;
create or replace function bid_alert_private.storage_bytes()returns bigint language sql stable security invoker set search_path='' as $$
 select case when exists(select 1 from bid_active_catalog_private.verification where number='R26CAPMATCH')then 33554432 else 1000 end$$;
do $$declare l text;failed boolean:=false;begin
 select lease into l from matching_priority_state;
 begin perform public.bid_alert_worker(repeat('a',64),'commit',pg_temp.matching_priority_payload(l,'R26CAPMATCH'));
 exception when program_limit_exceeded then failed:=true;end;
 assert failed and not exists(select 1 from bid_active_catalog_private.verification where number='R26CAPMATCH')
 and not exists(select 1 from bid_alert_private.observations where notice_key='g2b:공사:R26CAPMATCH'),'combined physical limit atomically rolls back new matching queue and observation';
end $$;
rollback;

-- A trusted maintenance run can seed priority without falsifying lastCheckedAt.
begin;
update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8')),
 last_checked_at=clock_timestamp(),last_error=null,lease_id=null,lease_until=null,catalog_cursor='__complete__',catalog_delta_through=null;
update public.bid_menu_settings set locked=false where menu_key='notices';
insert into auth.users(id,email)values('75757575-7575-4575-8575-757575757575','force-collection@example.invalid');
insert into public.bid_alert_settings(user_id,settings)
values('75757575-7575-4575-8575-757575757575',bid_alert_private.defaults()||'{"enabled":true}'::jsonb);
do $$declare c jsonb;l text;x jsonb;failed boolean;begin
 c:=public.bid_alert_worker(repeat('a',64),'claim','{}');
 assert c->>'skipped'='true' and c->>'leaseId' is null,'fresh normal run still skips collection';
 c:=public.bid_alert_worker(repeat('a',64),'claim','{"forceCollection":true}');l:=c->>'leaseId';
 assert l is not null and c->>'enabled'='true' and c->>'collectionDue'='true','authenticated explicit force seeds collection while lastCheckedAt is fresh';
 c:=public.bid_alert_worker(repeat('a',64),'claim','{"forceCollection":true}');
 assert c->>'busy'='true' and c->>'leaseId' is null,'force cannot bypass an active lease';
 perform public.bid_alert_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',l));
 c:=public.bid_alert_worker(repeat('a',64),'claim','{"dispatchOnly":true,"forceCollection":true}');
 assert c->>'skipped'='true' and c->>'leaseId' is null,'dispatch-only force never starts collection';
 update public.bid_menu_settings set locked=true where menu_key='notices';
 c:=public.bid_alert_worker(repeat('a',64),'claim','{"forceCollection":true}');
 assert c->>'skipped'='true' and c->>'leaseId' is null,'paused menu still prevents forced collection';
 update public.bid_menu_settings set locked=false where menu_key='notices';
 update bid_alert_private.runtime set configured=false;
 c:=public.bid_alert_worker(repeat('a',64),'claim','{"forceCollection":true}');
 assert c->>'leaseId' is null and c->>'enabled'='false','unconfigured runtime cannot force collection';
 update bid_alert_private.runtime set configured=true;
 for x in select value from jsonb_array_elements('["true",1,null,{},[]]'::jsonb)loop
  failed:=false;begin perform public.bid_alert_worker(repeat('a',64),'claim',jsonb_build_object('forceCollection',x));
  exception when invalid_parameter_value then failed:=true;end;assert failed,'forceCollection requires explicit JSON boolean';
 end loop;
 failed:=false;begin perform public.bid_alert_worker('wrong','claim','{"forceCollection":true}');
 exception when insufficient_privilege then failed:=true;end;assert failed,'force still requires the worker secret';
end $$;
create or replace function bid_alert_private.storage_bytes()returns bigint language sql stable security invoker set search_path='' as $$select 33554432::bigint$$;
do $$declare c jsonb;begin
 c:=public.bid_alert_worker(repeat('a',64),'claim','{"forceCollection":true}');
 assert c->>'storageFull'='true' and c->>'leaseId' is null,'force cannot bypass the combined capacity guard';
end $$;
rollback;
