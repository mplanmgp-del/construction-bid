-- Compile the static geography directory once, rather than expanding and
-- canonicalizing it for every notice in status counts and verification demand.
-- Regenerate these literal lookups whenever geo_directory changes.
begin;

do $migration$
declare clauses text;keywords text[];pattern text;definition text;anchor text;replacement text;occurrences integer;
begin
 select string_agg(format('when %L then %L::text[]',province,aliases::text),' ' order by province)
 into clauses from (
   select bid_active_catalog_private.canonical_province(key) province,array_agg(key order by key) aliases
   from jsonb_each_text(bid_active_catalog_private.geo_directory()->'aliases')
   group by bid_active_catalog_private.canonical_province(key)
 ) compiled where province is not null;
 execute format('create or replace function bid_active_catalog_private.region_province_keywords(p_province text)
 returns text[] language sql immutable security invoker set search_path='''' as %L',
   'select case p_province '||clauses||' else array[]::text[] end');

 -- The short alias 광주 retains its special 광주시 exclusion. All other tokens
 -- retain literal substring matching, including standalone district leaves.
 select array_agg(keyword order by keyword) into keywords from (
   select '전남광주통합특별시' keyword
   union select key from jsonb_each_text(bid_active_catalog_private.geo_directory()->'aliases') where key<>'광주'
   union select parts[cardinality(parts)] from jsonb_each(bid_active_catalog_private.geo_directory()->'districts') province,
     lateral jsonb_array_elements_text(province.value) district,
     lateral (select string_to_array(district,' ') parts) path
 ) compiled;
 -- A single cached regex avoids executing an unnest/strpos scan per unknown
 -- notice. Escape every literal token before joining the alternatives.
 select '('||string_agg(escaped,'|' order by keyword)||'|광주($|[^시]))' into pattern
 from unnest(keywords) keyword,
 lateral (select string_agg(case when strpos(chr(92)||'.^$*+?()[]{}|',character)>0
   then chr(92)||character else character end,'' order by ordinal) escaped
   from regexp_split_to_table(keyword,'') with ordinality part(character,ordinal)) literal;
 execute format('create or replace function bid_active_catalog_private.region_keyword_evidence(p_text text)
 returns boolean language sql immutable security invoker set search_path='''' as %L',
   format('select p_text ~ %L',pattern));

 select replace(pg_get_functiondef('bid_active_catalog_private.region_search_state(jsonb,jsonb)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('compiled-region-keywords-v1' in definition)=0 then
   anchor:=replace($a$or exists(select 1 from jsonb_object_keys(bid_active_catalog_private.geo_directory()->'aliases') alias
       where bid_active_catalog_private.canonical_province(alias)=province
         and bid_active_catalog_private.region_keyword_contains(corpus,lower(alias)))$a$,E'\r\n',E'\n');
   occurrences:=(length(definition)-length(replace(definition,anchor,'')))/length(anchor);
   if occurrences<>1 then raise exception 'Audited regional alias lookup changed';end if;
   replacement:=$a$-- compiled-region-keywords-v1
     or exists(select 1 from unnest(bid_active_catalog_private.region_province_keywords(province)) alias
       where bid_active_catalog_private.region_keyword_contains(corpus,lower(alias)))$a$;
   execute replace(definition,anchor,replacement);
 end if;
end $migration$;

revoke all on function bid_active_catalog_private.region_province_keywords(text),
 bid_active_catalog_private.region_keyword_evidence(text),bid_active_catalog_private.region_search_state(jsonb,jsonb)
 from public,anon,authenticated;
commit;
