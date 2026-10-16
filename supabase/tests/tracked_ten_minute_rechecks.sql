-- Every test runs against a disposable PostgreSQL. No provider or cron call.
begin;
update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8'));
update public.bid_menu_settings set locked=false where menu_key='notices';
create function pg_temp.ten_minute_notice(p_number text)
returns jsonb language sql as $$
 select jsonb_build_object('id','g2b:공사:'||p_number||':000','type','공사','number',p_number,'revision','000',
 'title','철거 시험 공사','agency','공공기관','category','철거·해체','province','서울특별시','district','강남구',
 'postedAt',now()-interval '2 days','sourceUpdatedAt',now()-interval '2 days','biddingStartAt',now()-interval '1 day',
 'deadline',now()+interval '45 days','openingAt',now()+interval '46 days','status','접수중','source','live',
 'allowedRegions','[]'::jsonb,'licenses','[]'::jsonb,'regionComplete',true,'licenseComplete',true);
$$;
do $$declare n jsonb;r jsonb;c jsonb;l text;s text;retry_at timestamptz;payload jsonb;test_flag jsonb;i integer;failed boolean;begin
 n:=pg_temp.ten_minute_notice('R26TENPUBLISH');
 r:=public.bid_active_catalog_worker(repeat('a',64),'publish_verified',jsonb_build_object('notices',jsonb_build_array(n)));
 assert r->>'ok'='true','direct protected publication remains available';
 assert (select next_check_at=verified_at+interval '1 hour' from bid_active_catalog_private.groups where number='R26TENPUBLISH'),'unflagged on-demand publication keeps its existing hourly refresh';
 assert (select bool_and(to_jsonb(g)=to_jsonb(b)) and count(*)=3 from bid_active_catalog_private.groups g join tracked_recheck_before b using(type,number)),'migration never rewrites or globally accelerates existing retained groups';
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');l:=c->>'leaseId';s:=c->>'scopeVersion';assert l is not null;
 for i in 0..2 loop
  n:=pg_temp.ten_minute_notice('R26TENCOMMIT'||i);
  insert into bid_active_catalog_private.verification(type,number,revision,source_updated_at,scope_version,claimed_lease)
  values('공사',n->>'number',0,(n->>'sourceUpdatedAt')::timestamptz,s,l::uuid);
  payload:=jsonb_build_object('leaseId',l,'scopeVersion',s,'groups',jsonb_build_array(jsonb_build_array(n)));
  if i>0 then payload:=payload||jsonb_build_object('refreshMatching',i=1);end if;
  r:=public.bid_active_catalog_worker(repeat('a',64),'commit',payload);assert r->>'ok'='true';
  if i=1 then
   assert (select next_check_at=date_bin(interval '10 minutes',verified_at,'2000-01-01T00:00:00Z'::timestamptz)+interval '10 minutes'
     from bid_active_catalog_private.groups where number=n->>'number'),'only a proven matching private commit schedules the next ten-minute boundary';
  else assert (select next_check_at=verified_at+interval '1 hour' from bid_active_catalog_private.groups where number=n->>'number'),'absent or false matching flag preserves hourly refresh';end if;
  assert not exists(select 1 from bid_active_catalog_private.verification where number=n->>'number'),'successful private commit still acknowledges only its verification';
 end loop;
 assert bid_active_catalog_private.next_verification_at('2026-10-16T09:50:09+00:00')='2026-10-16T10:00:00+00:00'::timestamptz,'processing seconds cannot skip the next cron boundary';
 assert bid_active_catalog_private.next_verification_at('2026-10-16T09:59:59.999999+00:00')='2026-10-16T10:00:00+00:00'::timestamptz,'fractional timestamps round to the next boundary';
 assert bid_active_catalog_private.next_verification_at('2026-10-16T10:00:00+00:00')='2026-10-16T10:10:00+00:00'::timestamptz,'exact boundary schedules the following cycle';
 assert bid_active_catalog_private.next_verification_at('2026-10-16T23:59:59+00:00')='2026-10-17T00:00:00+00:00'::timestamptz,'day rollover is safe';
 for test_flag in select value from jsonb_array_elements('["true",1,null,{},[]]'::jsonb)loop
  failed:=false;begin perform public.bid_active_catalog_worker(repeat('a',64),'commit',payload||jsonb_build_object('refreshMatching',test_flag));
  exception when invalid_parameter_value then failed:=true;end;assert failed,'refreshMatching accepts only an explicit JSON boolean';
 end loop;
 failed:=false;begin perform public.bid_active_catalog_worker(repeat('a',64),'commit',payload||jsonb_build_object('refreshMatching',true,'groups',jsonb_build_array(jsonb_build_array(n),jsonb_build_array(n))));
 exception when invalid_parameter_value then failed:=true;end;assert failed,'matching refresh cannot mark a multi-identity batch';
 n:=pg_temp.ten_minute_notice('R26TENCOMMIT1');
 update bid_active_catalog_private.groups set verified_at=clock_timestamp()-interval '11 minutes',next_check_at=bid_active_catalog_private.next_verification_at(clock_timestamp()-interval '11 minutes') where number=n->>'number';
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',l));
 -- Existing failure backoff survives periodic group scheduling.
 retry_at:=clock_timestamp()+interval '1 hour';
 insert into bid_active_catalog_private.verification(type,number,revision,source_updated_at,scope_version,next_attempt,failures,last_error)
 select type,number,revision,source_updated_at,s,retry_at,4,'preserved retry' from bid_active_catalog_private.groups where number='R26TENEARLY'
 on conflict(type,number)do update set claimed_lease=null,next_attempt=retry_at,failures=4,last_error='preserved retry';
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');
 assert exists(select 1 from jsonb_array_elements(c->'verify')v where v->>'number'=n->>'number' and v->>'sourceUpdatedAt'=n->>'sourceUpdatedAt'),'unchanged old source timestamp and >7-day deadline still requeue for a due matching check';
 assert (select next_attempt=retry_at and failures=4 and last_error='preserved retry' from bid_active_catalog_private.verification where number='R26TENEARLY'),'a periodic check never resets an existing retry backoff';
 assert (select storage_ceiling=25165824 from bid_active_catalog_private.runtime) and (select storage_ceiling=33554432 from bid_alert_private.runtime),'all storage budgets unchanged';
 assert not has_function_privilege('anon','bid_active_catalog_private.next_verification_at(timestamptz)','execute'),'boundary helper is private';
end $$;
rollback;
