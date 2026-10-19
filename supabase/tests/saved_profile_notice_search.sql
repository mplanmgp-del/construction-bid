-- Saved profile province and official industry codes constrain the full search.
-- Fixtures exercise the real protected RPC, counts, cursors and demand queue.
begin;
create function pg_temp.profile_notice(p_number text,p_more jsonb default '{}'::jsonb)
returns jsonb language sql as $$
 select jsonb_build_object('id','g2b:공사:'||p_number||':000','number',p_number,'revision','000','type','공사',
   'title','서울 철거 공사','agency','공공 기관','category','철거·해체','province','서울특별시','district','강남구',
   'postedAt',now()-interval '1 day','sourceUpdatedAt',now()-interval '1 minute',
   'biddingStartAt',now()-interval '1 day','deadline',now()+interval '4 days','openingAt',now()+interval '5 days',
   'status','접수중','source','live','licenses','["표시명 변경"]'::jsonb,'licenseCodes','["4995"]'::jsonb,
   'allowedRegions','["서울특별시"]'::jsonb,'regionComplete',true,'licenseComplete',true,
   'contractMethod','제한경쟁','estimatedPrice',100000000)||p_more;
$$;
create function pg_temp.profile_filters(p_more jsonb default '{}'::jsonb)
returns jsonb language sql as $$
 select '{"keyword":"","excludeKeyword":"","category":"전체","type":"전체","siteProvince":"전체","license":"전체",
 "minAmount":"","maxAmount":"","status":"전체","contractMethod":"전체","deadlineFrom":"","deadlineTo":"",
 "regionView":"all","autoRegion":true,"regions":[],"statuses":[],"sort":"deadline"}'::jsonb||p_more;
$$;
create function pg_temp.profile_query(p_more jsonb default '{}'::jsonb)
returns jsonb language sql as $$
 select jsonb_build_object('type','공사·용역','from','1995-10-01','to','2100-12-31','keyword','','limit',17,
   'filters',pg_temp.profile_filters(),'profile','{"province":"서울특별시","district":"강남구","licenseCodes":["4995","0002"]}'::jsonb)||p_more;
$$;
create function pg_temp.profile_seed(n jsonb,p_verified boolean default true) returns void language sql as $$
 insert into bid_active_catalog_private.deadline_index(type,number,revision,notice,source_updated_at,deadline,opening_at,verified_at,source_version,verified_version)
 values(n->>'type',n->>'number',(n->>'revision')::integer,bid_active_catalog_private.compact(n),(n->>'sourceUpdatedAt')::timestamptz,
 (n->>'deadline')::timestamptz,(n->>'openingAt')::timestamptz,case when p_verified then now() end,
 bid_active_catalog_private.source_version(bid_active_catalog_private.compact(n)),
 case when p_verified then bid_active_catalog_private.source_version(bid_active_catalog_private.compact(n)) end);
$$;

do $$declare n jsonb:=pg_temp.profile_notice('R26PROFILE');f jsonb:=pg_temp.profile_filters();
 profile jsonb:='{"province":"서울특별시","district":"강남구","licenseCodes":["4995","0002"]}';begin
 assert bid_active_catalog_private.search_match(n||'{"licenseCodes":["5652"]}',f,profile,now())='excluded','profile code mismatch is excluded despite matching display name and province';
 assert bid_active_catalog_private.search_match(n,f,profile,now())='match','profile official codes are OR within province AND';
 assert bid_active_catalog_private.search_match(n||'{"licenseCodes":["0002"]}',f,profile,now())='match','leading-zero saved code is matched';
 assert bid_active_catalog_private.search_match(n||'{"licenseCodes":["0001"]}',f,profile,now())='excluded','leading-zero code is exact';
 assert bid_active_catalog_private.search_match(n,f,profile||'{"licenseCodes":[]}',now())='excluded','explicit empty profile fails closed';
 assert bid_active_catalog_private.search_match(n,f,profile-'licenseCodes',now())='match','missing profile code key retains legacy region-only behavior';
 assert bid_active_catalog_private.search_match(n||'{"province":"경기도","title":"경기 철거","allowedRegions":["경기도"]}',f,profile,now())='excluded','profile province remains required';
 assert bid_active_catalog_private.search_match(n-'licenseCodes',f,profile,now())='pending','name-only notice is pending when profile needs code evidence';
 assert bid_active_catalog_private.search_match(n||'{"licenseCodes":["5652"],"licenseComplete":false}',f,profile,now())='pending','incomplete wrong code may omit a saved alternative';
 assert bid_active_catalog_private.search_match(n,f||'{"license":"5652"}',profile,now())='excluded','manual industry filter remains AND with saved industries';
 assert bid_active_catalog_private.search_match(n||'{"licenseCodes":["4995","5652"]}',f||'{"license":"5652"}',profile,now())='match','manual and saved industries can both match';
 assert bid_active_catalog_private.search_match(n,f||'{"regions":[{"province":"경기도"}]}',profile,now())='excluded','manual region remains AND with saved province';
 assert bid_active_catalog_private.search_match(n,f||'{"autoRegion":false}',profile||'{"licenseCodes":[]}',now())='match','toggle off ignores saved codes';
 n:=n||'{"province":"경기도","title":"경기 철거","allowedRegions":["경기도"]}';
 assert bid_active_catalog_private.search_match(n,f||'{"regionView":"excluded"}',profile,now())='match','excluded region view preserves its geographic meaning';
 assert bid_active_catalog_private.search_match(n||'{"licenseCodes":["5652"]}',f||'{"regionView":"excluded"}',profile,now())='excluded','profile code constraint still applies in excluded region view';
end $$;

update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8'));
update bid_active_catalog_private.runtime set scope_version=bid_active_catalog_private.scope_version(),lease_id=null,lease_until=null,retry_after_at=null,storage_blocked=false,last_error=null;
delete from bid_active_catalog_private.verification;delete from bid_active_catalog_private.deadline_index;
delete from bid_active_catalog_private.groups;delete from bid_active_catalog_private.deadline_invalidations;
do $$declare q jsonb:=pg_temp.profile_query();r jsonb;s jsonb;ids text[];seen text[]:='{}';cursor_value text;bad boolean;action text;invalid jsonb;begin
 for i in 1..65 loop
   perform pg_temp.profile_seed(pg_temp.profile_notice('R26PROFMATCH'||lpad(i::text,3,'0'),
     jsonb_build_object('type',case when i%2=0 then '공사' else '용역' end,'licenseCodes',case when i%2=0 then '["4995"]'::jsonb else '["0002"]'::jsonb end)));
 end loop;
 perform pg_temp.profile_seed(pg_temp.profile_notice('R26PROFWRONG','{"licenseCodes":["5652"]}'));
 perform pg_temp.profile_seed(pg_temp.profile_notice('R26PROFREGION','{"province":"경기도","title":"경기 철거","allowedRegions":["경기도"]}'));
 perform pg_temp.profile_seed(pg_temp.profile_notice('R26PROFUNKNOWN')-'licenseCodes');
 perform pg_temp.profile_seed(pg_temp.profile_notice('R26PROFUNVERIFIED'),false);
 loop
   r:=public.bid_active_catalog_worker(repeat('a',64),'search_results',q);
   assert r->>'totalCount'='65','profile count is global before cursor paging across both types';
   select array_agg(x->>'type'||':'||(x->>'number')) into ids from jsonb_array_elements(r->'items') x;
   assert not seen&&ids,'saved profile cursor pages do not duplicate';seen:=seen||ids;
   exit when r->>'hasMore'='false';
   q:=q||jsonb_build_object('cursor',r->>'nextCursor');
 end loop;
 assert cardinality(seen)=65,'every matching saved-profile result is reachable';
 q:=pg_temp.profile_query();r:=public.bid_active_catalog_worker(repeat('a',64),'search_results',q);cursor_value:=r->>'nextCursor';
 s:=public.bid_active_catalog_worker(repeat('a',64),'search_status',q||jsonb_build_object('asOf',r->>'asOf','snapshotVersion',r->>'snapshotVersion'));
 assert s->>'verifiedCount'='66' and s->>'pendingCount'='1' and s->>'conditionPendingCount'='1','status counts use same profile classifier including withheld code evidence';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',q);
 assert r->>'totalCount'='65' and r->>'conditionPendingCount'='1' and r->>'pendingCount'='1','legacy full search uses same saved-profile constraints';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_results',q||jsonb_build_object('cursor',cursor_value,'profile',
   '{"province":"서울특별시","district":"강남구","licenseCodes":["0002","4995","4995"],"unrelated":"ignored"}'::jsonb));
 assert r->>'page'='2','canonical profile codes preserve cursor identity across duplicate ordering and unrelated profile fields';
 bad:=false;begin perform public.bid_active_catalog_worker(repeat('a',64),'search_results',q||jsonb_build_object('cursor',cursor_value,'profile',
   '{"province":"서울특별시","district":"강남구","licenseCodes":["4995"]}'::jsonb));
 exception when raise_exception then bad:=sqlerrm='SEARCH_CHANGED';end;assert bad,'saved profile code changes invalidate signed cursors';
 foreach action in array array['search_page','search_results','search_status'] loop
   q:=pg_temp.profile_query()||jsonb_build_object('asOf',r->>'asOf','snapshotVersion',r->>'snapshotVersion');
   r:=public.bid_active_catalog_worker(repeat('a',64),action,q||'{"profile":{"province":"서울특별시","licenseCodes":[]}}');
   assert case when action='search_status' then r->>'verifiedCount'='0' and r->>'pendingCount'='0' and r->>'conditionPendingCount'='0' else r->>'totalCount'='0' end,'empty saved code array excludes in '||action;
   r:=public.bid_active_catalog_worker(repeat('a',64),action,q||'{"profile":{"province":"서울특별시"}}');
   assert case when action='search_status' then r->>'verifiedCount'='67' and r->>'pendingCount'='1' and r->>'conditionPendingCount'='0' else r->>'totalCount'='67' end,'omitted saved codes retain legacy region-only results in '||action;
   for invalid in select value from jsonb_array_elements('[null,"4995",[4995],["499"],[" 4995 "],["４９９５"]]'::jsonb) loop
     bad:=false;begin perform public.bid_active_catalog_worker(repeat('a',64),action,q||jsonb_build_object('profile',jsonb_build_object('province','서울특별시','licenseCodes',invalid)));
     exception when invalid_parameter_value then bad:=true;end;assert bad,'malformed raw saved codes rejected in '||action;
   end loop;
   bad:=false;begin perform public.bid_active_catalog_worker(repeat('a',64),action,q||jsonb_build_object('profile',jsonb_build_object('province','서울특별시','licenseCodes',(select jsonb_agg('4995'::text) from generate_series(1,101)))));
   exception when invalid_parameter_value then bad:=true;end;assert bad,'saved code input is bounded to 100 in '||action;
   r:=public.bid_active_catalog_worker(repeat('a',64),action,q||jsonb_build_object('profile',jsonb_build_object('province','서울특별시','licenseCodes',(select jsonb_agg('4995'::text) from generate_series(1,100)))));
   assert case when action='search_status' then r->>'verifiedCount'='33' else r->>'totalCount'='32' end,'100 duplicate valid saved codes are accepted and canonicalized in '||action;
 end loop;
 q:=pg_temp.profile_query()||jsonb_build_object('filters',pg_temp.profile_filters('{"autoRegion":false}'),'profile','{"province":"서울특별시","district":"강남구","licenseCodes":null}'::jsonb);
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_results',q);cursor_value:=r->>'nextCursor';
 assert r->>'totalCount'='68','off toggle ignores saved industry codes';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_results',q||jsonb_build_object('cursor',cursor_value,'profile','{"province":"서울특별시","district":"강남구","licenseCodes":["5652"]}'::jsonb));
 assert r->>'page'='2','ignored saved code edits do not invalidate off-toggle cursors';
 assert (select storage_ceiling=25165824 from bid_active_catalog_private.runtime),'catalog budget remains unchanged';
 assert (select storage_ceiling=33554432 from bid_alert_private.runtime),'combined budget remains unchanged';
 assert not has_function_privilege('anon','bid_active_catalog_private.normalize_search_profile(jsonb,boolean)','execute')
   and not has_function_privilege('authenticated','bid_active_catalog_private.normalize_search_profile(jsonb,boolean)','execute'),'profile normalizer remains private';
 bad:=false;begin perform public.bid_active_catalog_worker(repeat('b',64),'search_results',pg_temp.profile_query());exception when others then bad:=true;end;assert bad,'token guard still rejects an invalid worker token';
end $$;

-- Legacy main-only and incomplete code facts can conceal a saved alternative.
-- Demand ranking may relax that evidence only while requesting an exact recheck.
delete from bid_active_catalog_private.verification;delete from bid_active_catalog_private.deadline_index;
do $$declare q jsonb:=pg_temp.profile_query();r jsonb;s jsonb;marker text;scope text;begin
 perform pg_temp.profile_seed(pg_temp.profile_notice('R26PROFLEGACY','{"licenses":["주업종/5652"]}')-'licenseCodes');
 perform pg_temp.profile_seed(pg_temp.profile_notice('R26PROFPARTIAL','{"licenseCodes":["5652"],"licenseComplete":false}'));
 update bid_active_catalog_private.deadline_index set verified_at=now()-interval '11 minutes' where number='R26PROFPARTIAL';
 perform pg_temp.profile_seed(pg_temp.profile_notice('R26PROFKNOWN','{"licenseCodes":["5652"]}'));
 perform pg_temp.profile_seed(pg_temp.profile_notice('R26PROFPRIVATE','{"procurementSource":"private","licenses":["주업종/5652"]}')-'licenseCodes');
 perform pg_temp.profile_seed(pg_temp.profile_notice('R26PROFOTHERREGION','{"province":"경기도","title":"경기 철거","allowedRegions":["경기도"]}')-'licenseCodes');
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_results',q);
 assert r->>'totalCount'='0','a possible verification match is never published as a saved-profile match';
 s:=public.bid_active_catalog_worker(repeat('a',64),'search_status',q||jsonb_build_object('asOf',r->>'asOf','snapshotVersion',r->>'snapshotVersion'));
 assert (select count(*)=3 from bid_active_catalog_private.verification where search_requested_at is not null),'profile demand requests legacy wrong-main, partial and private candidates';
 assert not exists(select 1 from bid_active_catalog_private.verification where number in('R26PROFKNOWN','R26PROFOTHERREGION')),'complete wrong industries and other province do not consume profile demand';
 assert (select procurement_source='private' from bid_active_catalog_private.verification where number='R26PROFPRIVATE'),'profile industry upgrades retain provider routing';
 select search_request_key into marker from bid_active_catalog_private.verification where number='R26PROFLEGACY';
 q:=q||'{"profile":{"province":"서울특별시","district":"강남구","licenseCodes":["0002","4995","4995"],"unrelated":"ignored"}}';
 assert bid_active_catalog_private.request_search_verification(q)=0,'canonical equivalent saved profile does not repeatedly requeue demand';
 assert (select search_request_key=marker from bid_active_catalog_private.verification where number='R26PROFLEGACY'),'demand fingerprint uses canonical allowlisted profile';
 q:=q||'{"profile":{"province":"서울특별시","district":"강남구","licenseCodes":["4995"]}}';
 assert bid_active_catalog_private.request_search_verification(q)=3,'changed saved code set receives a distinct demand fingerprint';
 delete from bid_active_catalog_private.verification;
 assert bid_active_catalog_private.request_search_verification(q||'{"profile":{"province":"서울특별시","licenseCodes":[]}}')=0,'empty saved code set never queues candidates';
end $$;
rollback;
