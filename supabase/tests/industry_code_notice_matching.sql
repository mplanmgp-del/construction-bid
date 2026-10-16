-- Exact official industry facts, bounded legacy upgrades and real RPC fences.
begin;
create function pg_temp.industry_notice(p_number text,p_more jsonb default '{}'::jsonb)
returns jsonb language sql as $$
 select jsonb_build_object('id','g2b:공사:'||p_number||':000','number',p_number,'revision','000','type','공사',
   'title','철거 공사','agency','공공 기관','category','철거·해체','province','서울특별시','district','강남구',
   'postedAt',now()-interval '1 day','sourceUpdatedAt',now()-interval '1 minute',
   'biddingStartAt',now()-interval '1 day','deadline',now()+interval '4 days','openingAt',now()+interval '5 days',
   'status','접수중','source','live','licenses',jsonb_build_array('구조물해체·비계공사업'),'allowedRegions','["서울특별시"]'::jsonb,
   'regionComplete',true,'licenseComplete',true,'contractMethod','제한경쟁','estimatedPrice',100000000)||p_more;
$$;
create function pg_temp.industry_filters(p_more jsonb default '{}'::jsonb)
returns jsonb language sql as $$
 select '{"keyword":"","excludeKeyword":"","category":"전체","type":"전체","siteProvince":"전체","license":"구조물해체·비계공사업",
 "minAmount":"","maxAmount":"","status":"전체","contractMethod":"전체","deadlineFrom":"","deadlineTo":"",
 "regionView":"all","autoRegion":false,"regions":[],"statuses":[]}'::jsonb||p_more;
$$;
create function pg_temp.industry_seed(n jsonb) returns void language sql as $$
 insert into bid_active_catalog_private.deadline_index(type,number,revision,notice,source_updated_at,deadline,opening_at,verified_at,source_version,verified_version)
 values(n->>'type',n->>'number',(n->>'revision')::integer,bid_active_catalog_private.compact(n),(n->>'sourceUpdatedAt')::timestamptz,
 (n->>'deadline')::timestamptz,(n->>'openingAt')::timestamptz,now(),
 bid_active_catalog_private.source_version(bid_active_catalog_private.compact(n)),bid_active_catalog_private.source_version(bid_active_catalog_private.compact(n)));
$$;
do $$declare n jsonb:=pg_temp.industry_notice('R26CODE');name text;code text;begin
 for name,code in select key,value from jsonb_each_text(bid_active_catalog_private.industry_directory()) loop
   assert bid_active_catalog_private.selected_industry_code(name)=code,'verified directory mapping: '||name;
 end loop;
 assert bid_active_catalog_private.selected_industry_code('건축공사업')='0002','leading zeroes stay intact';
 assert bid_active_catalog_private.selected_industry_code('구조물해체 . 비계공사업')='4995','explicit legacy selection uses NFKC / punctuation normalization';
 assert bid_active_catalog_private.selected_industry_code('구조물해체') is null,'a partial selection is not a code';
 assert bid_active_catalog_private.selected_industry_code('엔지니어링사업') is null,'broad unverified headings do not invent codes';
 assert bid_active_catalog_private.explicit_industry_code('다른 이름/4995')='4995','official slash suffix';
 assert bid_active_catalog_private.explicit_industry_code('이전 명칭 (0002) · 등록')='0002','company registry label';
 assert bid_active_catalog_private.explicit_industry_code('49950') is null,'four digits are exact';
 assert bid_active_catalog_private.explicit_industry_code('코드 4995 공사') is null,'body numbers do not become industry codes';
 assert bid_active_catalog_private.notice_industry_codes(n)='[]','plain notice names do not become code evidence';
 assert bid_active_catalog_private.notice_industry_codes(n||'{"licenses":["이전 명칭/4995"]}')='["4995"]','explicit legacy labels supply code facts';
 assert bid_active_catalog_private.notice_industry_codes(n||'{"licenses":["이전 명칭/4995"],"licenseCodes":[]}')='[]','explicit empty array is authoritative';
 assert bid_active_catalog_private.notice_industry_codes(n||'{"licenses":["이전 명칭/4995"],"licenseCodes":null}')='[]','an invalid explicit value cannot revive legacy code facts';
 assert bid_active_catalog_private.notice_industry_codes(n||'{"licenseCodes":[" ４９９５ ","0002","4995",4995,"x"]}')='["0002","4995"]','only normalized string code facts survive';
 assert bid_active_catalog_private.industry_state(n,'["구조물해체·비계공사업"]')='review','same-name notice without a code stays review';
 assert bid_active_catalog_private.industry_state(n||'{"licenseCodes":["5652"]}','["구조물해체·비계공사업"]')='excluded','same name cannot override a different official code';
 assert bid_active_catalog_private.industry_state(n||'{"licenses":["표시명 변경"],"licenseCodes":["4995"]}','["구조물해체·비계공사업"]')='matched','same code matches despite another display name';
 assert bid_active_catalog_private.industry_state(n||'{"licenseCodes":["5652"],"licenseComplete":false}','["4995"]')='review','incomplete negative code facts remain review';
 assert bid_active_catalog_private.industry_state(n||'{"licenseCodes":["4995"],"licenseComplete":false}','["4995"]')='matched','an observed exact positive code is evidence';
 assert bid_active_catalog_private.industry_state(n||'{"licenseCodes":["5652"]}','["4995","추가 확인 업종"]')='review','an unresolved OR selection prevents false exclusion';
 assert bid_active_catalog_private.industry_state(n||'{"licenseCodes":["4995"]}','["5652","4995"]')='matched','multiple selected codes are OR';
 assert bid_active_catalog_private.search_match(n,pg_temp.industry_filters(),'{}',now())='pending','indexed search withholds unconfirmed industry facts';
 assert bid_active_catalog_private.search_match(n||'{"licenseCodes":[]}',pg_temp.industry_filters(),'{}',now())='pending','empty list is unknown rather than an invented unrestricted match';
 assert bid_active_catalog_private.search_match(n||'{"licenseCodes":["5652"]}',pg_temp.industry_filters(),'{}',now())='excluded','indexed mismatch is excluded';
 assert bid_active_catalog_private.search_match(n||'{"licenseCodes":["4995"]}',pg_temp.industry_filters(),'{}',now())='match','indexed exact code is matched';
 assert bid_active_catalog_private.search_match(n,pg_temp.industry_filters('{"license":"전체"}'),'{}',now())='match','unfiltered browsing stays available';
 assert bid_active_catalog_private.source_version(n)=bid_active_catalog_private.source_version(n||'{"licenseCodes":["4995"]}'),'condition codes do not edit the source hash';
 assert bid_active_catalog_private.publication_conflict(n||'{"licenseCodes":["4995"]}',n,'x')->'changedFields'='[]','condition codes do not create conflict diagnostics';
 assert bid_active_catalog_private.compact(n||'{"licenseCodes":["4995","0002","4995"]}')->'licenseCodes'='["0002","4995"]','compact catalog retains and deduplicates codes';
 assert octet_length(bid_active_catalog_private.compact(n||jsonb_build_object('licenseCodes','["4995","0002"]'::jsonb,'regionSearchText',repeat('서울 현장 ',1000)))::text)<=4096,'code facts keep the original record byte limit';
 assert bid_active_catalog_private.industry_refresh_due(n,now(),now()),'legacy name-only verified rows can be upgraded immediately';
 assert not bid_active_catalog_private.industry_refresh_due(n||'{"licenseCodes":[]}',now(),now()),'a fresh empty API response is not immediately retried';
 assert bid_active_catalog_private.industry_refresh_due(n||'{"licenseCodes":[]}',now()-interval '11 minutes',now()),'unknown codes retry through the existing ten-minute cadence';
 assert bid_active_catalog_private.industry_refresh_due(n||'{"licenses":["업종/4995"]}',now(),now()),'legacy main-only codes still need the complete explicit code array';
 assert bid_active_catalog_private.industry_refresh_due(n||'{"licenseCodes":["5652"],"licenseComplete":false}',now()-interval '11 minutes',now()),'a known partial mismatch refreshes to discover omitted alternatives';
 assert not bid_active_catalog_private.industry_refresh_due(n||'{"licenseCodes":["5652"],"licenseComplete":false}',now(),now()),'a fresh partial code response observes the same ten-minute cadence';
 assert not bid_active_catalog_private.industry_refresh_due(n||'{"licenseCodes":["5652"]}',now()-interval '11 minutes',now()),'complete known wrong codes do not need repeated upgrades';
 assert not has_function_privilege('anon','bid_active_catalog_private.industry_state(jsonb,jsonb)','execute'),'matcher remains private';
 assert not has_function_privilege('authenticated','bid_active_catalog_private.request_industry_verification(text,timestamptz)','execute'),'upgrade queue remains token guarded';
 assert (select storage_ceiling=25165824 from bid_active_catalog_private.runtime),'catalog cap is unchanged';
 assert (select storage_ceiling=33554432 from bid_alert_private.runtime),'combined cap is unchanged';
end $$;

update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8'));
update bid_active_catalog_private.runtime set scope_version=bid_active_catalog_private.scope_version(),lease_id=null,lease_until=null,retry_after_at=null,storage_blocked=false,last_error=null;
delete from bid_active_catalog_private.verification;delete from bid_active_catalog_private.deadline_index;delete from bid_active_catalog_private.groups;delete from bid_active_catalog_private.deadline_invalidations;
do $$declare n jsonb;q jsonb;r jsonb;s jsonb;begin
 perform pg_temp.industry_seed(pg_temp.industry_notice('R26CODEMATCH','{"licenses":["변경된 표시명"],"licenseCodes":["4995"]}'));
 perform pg_temp.industry_seed(pg_temp.industry_notice('R26CODEWRONG','{"licenseCodes":["5652"]}'));
 perform pg_temp.industry_seed(pg_temp.industry_notice('R26CODEUNKNOWN'));
 perform pg_temp.industry_seed(pg_temp.industry_notice('R26CODELEGACY','{"licenses":["이전명칭/4995"]}'));
 perform pg_temp.industry_seed(pg_temp.industry_notice('R26CODELEGACYWRONG','{"licenses":["주업종/5652"]}'));
 q:=jsonb_build_object('type','공사·용역','from','1995-10-01','to','2100-12-31','keyword','','limit',20,'filters',pg_temp.industry_filters());
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_results',q);
 assert r->>'totalCount'='2','real indexed RPC returns only exact official code matches';
 assert not exists(select 1 from jsonb_array_elements(r->'items') x where x->>'number' in('R26CODEWRONG','R26CODEUNKNOWN')),'same name and unknown code never become exact matches';
 s:=public.bid_active_catalog_worker(repeat('a',64),'search_status',q||jsonb_build_object('asOf',r->>'asOf','snapshotVersion',r->>'snapshotVersion'));
 assert s->>'conditionPendingCount'='1','legacy code facts appear honestly as pending';
 assert (select count(*)=3 from bid_active_catalog_private.verification where number in('R26CODEUNKNOWN','R26CODELEGACY','R26CODELEGACYWRONG') and search_requested_at is not null),'verified legacy unknown and main-only rows are requested for complete code facts even if the old primary code differs';
 assert not exists(select 1 from bid_active_catalog_private.verification where number in('R26CODEWRONG','R26CODEMATCH')),'complete explicit exact and wrong code arrays do not consume upgrade work';
end $$;

-- API enrichment can add codes without a source edit and every database cache
-- merge must retain the code array through subsequent list-only reads.
delete from bid_active_catalog_private.verification;delete from bid_active_catalog_private.deadline_index;delete from bid_active_catalog_private.groups;
do $$declare n jsonb;enriched jsonb;c jsonb;r jsonb;scope text;lease text;job text;begin
 n:=pg_temp.industry_notice('R26CODECACHE','{"regionComplete":false,"licenseComplete":false,"licenses":[]}');
 enriched:=bid_active_catalog_private.compact(n||'{"licenseCodes":["4995","0002"],"licenses":["표시명 다름"],"regionComplete":true,"licenseComplete":true}'::jsonb);
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';scope:=c->>'scopeVersion';
 select x->>'id' into job from jsonb_array_elements(c->'sources') x where x->>'type'='공사' and x->>'procurementSource' is distinct from 'private' limit 1;
 assert job is not null,'a leased public source is available';
 perform public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',lease,'scopeVersion',scope,'sourceId',job,'page',1,'batch',0,'batches',1,'notices',jsonb_build_array(n),'removed','[]'::jsonb));
 perform public.bid_active_catalog_worker(repeat('a',64),'finish',jsonb_build_object('leaseId',lease));
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');lease:=c->>'leaseId';
 select x->>'id' into job from jsonb_array_elements(c->'sources') x where x->>'type'='공사' and x->>'procurementSource' is distinct from 'private' limit 1;
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',lease,'scopeVersion',scope,'groups',jsonb_build_array(jsonb_build_array(enriched))));
 assert r->>'ok'='true','first exact industry enrichment publishes without a same-clock conflict';
 assert (select notice->'licenseCodes'='["0002","4995"]' and verified_at is not null and source_version=verified_version from bid_active_catalog_private.deadline_index where number='R26CODECACHE'),'verified index preserves exact codes';
 r:=public.bid_active_catalog_worker(repeat('a',64),'index_upsert',jsonb_build_object('leaseId',lease,'scopeVersion',scope,'sourceId',job,'page',1,'batch',0,'batches',1,'notices',jsonb_build_array(n),'removed','[]'::jsonb));
 assert r->>'ok'='true' and (select notice->'licenseCodes'='["0002","4995"]' and verified_at is not null from bid_active_catalog_private.deadline_index where number='R26CODECACHE'),'same-clock listing reuses names and codes together';
 r:=public.bid_active_catalog_worker(repeat('a',64),'publish_verified',jsonb_build_object('notices',jsonb_build_array(n)));
 assert r->>'ok'='true','personal catalog accepts same-source list projection';
 assert (select latest->'licenseCodes'='["0002","4995"]' from bid_active_catalog_private.groups where number='R26CODECACHE'),'personal-history projection also reuses verified codes';
end $$;

-- Automatic rules request code facts even when unknown notices are excluded.
delete from bid_active_catalog_private.verification;delete from bid_active_catalog_private.deadline_index;delete from bid_active_catalog_private.groups;
insert into auth.users(id,email) values('76767676-7676-4676-8676-767676767676','industry-codes@example.invalid');
insert into public.bid_alert_settings(user_id,settings) values('76767676-7676-4676-8676-767676767676',
 bid_alert_private.defaults()||jsonb_build_object('enabled',true,'filter',(bid_alert_private.defaults()->'filter')||
 '{"keywords":["철거"],"licenses":["4995"],"includeUnknown":false}'::jsonb));
do $$declare i integer;n jsonb;requested integer;scope text;old_lease uuid:='78787878-7878-4878-8878-787878787878';begin
 scope:=bid_active_catalog_private.scope_version();
 for i in 1..120 loop perform pg_temp.industry_seed(pg_temp.industry_notice('R26CODEAUTO'||lpad(i::text,3,'0')));end loop;
 perform pg_temp.industry_seed(pg_temp.industry_notice('R26CODEAUTOPRIVATE','{"procurementSource":"private"}'));
 perform pg_temp.industry_seed(pg_temp.industry_notice('R26CODEAUTOKNOWN','{"licenseCodes":["5652"]}'));
 insert into bid_active_catalog_private.verification(type,number,revision,source_updated_at,scope_version,source_version,claimed_lease,failures,next_attempt)
 values('공사','R26CODEAUTO001',1,now(),scope,repeat('f',64),old_lease,2,now()+interval '1 minute');
 requested:=bid_active_catalog_private.request_industry_verification(scope,now());
 assert requested=100 and (select count(*)=100 from bid_active_catalog_private.verification),'automatic industry upgrade is bounded to 100 heads';
 assert (select revision=1 and source_updated_at=now() and source_version=repeat('f',64) and claimed_lease=old_lease and failures=2 and next_attempt=now()+interval '1 minute' from bid_active_catalog_private.verification where number='R26CODEAUTO001'),'demand ranking preserves a newer minimum, active lease and retry state';
 assert not exists(select 1 from bid_active_catalog_private.verification where number='R26CODEAUTOKNOWN'),'a known wrong code is not queued as missing';
 assert bid_active_catalog_private.request_industry_verification(scope,now())=21,'a second bounded pass advances through remaining unknown heads';
 assert (select procurement_source='private' from bid_active_catalog_private.verification where number='R26CODEAUTOPRIVATE'),'private upgrade uses its own official provider';
 assert bid_active_catalog_private.request_industry_verification(scope,now())=0,'unchanged upgrade requests observe the ten-minute cadence';
end $$;
rollback;
