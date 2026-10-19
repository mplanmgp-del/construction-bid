-- Apply the saved province AND any saved official industry code before paging.
-- The omitted code key retains the previous company-region search contract.
-- Existing data, budgets, token gates, privileges and collection scope remain.
begin;
create or replace function bid_active_catalog_private.normalize_search_profile(p_profile jsonb,p_use_codes boolean)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare result jsonb;codes jsonb;
begin
 if jsonb_typeof(p_profile) is distinct from 'object' then raise exception 'Invalid company region';end if;
 result:=jsonb_build_object('province',coalesce(p_profile->>'province',''),'district',coalesce(p_profile->>'district',''));
 -- Off means ignored, including an unrelated stale or malformed code field.
 if not coalesce(p_use_codes,false) or not(p_profile?'licenseCodes') then return result;end if;
 codes:=p_profile->'licenseCodes';
 if jsonb_typeof(codes) is distinct from 'array' then
   raise exception using errcode='22023',message='Invalid saved industry codes';end if;
 if jsonb_array_length(codes)>100 or exists(select 1 from jsonb_array_elements(codes) x
     where jsonb_typeof(x) is distinct from 'string' or (x#>>'{}')!~'^[0-9]{4}$') then
   raise exception using errcode='22023',message='Invalid saved industry codes';end if;
 select coalesce(jsonb_agg(code order by code),'[]'::jsonb) into codes
 from (select distinct value#>>'{}' code from jsonb_array_elements(codes)) normalized;
 return result||jsonb_build_object('licenseCodes',codes);
end $$;

do $$declare definition text;anchor text;replacement text;fn text;occurrences integer;changed boolean:=false;begin
 -- All three entry points share this projection in their signed query hashes
 -- and classifiers. Normalize both stored source and anchors for Windows SQL.
 foreach fn in array array['bid_active_catalog_private.search_page(jsonb)',
   'bid_active_catalog_private.search_results(jsonb)','bid_active_catalog_private.search_status(jsonb)'] loop
   select replace(pg_get_functiondef(fn::regprocedure),E'\r\n',E'\n') into definition;
   if position('saved-profile-code-projection-v1' in definition)>0 then continue;end if;
   anchor:=replace($a$profile:=coalesce(p_payload->'profile','{}'::jsonb);
 if jsonb_typeof(profile) is distinct from 'object' then raise exception 'Invalid company region';end if;
 profile:=jsonb_build_object('province',coalesce(profile->>'province',''),'district',coalesce(profile->>'district',''));$a$,E'\r\n',E'\n');
   occurrences:=(length(definition)-length(replace(definition,anchor,'')))/length(anchor);
   if occurrences<>1 then raise exception 'Audited saved-profile projection changed in %',fn;end if;
   replacement:=replace($a$-- saved-profile-code-projection-v1
 profile:=bid_active_catalog_private.normalize_search_profile(coalesce(p_payload->'profile','{}'::jsonb),f->>'autoRegion'='true');$a$,E'\r\n',E'\n');
   execute replace(definition,anchor,replacement);changed:=true;
 end loop;

 select replace(pg_get_functiondef('bid_active_catalog_private.search_match(jsonb,jsonb,jsonb,timestamptz)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('saved-profile-code-match-v1' in definition)=0 then
   anchor:=$a$regions:=coalesce(p_filters->'regions',$a$;
   occurrences:=(length(definition)-length(replace(definition,anchor,'')))/length(anchor);
   if occurrences<>1 then raise exception 'Audited saved-profile matcher boundary changed';end if;
   replacement:=replace($a$-- saved-profile-code-match-v1: independent of regionView's geographic classification.
 if p_filters->>'autoRegion'='true' and p_profile?'licenseCodes' then
   if jsonb_typeof(p_profile->'licenseCodes') is distinct from 'array' then return 'excluded';end if;
   if jsonb_array_length(p_profile->'licenseCodes')=0 then return 'excluded';end if;
   geo:=bid_active_catalog_private.industry_state(p_notice,p_profile->'licenseCodes');
   if geo='excluded' then return 'excluded';elsif geo='review' then pending:=true;end if;
 end if;
 regions:=coalesce(p_filters->'regions',$a$,E'\r\n',E'\n');
   execute replace(definition,anchor,replacement);changed:=true;
 end if;

 select replace(pg_get_functiondef('bid_active_catalog_private.request_search_verification(jsonb)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('saved-profile-code-demand-v1' in definition)=0 then
   anchor:=$a$profile:=coalesce(p_payload->'profile','{}'::jsonb);$a$;
   occurrences:=(length(definition)-length(replace(definition,anchor,'')))/length(anchor);
   if occurrences<>1 then raise exception 'Audited saved-profile demand projection changed';end if;
   replacement:=replace($a$-- saved-profile-code-demand-v1: same allowlist and canonical request identity as results.
 profile:=bid_active_catalog_private.normalize_search_profile(coalesce(p_payload->'profile','{}'::jsonb),f->>'autoRegion'='true');
 if f->>'autoRegion'='true' and profile?'licenseCodes' and jsonb_array_length(profile->'licenseCodes')=0 then return 0;end if;$a$,E'\r\n',E'\n');
   definition:=replace(definition,anchor,replacement);
   anchor:=$a$or f->>'license'<>'전체' and bid_active_catalog_private.industry_refresh_due(d.notice,d.verified_at,stamp)$a$;
   occurrences:=(length(definition)-length(replace(definition,anchor,'')))/length(anchor);
   if occurrences<>1 then raise exception 'Audited saved-profile industry refresh eligibility changed';end if;
   replacement:=replace($a$or (f->>'license'<>'전체' or f->>'autoRegion'='true' and profile?'licenseCodes')
       and bid_active_catalog_private.industry_refresh_due(d.notice,d.verified_at,stamp)$a$,E'\r\n',E'\n');
   definition:=replace(definition,anchor,replacement);
   -- Main-only legacy and incomplete negative facts can conceal another code.
   -- Only possible-match verification demand relaxes them; result membership
   -- still requires the observed exact code through the matcher above.
   anchor:=$a$profile,stamp)<>'excluded'$a$;
   occurrences:=(length(definition)-length(replace(definition,anchor,'')))/length(anchor);
   if occurrences<>1 then raise exception 'Audited saved-profile possible-match prefilter changed';end if;
   replacement:=replace($a$case when f->>'autoRegion'='true' and profile?'licenseCodes'
         and bid_active_catalog_private.industry_refresh_due(d.notice,d.verified_at,stamp)
         then profile-'licenseCodes' else profile end,stamp)<>'excluded'$a$,E'\r\n',E'\n');
   definition:=replace(definition,anchor,replacement);
   execute definition;changed:=true;
 end if;
 if changed then
   update bid_active_catalog_private.runtime set search_generation=search_generation+1,search_changed_xid=txid_current() where singleton;
 end if;
end $$;
revoke all on function bid_active_catalog_private.normalize_search_profile(jsonb,boolean) from public,anon,authenticated;
commit;
