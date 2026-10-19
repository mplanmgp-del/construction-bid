-- Evaluate the same regional text rules without rebuilding the geography
-- directory or creating a SQL rowset for every notice. Generated with the CLI;
-- ordered after the saved-profile migration whose search patches are preserved.
begin;

do $migration$
declare clauses text;
begin
 with groups as (
   select bid_active_catalog_private.canonical_province(key) province,array_agg(key order by key) aliases
   from jsonb_each_text(bid_active_catalog_private.geo_directory()->'aliases')
   group by bid_active_catalog_private.canonical_province(key)
 ), inputs as (
   select input,case when province='전남광주통합특별시' then aliases||array[province] else aliases end keywords
   from groups,lateral unnest(aliases||array[province]) input
 )
 select string_agg(format('when %L then %L::text[]',input,keywords::text),' ' order by input)
 into clauses from (select distinct input,keywords from inputs where input is not null) compiled;
 execute format('create or replace function bid_active_catalog_private.region_selection_keywords(p_province text)
 returns text[] language sql immutable security invoker set search_path='''' as %L',
   'select case p_province '||clauses||' else array[]::text[] end');
end $migration$;

create or replace function bid_active_catalog_private.region_search_state(p_notice jsonb,p_regions jsonb)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare selection jsonb;province text;leaf text;parts text[];corpus text;keywords text[];keyword text;i integer;allowed jsonb;
begin
 -- compiled-region-keywords-v1: retained for replay of the earlier migration;
 -- its alias rowset is now replaced by direct compiled selection keywords.
 if jsonb_typeof(p_regions) is distinct from 'array' then return 'review';end if;
 if jsonb_array_length(p_regions)=0 then return 'matched';end if;
 allowed:=p_notice->'allowedRegions';
 if jsonb_typeof(allowed)='array' then
   for i in 0..jsonb_array_length(allowed)-1 loop
     if bid_active_catalog_private.clean_search_text(allowed->>i)='전국' then return 'matched';end if;
   end loop;
 end if;
 corpus:=bid_active_catalog_private.region_keyword_corpus(p_notice);
 for i in 0..jsonb_array_length(p_regions)-1 loop
   selection:=p_regions->i;
   province:=bid_active_catalog_private.clean_search_text(selection->>'province');
   keywords:=bid_active_catalog_private.region_selection_keywords(province);
   leaf:=bid_active_catalog_private.clean_search_text(selection->>'locality');
   if leaf='' then leaf:=bid_active_catalog_private.clean_search_text(selection->>'district');end if;
   if '세종특별자치시'=any(keywords) and leaf='세종시' then leaf:='';end if;
   if leaf<>'' then
     parts:=string_to_array(leaf,' ');leaf:=lower(parts[cardinality(parts)]);
     if strpos(corpus,leaf)>0 then return 'matched';end if;
   elsif cardinality(keywords)=0 then
     province:=lower(province);
     if (case when province='광주' then corpus~'광주($|[^시])'
       else province<>'' and strpos(corpus,province)>0 end) then return 'matched';end if;
   else
     foreach keyword in array keywords loop
       if (case when keyword='광주' then corpus~'광주($|[^시])'
         else keyword<>'' and strpos(corpus,keyword)>0 end) then return 'matched';end if;
     end loop;
   end if;
 end loop;
 return case when not bid_active_catalog_private.region_keyword_evidence(corpus) then 'review' else 'excluded' end;
end $$;

-- A saved company profile searches one province; its district is intentionally
-- ignored as in the original regional discovery rules.
create or replace function bid_active_catalog_private.profile_region_state(p_notice jsonb,p_profile jsonb)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare province text:=bid_active_catalog_private.clean_search_text(p_profile->>'province');
 corpus text;keywords text[];keyword text;allowed jsonb;i integer;
begin
 if province='' then return 'review';end if;
 allowed:=p_notice->'allowedRegions';
 if jsonb_typeof(allowed)='array' then
   for i in 0..jsonb_array_length(allowed)-1 loop
     if bid_active_catalog_private.clean_search_text(allowed->>i)='전국' then return 'matched';end if;
   end loop;
 end if;
 corpus:=bid_active_catalog_private.region_keyword_corpus(p_notice);
 keywords:=bid_active_catalog_private.region_selection_keywords(province);
 if cardinality(keywords)=0 then
   province:=lower(province);
   if (case when province='광주' then corpus~'광주($|[^시])'
     else strpos(corpus,province)>0 end) then return 'matched';end if;
 else
   foreach keyword in array keywords loop
     if (case when keyword='광주' then corpus~'광주($|[^시])'
       else keyword<>'' and strpos(corpus,keyword)>0 end) then return 'matched';end if;
   end loop;
 end if;
 return case when not bid_active_catalog_private.region_keyword_evidence(corpus) then 'review' else 'excluded' end;
end $$;

revoke all on function bid_active_catalog_private.region_selection_keywords(text),
 bid_active_catalog_private.region_search_state(jsonb,jsonb),bid_active_catalog_private.profile_region_state(jsonb,jsonb)
 from public,anon,authenticated;
commit;
