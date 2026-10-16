-- Keyword discovery regression. All records and helper functions roll back.
begin;
create function pg_temp.keyword_notice(p_more jsonb default '{}'::jsonb)
returns jsonb language sql as $$
 select jsonb_build_object('id','g2b:공사:R26REGIONKEY:000','type','공사','number','R26REGIONKEY','revision','000',
   'title','철거 공사','agency','공공 기관','category','철거·해체','province','','district','',
   'postedAt',now()-interval '1 day','sourceUpdatedAt',now()-interval '1 minute',
   'biddingStartAt',now()-interval '1 day','deadline',now()+interval '4 days','openingAt',now()+interval '5 days',
   'status','접수중','source','live','licenses','[]'::jsonb,'allowedRegions','[]'::jsonb,
   'regionComplete',true,'licenseComplete',true,'contractMethod','제한경쟁','estimatedPrice',100000000)||p_more;
$$;
create function pg_temp.keyword_filters(p_more jsonb default '{}'::jsonb)
returns jsonb language sql as $$
 select '{"keyword":"","excludeKeyword":"","category":"전체","type":"전체","siteProvince":"전체","license":"전체",
 "minAmount":"","maxAmount":"","status":"전체","contractMethod":"전체","deadlineFrom":"","deadlineTo":"",
 "regionView":"all","autoRegion":false,"regions":[{"province":"서울특별시"}],"includeUnknownRegions":false}'::jsonb||p_more;
$$;

do $$declare n jsonb;f text;value jsonb;selection jsonb:='[{"province":"서울특별시"}]';begin
 assert not has_function_privilege('anon','bid_active_catalog_private.region_keyword_corpus(jsonb)','execute'),'keyword corpus remains private';
 assert not has_function_privilege('authenticated','bid_active_catalog_private.region_search_state(jsonb,jsonb)','execute'),'matching remains token guarded';
 assert (select storage_ceiling=25165824 from bid_active_catalog_private.runtime),'catalog cap remains 24 MiB';
 assert (select storage_ceiling=33554432 from bid_alert_private.runtime),'total cap remains 32 MiB';

 -- Every provider-text surface can independently supply the matching keyword,
 -- even when the old designated site / participant field names another area.
 foreach f in array array['title','agency','demandAgency','province','district','description','duration',
   'contractMethod','noticeKind','bidMethod','category','type','regionSearchText','requirements','documents','licenses','allowedRegions'] loop
   value:=case when f in ('requirements','licenses','allowedRegions') then '["서울 현장"]'::jsonb
     when f='documents' then '[{"name":"서울특별시 공사내역서.pdf"}]'::jsonb else '"서울 현장"'::jsonb end;
   n:=pg_temp.keyword_notice('{"province":"부산광역시","district":"해운대구","allowedRegions":["부산광역시"]}')||jsonb_build_object(f,value);
   assert bid_active_catalog_private.region_search_state(n,selection)='matched','keyword field match: '||f;
 end loop;
 n:=pg_temp.keyword_notice('{"type":"용역","agency":"서울시설공단","allowedRegions":["부산"],"regionComplete":false}');
 assert bid_active_catalog_private.search_match(n,pg_temp.keyword_filters(),'{}',now())='match','missing structured participant details do not override an agency keyword';
 n:=pg_temp.keyword_notice('{"province":"부산광역시","agency":"공공 기관","allowedRegions":["부산광역시"]}');
 assert bid_active_catalog_private.region_search_state(n,selection)='excluded','explicit other-region text is excluded';
 n:=pg_temp.keyword_notice();
 assert bid_active_catalog_private.region_search_state(n,selection)='review','missing regional evidence stays review';
 assert bid_active_catalog_private.search_match(n,pg_temp.keyword_filters(),'{}',now())='pending','unknown checkbox off withholds unknown';
 assert bid_active_catalog_private.search_match(n,pg_temp.keyword_filters('{"includeUnknownRegions":true}'),'{}',now())='match_unknown','unknown checkbox on includes review';
 assert bid_active_catalog_private.region_search_state(n||'{"allowedRegions":["전국"]}',selection)='matched','nationwide participant scope covers selected regions';
 assert bid_active_catalog_private.region_search_state(n||'{"agency":"부산시설공단"}','[{"province":"서울"},{"province":"부산"}]')='matched','multiple region selection is OR';

 assert bid_active_catalog_private.region_search_state(n||'{"regionSearchText":"현장 강남구 역삼동"}',
   '[{"province":"서울특별시","district":"강남구","locality":"역삼동"}]')='matched','locality keyword works without province prefix';
 assert bid_active_catalog_private.region_search_state(n||'{"title":"팔달구 철거"}',
   '[{"province":"경기도","district":"수원시 팔달구"}]')='matched','district uses the final hierarchy leaf';
 assert bid_active_catalog_private.region_search_state(n||'{"description":"부산광역시 해운대구"}',
   '[{"province":"서울특별시","district":"강남구"}]')='excluded','specific leaf absent in known other-region text';
 assert bid_active_catalog_private.region_search_state(n||'{"title":"인천시 중구"}',
   '[{"province":"서울특별시","district":"중구"}]')='matched','same leaf name remains a broad keyword, not inferred eligibility';
 assert bid_active_catalog_private.region_search_state(n||'{"title":"강남구 철거"}',
   '[{"province":"강남구"}]')='matched','standalone district text works as a freeform keyword';
 assert bid_active_catalog_private.region_search_state(n||'{"title":"파장동 철거"}',
   '[{"province":"파장동"}]')='matched','standalone locality text works as a freeform keyword';
 assert bid_active_catalog_private.region_search_state(n||'{"title":"강남구 철거"}',
   '[{"province":"부산광역시"}]')='excluded','standalone known district is regional evidence';
 assert bid_active_catalog_private.region_search_state(n||'{"regionSearchText":"서울　특별시 공고"}',selection)='matched','NFKC and whitespace-normalized short alias match';
end $$;

do $$declare n jsonb:=pg_temp.keyword_notice();row record;alias text;selection jsonb;compacted jsonb;version text;begin
 for row in select key,value from jsonb_each_text(bid_active_catalog_private.geo_directory()->'aliases') loop
   alias:=row.key;selection:=jsonb_build_array(jsonb_build_object('province',row.value));
   assert bid_active_catalog_private.region_search_state(n||jsonb_build_object('regionSearchText',alias||' 철거'),selection)='matched','province alias match: '||alias;
 end loop;
 assert bid_active_catalog_private.region_search_state(n||'{"regionSearchText":"전남광주통합특별시 공고"}',
   '[{"province":"광주광역시"}]')='matched','combined region alias retained';
 assert bid_active_catalog_private.region_search_state(n||'{"regionSearchText":"경기도 광주시"}',
   '[{"province":"광주광역시"}]')='excluded','Gyeonggi 광주시 does not mean metropolitan 광주';
 assert bid_active_catalog_private.region_search_state(n||'{"regionSearchText":"광주광역시"}',
   '[{"province":"전라남도"}]')='matched','existing combined search-region semantics retained';
 assert bid_active_catalog_private.profile_region_state(n||'{"agency":"서울시설공단","allowedRegions":["부산광역시"],"regionComplete":false}',
   '{"province":"서울특별시","district":"강남구"}')='matched','company province filter uses all text without requiring district';
 assert bid_active_catalog_private.profile_region_state(n,'{"province":"미등록","district":"강남구"}')='review','invalid company province stays review';
 assert bid_active_catalog_private.search_match(n||'{"agency":"서울시설공단","regionComplete":false}',
   pg_temp.keyword_filters('{"regions":[],"autoRegion":true}'),'{"province":"서울특별시","district":"강남구"}',now())='match','company filter ignores structured-condition completeness';

 compacted:=bid_active_catalog_private.compact(n||jsonb_build_object('regionSearchText',repeat('서',16010)||'울','description','large omitted body'));
 assert length(compacted->>'regionSearchText')=16000,'provider projection remains bounded';
 assert compacted->>'description'='' and compacted->'documents'='[]'::jsonb,'full document bodies stay omitted';
 version:=bid_active_catalog_private.source_version(bid_active_catalog_private.compact(n||'{"regionSearchText":"서울"}'));
 assert version<>bid_active_catalog_private.source_version(bid_active_catalog_private.compact(n||'{"regionSearchText":"부산"}')),'region source projection participates in source version';
 assert not bid_active_catalog_private.compact(n||'{"regionSearchText":null}')?'regionSearchText','invalid optional text is not retained';
end $$;

-- Exercise the real token-authenticated search path rather than helper-only
-- classification, including a pre-existing row with no projection field.
update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8'));
do $$declare n jsonb;r jsonb;q jsonb;begin
 delete from bid_active_catalog_private.deadline_index;
 delete from bid_active_catalog_private.verification;
 foreach n in array array[
   pg_temp.keyword_notice('{"number":"R26REGIONNEW","agency":"부산시설공단","regionSearchText":"서울특별시 강남구 역삼동 현장"}'),
   pg_temp.keyword_notice('{"number":"R26REGIONOLD","agency":"서울시설공단","province":"부산광역시"}'),
   pg_temp.keyword_notice('{"number":"R26REGIONOTHER","agency":"부산시설공단","province":"부산광역시"}')
 ] loop
   n:=bid_active_catalog_private.compact(n);
   insert into bid_active_catalog_private.deadline_index(type,number,revision,notice,source_updated_at,deadline,opening_at,verified_at,source_version,verified_version)
   values(n->>'type',n->>'number',0,n,(n->>'sourceUpdatedAt')::timestamptz,(n->>'deadline')::timestamptz,(n->>'openingAt')::timestamptz,
     now(),bid_active_catalog_private.source_version(n),bid_active_catalog_private.source_version(n));
 end loop;
 q:=jsonb_build_object('type','공사·용역','from','1995-10-01','to','2100-12-31','keyword','',
   'filters',pg_temp.keyword_filters(),'limit',50);
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_results',q);
 assert r->>'totalCount'='2' and jsonb_array_length(r->'items')=2,'production search includes projected detail and legacy agency keyword rows';
 assert not exists(select 1 from jsonb_array_elements(r->'items') item where item->>'number'='R26REGIONOTHER'),'production search excludes known other-region row';
 assert exists(select 1 from jsonb_array_elements(r->'items') item where item->>'regionSearchText' like '%역삼동%'),'keyword source projection survives publication and response';
end $$;
rollback;
