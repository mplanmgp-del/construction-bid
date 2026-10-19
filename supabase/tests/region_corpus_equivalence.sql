-- The fixed SQL reference is the regional corpus definition from the original
-- regional-name migration. Keep raw source projection and normalization equal.
begin;

create function pg_temp.region_reference_corpus(p_notice jsonb)
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

create temp table corpus_equivalence_atoms(value jsonb);
insert into corpus_equivalence_atoms values
 ('null'),('false'),('true'),('0'),('123.450'),('""'),('" "'),('"서울"'),('"광주시"'),
 ('"전남광주통합특별시"'),('"  전국　 "'),('"ＳＥＯＵＬ ４９９５"'),('"A\n\tB\rC"'),
 ('"서울"'),('"ǅ ㍿ ①"'),('"mixed CASE"'),('"quotes \" slash / backslash \\"'),
 ('{}'),('{"name":"서울"}'),('{"nested":{"Ｂ":"서울"}}'),('[]'),('["서울",null,42]');

create temp table corpus_equivalence_arrays(value jsonb);
insert into corpus_equivalence_arrays select value from corpus_equivalence_atoms;
insert into corpus_equivalence_arrays select jsonb_build_array(value) from corpus_equivalence_atoms;
insert into corpus_equivalence_arrays values
 ('[]'),('[null,null]'),('[null,"",null,"  "]'),('["서울"," 부산 ","광주시"]'),
 ('["ＳＥＯＵＬ",123,true,{"name":"Ａ 서울"},["인천",null]]'),
 ('[{"name":null},{"name":false},{"name":12.500},{"name":{"province":"서울"}},{"name":["서울",null]},{"other":"ignored"}]');
insert into corpus_equivalence_arrays
 select jsonb_build_array(jsonb_build_object('name',value)) from corpus_equivalence_atoms;

create temp table corpus_equivalence_notices(id bigint generated always as identity,n jsonb);
insert into corpus_equivalence_notices(n) values(null),('{}');
insert into corpus_equivalence_notices(n) select value from corpus_equivalence_atoms;
insert into corpus_equivalence_notices(n)
 select jsonb_build_object(field,value) from corpus_equivalence_atoms
 cross join unnest(array['regionSearchText','title','agency','demandAgency','province','district',
   'description','duration','contractMethod','noticeKind','bidMethod','category','type',
   'allowedRegions','requirements','licenses','documents']) field;
insert into corpus_equivalence_notices(n)
 select jsonb_build_object(field,value) from corpus_equivalence_arrays
 cross join unnest(array['allowedRegions','requirements','licenses','documents']) field;
insert into corpus_equivalence_notices(n)
 select jsonb_build_object('regionSearchText','  Ａ 서울　','title','  광주시 ',
   'agency','종로구','demandAgency','수원시','province','경기도','district','광주시',
   'description',E'여러\n공백\t값','duration','  ２０２６ ','contractMethod','계약',
   'noticeKind','공고','bidMethod','입찰','category','구분','type','용역',
   'allowedRegions',a.value,'requirements',b.value,'licenses',a.value,'documents',b.value)
 from corpus_equivalence_arrays a cross join corpus_equivalence_arrays b;

do $$
declare mismatches text;cases bigint;
begin
 select string_agg(id::text,',') into mismatches from corpus_equivalence_notices
 where pg_temp.region_reference_corpus(n) is distinct from bid_active_catalog_private.region_keyword_corpus(n);
 if mismatches is not null then raise exception 'Regional corpus changed for fixture %',mismatches;end if;
 select count(*) into cases from corpus_equivalence_notices;
 if cases<1000 then raise exception 'Regional corpus equivalence coverage unexpectedly shrank';end if;
end $$;

select count(*) corpus_equivalence_cases from corpus_equivalence_notices;
rollback;
