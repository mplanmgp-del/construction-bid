-- Compare optimized classification against fixed copies of the pre-optimization
-- functions, including JSON shape, normalization and legacy-code edge cases.
begin;

create function pg_temp.industry_reference_notice_codes(p_notice jsonb)
returns jsonb language sql immutable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(code order by code),'[]'::jsonb) from (
   select distinct case when p_notice?'licenseCodes' then
     case when bid_active_catalog_private.clean_search_text(value#>>'{}')~'^[0-9]{4}$'
       then bid_active_catalog_private.clean_search_text(value#>>'{}') end
     else bid_active_catalog_private.explicit_industry_code(value#>>'{}') end code
   from jsonb_array_elements(case when p_notice?'licenseCodes' then
     case when jsonb_typeof(p_notice->'licenseCodes')='array' then p_notice->'licenseCodes' else '[]'::jsonb end
     when jsonb_typeof(p_notice->'licenses')='array' then p_notice->'licenses' else '[]'::jsonb end)
   where jsonb_typeof(value)='string'
 ) facts where code is not null;
$$;

create function pg_temp.industry_reference_state(p_notice jsonb,p_selections jsonb)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare selection text;code text;codes jsonb:=pg_temp.industry_reference_notice_codes(p_notice);unresolved boolean:=false;
begin
 if jsonb_typeof(p_selections) is distinct from 'array' then return 'review';end if;
 if jsonb_array_length(p_selections)=0 then return 'review';end if;
 for selection in select value from jsonb_array_elements_text(p_selections) loop
   code:=bid_active_catalog_private.selected_industry_code(selection);
   if code is null then unresolved:=true;elsif codes?code then return 'matched';end if;
 end loop;
 if unresolved or jsonb_array_length(codes)=0 or p_notice->>'licenseComplete'='false' then return 'review';end if;
 return 'excluded';
end $$;

create temp table industry_equivalence_atoms(value jsonb);
insert into industry_equivalence_atoms values
 ('null'),('false'),('true'),('0'),('4995'),('""'),('"4995"'),('"0002"'),
 ('" 4995 "'),('"４９９５"'),('" ０００２　"'),('"4995\n"'),
 ('"구조물해체·비계공사업"'),('"구조물해체·비계공사업/4995"'),
 ('"건축공사업(0002)"'),('"건축공사업(０００２)"'),('"해체(4995) · 주력분야"'),
 ('"junk"'),('"123"'),('"12345"'),('"4995/0002"'),('{}'),('[]'),('["4995"]'),('{"code":"4995"}');

create temp table industry_equivalence_arrays(value jsonb);
insert into industry_equivalence_arrays values
 ('[]'),('["4995","4995","0002"]'),('[" 4995 ","４９９５","0002"]'),
 ('[null,"4995",4995,"0002"]'),('["해체/4995","건축(0002)"]'),
 ('["건축(0002)","해체/4995","건축(0002)"]');
insert into industry_equivalence_arrays select jsonb_build_array(value) from industry_equivalence_atoms;

create temp table industry_equivalence_completeness(extra jsonb);
insert into industry_equivalence_completeness values
 ('{}'),('{"licenseComplete":true}'),('{"licenseComplete":false}'),
 ('{"licenseComplete":"true"}'),('{"licenseComplete":"false"}');

create temp table industry_equivalence_notices(id bigint generated always as identity,n jsonb);
insert into industry_equivalence_notices(n) values
 (null),('null'),('{}'),('false'),('"licenseCodes"'),('[]');
insert into industry_equivalence_notices(n)
 select jsonb_build_object('licenseCodes',value,'licenses',jsonb_build_array('해체/4995')) from industry_equivalence_atoms;
insert into industry_equivalence_notices(n)
 select jsonb_build_object('licenses',value) from industry_equivalence_atoms;
insert into industry_equivalence_notices(n)
 select jsonb_build_object('licenseCodes',a.value,'licenses',jsonb_build_array('건축(0002)'))||c.extra
 from industry_equivalence_arrays a cross join industry_equivalence_completeness c;
insert into industry_equivalence_notices(n)
 select jsonb_build_object('licenses',a.value)||c.extra
 from industry_equivalence_arrays a cross join industry_equivalence_completeness c;

create temp table industry_equivalence_selections(id bigint generated always as identity,s jsonb);
insert into industry_equivalence_selections(s) values
 (null),('null'),('{}'),('false'),('"4995"'),('[]'),
 ('[null,"4995"]'),('["건축공사업","junk"]'),('["junk","4995"]'),('["0002","4995"]');
insert into industry_equivalence_selections(s)
 select jsonb_build_array(value) from industry_equivalence_atoms;
insert into industry_equivalence_selections(s)
 select value from industry_equivalence_arrays;

do $$
declare mismatch text;notice_count bigint;selection_count bigint;
begin
 select string_agg(id::text,',') into mismatch from industry_equivalence_notices
 where pg_temp.industry_reference_notice_codes(n)
   is distinct from bid_active_catalog_private.notice_industry_codes(n);
 if mismatch is not null then raise exception 'Industry code extraction changed for fixture %',mismatch;end if;
 select string_agg(n.id::text||'/'||s.id::text,',') into mismatch
 from industry_equivalence_notices n cross join industry_equivalence_selections s
 where pg_temp.industry_reference_state(n.n,s.s)
   is distinct from bid_active_catalog_private.industry_state(n.n,s.s);
 if mismatch is not null then raise exception 'Industry state changed for notice/selection fixture %',mismatch;end if;
 select count(*) into notice_count from industry_equivalence_notices;
 select count(*) into selection_count from industry_equivalence_selections;
 if notice_count*selection_count<20000 then raise exception 'Industry equivalence fixture coverage unexpectedly shrank';end if;
end $$;

select (select count(*) from industry_equivalence_notices) notice_cases,
 (select count(*) from industry_equivalence_selections) selection_cases,
 (select count(*) from industry_equivalence_notices)*(select count(*) from industry_equivalence_selections) state_cases;
rollback;
