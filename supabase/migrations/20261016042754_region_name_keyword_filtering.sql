-- Discovery uses regional name keywords anywhere in the provider's text.
-- This broadens discovery only; it does not certify legal bid eligibility.
-- Existing compact catalog / total storage caps, leases and RLS stay in force.
begin;

create or replace function bid_active_catalog_private.region_keyword_corpus(p_notice jsonb)
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
create or replace function bid_active_catalog_private.region_keyword_contains(p_text text,p_keyword text)
returns boolean language sql immutable security invoker set search_path='' as $$
 select case when p_keyword='광주' then p_text~'광주($|[^시])'
   else p_keyword<>'' and strpos(p_text,p_keyword)>0 end;
$$;

create or replace function bid_active_catalog_private.region_keyword_evidence(p_text text)
returns boolean language sql immutable security invoker set search_path='' as $$
 select strpos(p_text,'전남광주통합특별시')>0
   or exists(select 1 from jsonb_object_keys(bid_active_catalog_private.geo_directory()->'aliases') alias
     where bid_active_catalog_private.region_keyword_contains(p_text,alias))
   or exists(select 1 from jsonb_each(bid_active_catalog_private.geo_directory()->'districts') province,
     lateral jsonb_array_elements_text(province.value) district,
     lateral (select string_to_array(district,' ') parts) path
     where strpos(p_text,path.parts[cardinality(path.parts)])>0);
$$;

create or replace function bid_active_catalog_private.region_search_state(p_notice jsonb,p_regions jsonb)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare selection jsonb;province text;leaf text;parts text[];corpus text;
begin
 if jsonb_typeof(p_regions) is distinct from 'array' then return 'review';end if;
 if jsonb_array_length(p_regions)=0 then return 'matched';end if;
 if exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(p_notice->'allowedRegions')='array'
   then p_notice->'allowedRegions' else '[]'::jsonb end) region
   where bid_active_catalog_private.clean_search_text(region)='전국') then return 'matched';end if;
 corpus:=bid_active_catalog_private.region_keyword_corpus(p_notice);
 for selection in select value from jsonb_array_elements(p_regions) loop
   province:=bid_active_catalog_private.canonical_province(selection->>'province');
   leaf:=bid_active_catalog_private.clean_search_text(selection->>'locality');
   if leaf='' then leaf:=bid_active_catalog_private.clean_search_text(selection->>'district');end if;
   if province='세종특별자치시' and leaf='세종시' then leaf:='';end if;
   if leaf<>'' then
     parts:=string_to_array(leaf,' ');leaf:=lower(parts[cardinality(parts)]);
     if strpos(corpus,leaf)>0 then return 'matched';end if;
   elsif (province is null and bid_active_catalog_private.region_keyword_contains(corpus,lower(bid_active_catalog_private.clean_search_text(selection->>'province'))))
     or (province='전남광주통합특별시' and strpos(corpus,'전남광주통합특별시')>0)
     or exists(select 1 from jsonb_object_keys(bid_active_catalog_private.geo_directory()->'aliases') alias
       where bid_active_catalog_private.canonical_province(alias)=province
         and bid_active_catalog_private.region_keyword_contains(corpus,lower(alias))) then return 'matched';end if;
 end loop;
 return case when not bid_active_catalog_private.region_keyword_evidence(corpus)
   then 'review' else 'excluded' end;
end $$;

-- Company-region filters use the saved province keyword. A specific company
-- district must not hide notices whose text states only the province.
create or replace function bid_active_catalog_private.profile_region_state(p_notice jsonb,p_profile jsonb)
returns text language plpgsql immutable security invoker set search_path='' as $$
begin
 if bid_active_catalog_private.clean_search_text(p_profile->>'province')='' then return 'review';end if;
 return bid_active_catalog_private.region_search_state(p_notice,jsonb_build_array(jsonb_build_object('province',p_profile->>'province')));
end $$;

-- Keep a bounded provider-text projection alongside the existing compact
-- fields. It is source data, so source_version already includes it naturally.
do $$declare definition text;anchor text;begin
 select replace(pg_get_functiondef('bid_active_catalog_private.compact(jsonb)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('region-name-keyword-compact-v1' in definition)=0 then
   anchor:=$a$'sourceOmittedDigest','openingCompleted'$a$;
   if position(anchor in definition)=0 then raise exception 'Audited compact allowlist changed';end if;
   definition:=replace(definition,anchor,anchor||$a$,'regionSearchText'$a$);
   anchor:=$a$return result||$a$;
   if position(anchor in definition)=0 then raise exception 'Audited compact return changed';end if;
   definition:=replace(definition,anchor,$a$-- region-name-keyword-compact-v1
 if jsonb_typeof(result->'regionSearchText')='string' then
   result:=jsonb_set(result,'{regionSearchText}',to_jsonb(left(result->>'regionSearchText',16000)));
 else result:=result-'regionSearchText';end if;
 return result||$a$);
   execute definition;
 end if;
 select replace(pg_get_functiondef('bid_active_catalog_private.search_match(jsonb,jsonb,jsonb,timestamptz)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('region-name-keyword-match-v1' in definition)=0 then
   anchor:=$a$if p_notice->>'type'='용역' and p_notice->>'regionComplete' is distinct from 'true' then geo:='review';end if;$a$;
   if position(anchor in definition)=0 then raise exception 'Audited service region override changed';end if;
   definition:=replace(definition,anchor,$a$-- region-name-keyword-match-v1: source text is sufficient evidence.$a$);
   anchor:=$a$if p_notice->>'regionComplete' is distinct from 'true' then profile_geo:='review';end if;$a$;
   if position(anchor in definition)=0 then raise exception 'Audited company region override changed';end if;
   definition:=replace(definition,anchor,'');
   execute definition;
   update bid_active_catalog_private.runtime set search_generation=search_generation+1,search_changed_xid=txid_current() where singleton;
 end if;
end $$;

revoke all on function bid_active_catalog_private.region_keyword_corpus(jsonb),
 bid_active_catalog_private.region_keyword_contains(text,text),bid_active_catalog_private.region_keyword_evidence(text),
 bid_active_catalog_private.region_search_state(jsonb,jsonb),bid_active_catalog_private.profile_region_state(jsonb,jsonb)
 from public,anon,authenticated;
commit;
