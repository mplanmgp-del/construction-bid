-- Avoid aggregate/rowset setup for the usual zero-or-one industry restriction.
-- Generated with the CLI; ordered after the existing saved-profile patches.
begin;

create or replace function bid_active_catalog_private.notice_industry_codes(p_notice jsonb)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare facts jsonb;fact jsonb;single_code text;explicit_codes boolean:=p_notice?'licenseCodes';
begin
 facts:=case when explicit_codes then
   case when jsonb_typeof(p_notice->'licenseCodes')='array' then p_notice->'licenseCodes' else '[]'::jsonb end
   when jsonb_typeof(p_notice->'licenses')='array' then p_notice->'licenses' else '[]'::jsonb end;
 if jsonb_array_length(facts)=0 then return '[]'::jsonb;end if;
 if jsonb_array_length(facts)=1 then
   fact:=facts->0;
   if jsonb_typeof(fact) is distinct from 'string' then return '[]'::jsonb;end if;
   if explicit_codes then
     single_code:=bid_active_catalog_private.clean_search_text(fact#>>'{}');
     if single_code!~'^[0-9]{4}$' then return '[]'::jsonb;end if;
   else
     single_code:=bid_active_catalog_private.explicit_industry_code(fact#>>'{}');
     if single_code is null then return '[]'::jsonb;end if;
   end if;
   return jsonb_build_array(single_code);
 end if;
 -- Keep the original aggregate, ordering and duplicate handling for multiple
 -- facts, including malformed entries and legacy explicit provider codes.
 return (select coalesce(jsonb_agg(code order by code),'[]'::jsonb) from (
   select distinct case when p_notice?'licenseCodes' then
     case when bid_active_catalog_private.clean_search_text(value#>>'{}')~'^[0-9]{4}$'
       then bid_active_catalog_private.clean_search_text(value#>>'{}') end
     else bid_active_catalog_private.explicit_industry_code(value#>>'{}') end code
   from jsonb_array_elements(case when p_notice?'licenseCodes' then
     case when jsonb_typeof(p_notice->'licenseCodes')='array' then p_notice->'licenseCodes' else '[]'::jsonb end
     when jsonb_typeof(p_notice->'licenses')='array' then p_notice->'licenses' else '[]'::jsonb end)
   where jsonb_typeof(value)='string'
 ) facts where code is not null);
end $$;

create or replace function bid_active_catalog_private.industry_state(p_notice jsonb,p_selections jsonb)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare selection text;code text;codes jsonb:=bid_active_catalog_private.notice_industry_codes(p_notice);unresolved boolean:=false;i integer;
begin
 if jsonb_typeof(p_selections) is distinct from 'array' then return 'review';end if;
 if jsonb_array_length(p_selections)=0 then return 'review';end if;
 for i in 0..jsonb_array_length(p_selections)-1 loop
   selection:=p_selections->>i;
   if selection~'^[0-9]{4}$' then code:=selection;
   else code:=bid_active_catalog_private.selected_industry_code(selection);end if;
   if code is null then unresolved:=true;elsif codes?code then return 'matched';end if;
 end loop;
 if unresolved or jsonb_array_length(codes)=0 or p_notice->>'licenseComplete'='false' then return 'review';end if;
 return 'excluded';
end $$;

revoke all on function bid_active_catalog_private.notice_industry_codes(jsonb),
 bid_active_catalog_private.industry_state(jsonb,jsonb) from public,anon,authenticated;
commit;
