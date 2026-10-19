-- Scale and semantic regressions for the regional search-status timeout.
-- All fixture rows, helpers and verification requests are rollback-only.
-- Runtime measurements are evidence, never a machine-dependent pass threshold.
begin;

-- Exact reference bodies from 20261016042754_region_name_keyword_filtering.sql.
-- The original canonical province helper is also isolated so its optimization
-- cannot change both sides of a comparison at once.
create or replace function pg_temp.reference_canonical_province(p_text text,p_search boolean default true)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare name text;begin
 name:=bid_active_catalog_private.geo_directory()#>>array['aliases',bid_active_catalog_private.clean_search_text(p_text)];
 if p_search and (name in ('광주광역시','전라남도') or bid_active_catalog_private.clean_search_text(p_text)='전남광주통합특별시') then return '전남광주통합특별시';end if;
 return name;
end $$;

create or replace function pg_temp.reference_region_keyword_corpus(p_notice jsonb)
returns text language sql immutable security invoker set search_path='' as $$
 select lower(bid_active_catalog_private.clean_search_text(concat_ws(' ',
   p_notice->>'regionSearchText',p_notice->>'title',p_notice->>'agency',p_notice->>'demandAgency',
   p_notice->>'province',p_notice->>'district',p_notice->>'description',p_notice->>'duration',
   p_notice->>'contractMethod',p_notice->>'noticeKind',p_notice->>'bidMethod',p_notice->>'category',p_notice->>'type',
   (select string_agg(value,' ') from jsonb_array_elements_text(case when jsonb_typeof(p_notice->'allowedRegions')='array' then p_notice->'allowedRegions' else '[]'::jsonb end)),
   (select string_agg(value,' ') from jsonb_array_elements_text(case when jsonb_typeof(p_notice->'requirements')='array' then p_notice->'requirements' else '[]'::jsonb end)),
   (select string_agg(value,' ') from jsonb_array_elements_text(case when jsonb_typeof(p_notice->'licenses')='array' then p_notice->'licenses' else '[]'::jsonb end)),
   (select string_agg(value->>'name',' ') from jsonb_array_elements(case when jsonb_typeof(p_notice->'documents')='array' then p_notice->'documents' else '[]'::jsonb end))
 )));
$$;

-- 광주시 is the Gyeonggi district, so the short metropolitan alias 광주 alone
-- must not turn it into the combined Jeonnam/Gwangju search region.
create or replace function pg_temp.reference_region_keyword_contains(p_text text,p_keyword text)
returns boolean language sql immutable security invoker set search_path='' as $$
 select case when p_keyword='광주' then p_text~'광주($|[^시])'
   else p_keyword<>'' and strpos(p_text,p_keyword)>0 end;
$$;

create or replace function pg_temp.reference_region_keyword_evidence(p_text text)
returns boolean language sql immutable security invoker set search_path='' as $$
 select strpos(p_text,'전남광주통합특별시')>0
   or exists(select 1 from jsonb_object_keys(bid_active_catalog_private.geo_directory()->'aliases') alias
     where pg_temp.reference_region_keyword_contains(p_text,alias))
   or exists(select 1 from jsonb_each(bid_active_catalog_private.geo_directory()->'districts') province,
     lateral jsonb_array_elements_text(province.value) district,
     lateral (select string_to_array(district,' ') parts) path
     where strpos(p_text,path.parts[cardinality(path.parts)])>0);
$$;

create or replace function pg_temp.reference_region_search_state(p_notice jsonb,p_regions jsonb)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare selection jsonb;province text;leaf text;parts text[];corpus text;
begin
 if jsonb_typeof(p_regions) is distinct from 'array' then return 'review';end if;
 if jsonb_array_length(p_regions)=0 then return 'matched';end if;
 if exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(p_notice->'allowedRegions')='array'
   then p_notice->'allowedRegions' else '[]'::jsonb end) region
   where bid_active_catalog_private.clean_search_text(region)='전국') then return 'matched';end if;
 corpus:=pg_temp.reference_region_keyword_corpus(p_notice);
 for selection in select value from jsonb_array_elements(p_regions) loop
   province:=pg_temp.reference_canonical_province(selection->>'province');
   leaf:=bid_active_catalog_private.clean_search_text(selection->>'locality');
   if leaf='' then leaf:=bid_active_catalog_private.clean_search_text(selection->>'district');end if;
   if province='세종특별자치시' and leaf='세종시' then leaf:='';end if;
   if leaf<>'' then
     parts:=string_to_array(leaf,' ');leaf:=lower(parts[cardinality(parts)]);
     if strpos(corpus,leaf)>0 then return 'matched';end if;
   elsif (province is null and pg_temp.reference_region_keyword_contains(corpus,lower(bid_active_catalog_private.clean_search_text(selection->>'province'))))
     or (province='전남광주통합특별시' and strpos(corpus,'전남광주통합특별시')>0)
     or exists(select 1 from jsonb_object_keys(bid_active_catalog_private.geo_directory()->'aliases') alias
       where pg_temp.reference_canonical_province(alias)=province
         and pg_temp.reference_region_keyword_contains(corpus,lower(alias))) then return 'matched';end if;
 end loop;
 return case when not pg_temp.reference_region_keyword_evidence(corpus)
   then 'review' else 'excluded' end;
end $$;


-- Compare all official aliases and district leaves against every province.
-- Unknown text, multi-region selections, arrays, NFKC, and the 광주시 boundary
-- are included so faster discovery cannot alter search membership or counts.
create temporary table regional_semantic_texts(corpus text primary key);
insert into regional_semantic_texts
 select distinct text from (
   select key||' 철거 공사' text from jsonb_object_keys(bid_active_catalog_private.geo_directory()->'aliases') key
   union all
   select district||' 철거 공사' from jsonb_each(bid_active_catalog_private.geo_directory()->'districts') province,
     lateral jsonb_array_elements_text(province.value) district
   union all
   select province.key||' '||district||' 철거 공사'
     from jsonb_each(bid_active_catalog_private.geo_directory()->'districts') province,
     lateral jsonb_array_elements_text(province.value) district
   union all
   select unnest(array['철거 공사','지역 미기재','전남광주통합특별시 공고','경기도 광주시','광주시','광주','광주광역시',
     '현장 강남구 역삼동','수원시 팔달구','서울　특별시 공고','서 울 공고','광주시청','광주역','부산 서울',
     '부산광역시 해운대구','세종시','세종특별자치시','파장동','제물포구','검단구','영종구','서해구'])
 ) texts;
do $$declare corpus text;selection jsonb;actual text;expected text;checked integer:=0;profile_checked integer:=0;notice jsonb;begin
 for corpus in select t.corpus from regional_semantic_texts t loop
   assert bid_active_catalog_private.region_keyword_evidence(corpus)
     is not distinct from pg_temp.reference_region_keyword_evidence(corpus),
     'regional evidence semantics: '||corpus;
   notice:=jsonb_build_object('title',corpus,'allowedRegions','[]'::jsonb);
   for selection in
     select jsonb_build_array(jsonb_build_object('province',alias.key))
       from jsonb_object_keys(bid_active_catalog_private.geo_directory()->'aliases') alias(key)
     union all select value from jsonb_array_elements('[[],null,{},
       [{"province":"서울특별시","district":"강남구","locality":"역삼동"}],
       [{"province":"경기도","district":"수원시 팔달구"}],
       [{"province":"세종특별자치시","district":"세종시"}],
       [{"province":"강남구"}],[{"province":"파장동"}],
       [{"province":"미등록"}],[{"province":""}],
       [{"province":"서울"},{"province":"부산"}]]'::jsonb)
   loop
     actual:=bid_active_catalog_private.region_search_state(notice,selection);
     expected:=pg_temp.reference_region_search_state(notice,selection);
     assert actual is not distinct from expected,
       'region classifier semantics: '||corpus||' / '||selection::text||' actual='||coalesce(actual,'NULL')||' expected='||coalesce(expected,'NULL');
     checked:=checked+1;
     if jsonb_typeof(selection)='array' and jsonb_array_length(selection)=1
       and bid_active_catalog_private.clean_search_text(selection->0->>'district')=''
       and bid_active_catalog_private.clean_search_text(selection->0->>'locality')='' then
       actual:=bid_active_catalog_private.profile_region_state(notice,selection->0);
       expected:=case when bid_active_catalog_private.clean_search_text(selection->0->>'province')=''
         then 'review' else expected end;
       assert actual is not distinct from expected,
         'dedicated profile classifier semantics: '||corpus||' / '||selection::text||' actual='||coalesce(actual,'NULL')||' expected='||coalesce(expected,'NULL');
       profile_checked:=profile_checked+1;
     end if;
   end loop;
 end loop;
 assert checked>20000,'all official aliases and district text are compared exhaustively';
 assert profile_checked>15000,'dedicated profile path is compared for every official alias and corpus';
 foreach notice in array array[
   '{"title":"지역 미기재","allowedRegions":["전국"]}'::jsonb,
   '{"title":"지역 미기재","allowedRegions":["　전국　"]}'::jsonb,
   '{"description":"서울","documents":[{"name":"부산 내역서"}],"requirements":["광주시"]}'::jsonb,
   '{"title":"광주시","allowedRegions":null,"licenses":["강남구 업종"]}'::jsonb
 ] loop
   selection:='[{"province":"서울"},{"province":"광주광역시"}]';
   assert bid_active_catalog_private.region_search_state(notice,selection)
     is not distinct from pg_temp.reference_region_search_state(notice,selection),
     'nationwide and mixed provider corpus semantics';
   for selection in select jsonb_build_object('province',alias.key,'district','ignored district')
     from jsonb_object_keys(bid_active_catalog_private.geo_directory()->'aliases') alias(key)
     union all select value from jsonb_array_elements('[{"province":""},{"province":"미등록"},{"province":"강남구"}]'::jsonb)
   loop
     expected:=case when bid_active_catalog_private.clean_search_text(selection->>'province')='' then 'review'
       else pg_temp.reference_region_search_state(notice,jsonb_build_array(selection-'district')) end;
     assert bid_active_catalog_private.profile_region_state(notice,selection) is not distinct from expected,
       'dedicated profile nationwide / mixed provider / district ignored: '||notice::text||' / '||selection::text;
   end loop;
 end loop;
end $$;

create function pg_temp.scale_notice(p_number text,p_more jsonb default '{}'::jsonb)
returns jsonb language sql as $$
 select jsonb_build_object('id','g2b:공사:'||p_number||':000','number',p_number,'revision','000','type','공사',
   'title','철거 공사','agency','공공 기관','demandAgency','기관','category','철거·해체','province','','district','',
   'postedAt',now()-interval '1 day','sourceUpdatedAt',now()-interval '1 minute',
   'biddingStartAt',now()-interval '1 day','deadline',now()+interval '4 days','openingAt',now()+interval '5 days',
   'status','접수중','source','live','licenses','[]'::jsonb,'licenseCodes','[]'::jsonb,'licenseComplete',true,
   'allowedRegions','[]'::jsonb,'regionComplete',true,'contractMethod','제한경쟁','estimatedPrice',100000000)||p_more;
$$;
create function pg_temp.scale_query(p_filters jsonb default '{"autoRegion":true}'::jsonb,p_profile jsonb default '{"province":"서울특별시"}'::jsonb)
returns jsonb language sql as $$
 select jsonb_build_object('type','공사·용역','from','1995-10-01','to','2100-12-31','keyword','철거',
   'filters',p_filters,'profile',p_profile,'limit',7);
$$;
create temporary table regional_status_benchmark(mode text,elapsed_ms numeric,verified_count bigint,pending_count bigint,condition_pending_count bigint,queued integer);

update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8'));
update bid_active_catalog_private.runtime set scope_version=bid_active_catalog_private.scope_version(),
 lease_id=null,lease_until=null,retry_after_at=null,storage_blocked=false,last_error=null;
delete from bid_active_catalog_private.verification;
delete from bid_active_catalog_private.deadline_index;
delete from bid_active_catalog_private.groups;
delete from bid_active_catalog_private.deadline_invalidations;
with notices as (
 select i,pg_temp.scale_notice('R26SCALE'||lpad(i::text,5,'0'),case
   when i<=500 then jsonb_build_object('title','서울 철거 공사','licenseCodes',case when i%2=0 then '["4995"]'::jsonb else '["0002"]'::jsonb end)
   when i<=5000 then '{}'::jsonb
   else '{"title":"부산 철거 공사","licenseCodes":["4995"]}'::jsonb end) notice
 from generate_series(1,5050) i
), compacted as (
 select i,bid_active_catalog_private.compact(notice) notice from notices
)
insert into bid_active_catalog_private.deadline_index(type,number,revision,notice,source_updated_at,deadline,opening_at,verified_at,source_version,verified_version)
select '공사',notice->>'number',0,notice,(notice->>'sourceUpdatedAt')::timestamptz,
 (notice->>'deadline')::timestamptz,(notice->>'openingAt')::timestamptz,
 case when i<=500 or i between 5001 and 5025 then now() end,
 bid_active_catalog_private.source_version(notice),
 case when i<=500 or i between 5001 and 5025 then bid_active_catalog_private.source_version(notice) end
from compacted;

do $$declare q jsonb;r jsonb;s jsonb;anchor jsonb;started timestamptz;mode text;expected integer;bad boolean;original_queue jsonb;unchanged_queue jsonb;begin
 assert (select count(*)=5050 from bid_active_catalog_private.deadline_index),'realistic scale fixture is complete';
 foreach mode in array array['legacy_profile_region','saved_profile_codes','manual_regions'] loop
   delete from bid_active_catalog_private.verification;
   q:=case mode
     when 'saved_profile_codes' then pg_temp.scale_query('{"autoRegion":true}','{"province":"서울특별시","licenseCodes":["4995"]}')
     when 'manual_regions' then pg_temp.scale_query('{"autoRegion":false,"regions":[{"province":"서울특별시"}],"includeUnknownRegions":false}','{}')
     else pg_temp.scale_query() end;
   expected:=case when mode='saved_profile_codes' then 250 else 500 end;
   r:=public.bid_active_catalog_worker(repeat('a',64),'search_results',q);
   assert (r->>'totalCount')::integer=expected,'published count stays exact at scale: '||mode;
   assert jsonb_array_length(r->'items')=7 and r->>'hasMore'='true','full-count result paging stays bounded: '||mode;
   anchor:=q||jsonb_build_object('asOf',r->>'asOf','snapshotVersion',r->>'snapshotVersion');
   started:=clock_timestamp();
   s:=public.bid_active_catalog_worker(repeat('a',64),'search_status',anchor);
   insert into regional_status_benchmark select mode,round(extract(epoch from clock_timestamp()-started)*1000,3),
     (s->>'verifiedCount')::bigint,(s->>'pendingCount')::bigint,(s->>'conditionPendingCount')::bigint,
     (select count(*) from bid_active_catalog_private.verification where search_requested_at is not null);
   assert (s->>'verifiedCount')::integer=expected and s->>'pendingCount'='4500' and s->>'conditionPendingCount'='4500',
     'full catalog counts retain unknown-region withholding: '||mode;
   assert s->>'asOf'=r->>'asOf' and s->>'snapshotVersion'=r->>'snapshotVersion','status remains anchored to its results: '||mode;
   assert not(s?'items') and not(s?'totalCount') and not(s?'nextCursor'),'status does not generate result pages';
   assert (select count(*)=100 from bid_active_catalog_private.verification where search_requested_at is not null),
     'public worker retains bounded 100-head verification demand: '||mode;
   assert not exists(select 1 from bid_active_catalog_private.verification where right(number,5)::integer>5000),
     'known excluded regions do not consume verification demand: '||mode;
   select jsonb_object_agg(number,search_requested_at) into original_queue from bid_active_catalog_private.verification;
   assert bid_active_catalog_private.request_search_verification(q)=100,'later demand advances by at most another 100 heads: '||mode;
   select jsonb_object_agg(number,search_requested_at) into unchanged_queue from bid_active_catalog_private.verification where original_queue?number;
   assert unchanged_queue=original_queue,'already requested heads are not requeued within ten minutes: '||mode;
   assert (select count(*)=200 from bid_active_catalog_private.verification),'later bounded demand advances without duplicate heads: '||mode;
 end loop;

 q:=pg_temp.scale_query('{"autoRegion":false}','{}');
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_results',q);
 assert r->>'totalCount'='525','minimal filters restore all published regions';
 s:=public.bid_active_catalog_worker(repeat('a',64),'search_status',q||jsonb_build_object('asOf',r->>'asOf','snapshotVersion',r->>'snapshotVersion'));
 assert s->>'verifiedCount'='525' and s->>'pendingCount'='4525' and s->>'conditionPendingCount'='0','minimal filters do not invent unknown-region conditions';

 q:=pg_temp.scale_query();r:=public.bid_active_catalog_worker(repeat('a',64),'search_results',q);
 bad:=false;begin perform public.bid_active_catalog_worker(repeat('a',64),'search_status',q);
 exception when invalid_parameter_value then bad:=true;end;assert bad,'missing status anchor is still rejected at scale';
 bad:=false;begin perform public.bid_active_catalog_worker(repeat('a',64),'search_status',q||jsonb_build_object('asOf',now()-interval '11 minutes','snapshotVersion',r->>'snapshotVersion'));
 exception when raise_exception then bad:=sqlerrm='SEARCH_CHANGED';end;assert bad,'expired status anchor is still rejected at scale';
 bad:=false;begin perform public.bid_active_catalog_worker(repeat('a',64),'search_status',q||jsonb_build_object('asOf',r->>'asOf','snapshotVersion','0'));
 exception when raise_exception then bad:=sqlerrm='SEARCH_CHANGED';end;assert bad,'changed generation is still rejected at scale';
 bad:=false;begin perform public.bid_active_catalog_worker(repeat('b',64),'search_status',q||jsonb_build_object('asOf',r->>'asOf','snapshotVersion',r->>'snapshotVersion'));
 exception when insufficient_privilege then bad:=true;end;assert bad,'public status retains worker token gate';
 assert not has_function_privilege('anon','bid_active_catalog_private.search_status(jsonb)','execute')
   and not has_function_privilege('authenticated','bid_active_catalog_private.search_status(jsonb)','execute'),
   'status helper is not exposed to client roles';
 assert not has_function_privilege('anon','bid_active_catalog_private.region_search_state(jsonb,jsonb)','execute')
   and not has_function_privilege('authenticated','bid_active_catalog_private.region_keyword_evidence(text)','execute'),
   'optimized geography remains private';
 if to_regprocedure('bid_active_catalog_private.region_province_keywords(text)') is not null then
   assert not has_function_privilege('anon','bid_active_catalog_private.region_province_keywords(text)','execute')
     and not has_function_privilege('authenticated','bid_active_catalog_private.region_province_keywords(text)','execute'),
     'compiled province lookup does not expose a new client RPC';
 end if;
 if to_regprocedure('bid_active_catalog_private.region_selection_keywords(text)') is not null then
   assert not has_function_privilege('anon','bid_active_catalog_private.region_selection_keywords(text)','execute')
     and not has_function_privilege('authenticated','bid_active_catalog_private.region_selection_keywords(text)','execute'),
     'compiled selection lookup does not expose a new client RPC';
 end if;
 assert (select storage_ceiling=25165824 from bid_active_catalog_private.runtime)
   and (select storage_ceiling=33554432 from bid_alert_private.runtime),'existing catalog and combined budgets stay unchanged';
end $$;

-- The runner captures these measurements before the rollback. A performance
-- comparison belongs outside SQL because PGlite ignores statement_timeout.
select mode,elapsed_ms,verified_count,pending_count,condition_pending_count,queued from regional_status_benchmark order by mode;
rollback;
