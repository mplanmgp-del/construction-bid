-- Match procurement industry restrictions by their official four-digit codes.
-- Display names remain display facts; only an explicit provider code is notice
-- evidence. Existing leases, source fences and 24/32 MiB ceilings are retained.
begin;
create or replace function bid_active_catalog_private.industry_name_key(p_text text)
returns text language sql immutable security invoker set search_path='' as $$
 select regexp_replace(translate(bid_active_catalog_private.clean_search_text(p_text),'ㆍ・ᆞ.','····'),'\s','','g');
$$;

-- Verified G2B registry labels. Keep in sync with src/industry-codes.ts.
-- References are recorded with that shared directory; never use this directory
-- to invent an industry code for a plain-name notice restriction.
create or replace function bid_active_catalog_private.industry_directory()
returns jsonb language sql immutable security invoker set search_path='' as $$
 select '{"구조물해체·비계공사업":"4995","석면해체·제거업":"5652","건축공사업":"0002","실내건축공사업":"4990","토목공사업":"0001","도장·습식·방수·석공사업":"4992","전기공사업":"0037","정보통신공사업":"0036","전문소방시설공사업":"0040","기계설비·가스공사업":"6202","조경식재·시설물공사업":"4993","건설폐기물수집·운반업":"6728","건설폐기물중간처리업":"1253","건축사사무소":"4817"}'::jsonb;
$$;

create or replace function bid_active_catalog_private.explicit_industry_code(p_text text)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare value text:=bid_active_catalog_private.clean_search_text(p_text);code text;
begin
 if value~'^[0-9]{4}$' then return value;end if;
 code:=substring(value from '/([0-9]{4})$');
 if code is not null then return code;end if;
 return substring(value from '\(([0-9]{4})\)(\s*[·ㆍ・]\s*[^()]*)?$');
end $$;

create or replace function bid_active_catalog_private.selected_industry_code(p_text text)
returns text language sql immutable security invoker set search_path='' as $$
 select coalesce(bid_active_catalog_private.explicit_industry_code(p_text),
   bid_active_catalog_private.industry_directory()->>bid_active_catalog_private.industry_name_key(p_text));
$$;

create or replace function bid_active_catalog_private.notice_industry_codes(p_notice jsonb)
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

create or replace function bid_active_catalog_private.industry_state(p_notice jsonb,p_selections jsonb)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare selection text;code text;codes jsonb:=bid_active_catalog_private.notice_industry_codes(p_notice);unresolved boolean:=false;
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

create or replace function bid_active_catalog_private.source_version(p_notice jsonb)
returns text language sql immutable security invoker set search_path='' as $$
 select encode(sha256(convert_to((p_notice-array['allowedRegions','licenses','licenseCodes','regionComplete','licenseComplete',
 'openingCompleted','status','description','documents','requirements','duration','regionSearchText'])::text,'UTF8')),'hex');
$$;

create or replace function bid_active_catalog_private.industry_refresh_due(p_notice jsonb,p_verified_at timestamptz,p_stamp timestamptz)
returns boolean language sql immutable security invoker set search_path='' as $$
 select (not(p_notice?'licenseCodes') or p_notice->>'licenseComplete' is distinct from 'true'
     or jsonb_array_length(bid_active_catalog_private.notice_industry_codes(p_notice))=0)
   and (jsonb_typeof(p_notice->'licenseCodes') is distinct from 'array' or p_verified_at is null
     or p_verified_at<=p_stamp-interval '10 minutes');
$$;

-- A saved code filter with includeUnknown=false must not leave legacy
-- name-only rows permanently unreachable. This is only a possible-match
-- upgrade queue: exact API verification and the application still decide
-- membership. At most 100 existing heads are requested within the old budget.
create or replace function bid_active_catalog_private.request_industry_verification(p_scope text,p_stamp timestamptz)
returns integer language plpgsql volatile security invoker set search_path='' as $$
declare heads jsonb;needed integer;requested integer;ceiling bigint;marker text:='industries:'||p_scope;
begin
 select storage_ceiling into strict ceiling from bid_active_catalog_private.runtime where singleton;
 select coalesce(jsonb_agg(jsonb_build_object('type',q.type,'number',q.number)),'[]'::jsonb),count(*)filter(where not q.queued)
 into heads,needed from (
   select d.type,d.number,v.number is not null queued
   from bid_active_catalog_private.deadline_index d left join bid_active_catalog_private.verification v using(type,number)
   where bid_active_catalog_private.ongoing(d.notice,p_stamp)
     and bid_active_catalog_private.industry_refresh_due(d.notice,d.verified_at,p_stamp)
     and not exists(select 1 from bid_active_catalog_private.deadline_invalidations h where h.type=d.type and h.number=d.number
       and (h.revision>d.revision or h.revision=d.revision and h.source_updated_at>=d.source_updated_at))
     and not exists(select 1 from bid_active_catalog_private.groups g where g.type=d.type and g.number=d.number
       and (g.revision>d.revision or g.revision=d.revision and g.source_updated_at>=d.source_updated_at)
       and not bid_active_catalog_private.ongoing(g.latest,p_stamp))
     and exists(select 1 from jsonb_array_elements(bid_active_catalog_private.rules()) r,
       lateral (select r#>'{settings,filter}' f) rule
       where (coalesce(jsonb_array_length(rule.f->'licenses'),0)>0 or rule.f->>'useCompanyLicenses'='true')
         and (coalesce(jsonb_array_length(rule.f->'types'),0)=0 or rule.f->'types'?(d.notice->>'type'))
         and (coalesce(jsonb_array_length(rule.f->'categories'),0)=0 or rule.f->'categories'?(d.notice->>'category') or coalesce(d.notice->>'category','')='')
         and (coalesce(jsonb_array_length(rule.f->'keywords'),0)=0 or exists(select 1 from jsonb_array_elements_text(rule.f->'keywords') keyword
           where strpos(lower(concat_ws(' ',d.notice->>'title',d.notice->>'agency',d.notice->>'demandAgency')),lower(keyword))>0)))
     and (v.search_requested_at is null or v.search_requested_at<=p_stamp-interval '10 minutes')
   order by v.search_requested_at nulls first,d.deadline,d.type,d.number limit 100
 ) q;
 if jsonb_array_length(heads)=0 or bid_active_catalog_private.storage_bytes()+needed*1536+65536>=ceiling
   or bid_alert_private.storage_bytes()+needed*1536+65536>=33554432 then return 0;end if;
 insert into bid_active_catalog_private.verification(type,number,revision,source_updated_at,scope_version,source_version,procurement_source)
 select d.type,d.number,d.revision,d.source_updated_at,p_scope,d.source_version,
   case when d.notice->>'procurementSource'='private' then 'private' else 'public' end
 from bid_active_catalog_private.deadline_index d where exists(select 1 from jsonb_array_elements(heads) n where n->>'type'=d.type and n->>'number'=d.number)
 on conflict(type,number) do nothing;
 update bid_active_catalog_private.verification v set search_requested_at=p_stamp,search_request_key=marker
 where v.scope_version=p_scope and (v.search_requested_at is null or v.search_requested_at<=p_stamp-interval '10 minutes')
   and exists(select 1 from jsonb_array_elements(heads) n where n->>'type'=v.type and n->>'number'=v.number);
 get diagnostics requested=row_count;
 if bid_active_catalog_private.storage_bytes()+65536>=ceiling or bid_alert_private.storage_bytes()+65536>=33554432 then
   raise exception using errcode='54000',message='Industry verification exceeds existing capacity';end if;
 return requested;
exception when others then return 0;
end $$;

do $$declare definition text;anchor text;fn text;changed boolean:=false;begin
 select replace(pg_get_functiondef('bid_active_catalog_private.compact(jsonb)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('industry-code-compact-v1' in definition)=0 then
   anchor:=$a$'biddingStartAt','licenses','specialRegionCondition'$a$;
   if position(anchor in definition)=0 then raise exception 'Audited industry compact allowlist changed';end if;
   definition:=replace(definition,anchor,$a$'biddingStartAt','licenses','licenseCodes','specialRegionCondition'$a$);
   anchor:=$a$result:=result||'{"description":"","duration":"","requirements":[],"documents":[]}'::jsonb;$a$;
   if position(anchor in definition)=0 then raise exception 'Audited compact omitted placeholders changed';end if;
   definition:=replace(definition,anchor,anchor||$a$
 -- industry-code-compact-v1: preserve leading zeroes and deduplicate facts.
 if result?'licenseCodes' then
   result:=jsonb_set(result,'{licenseCodes}',bid_active_catalog_private.notice_industry_codes(result));
 end if;$a$);
   execute definition;
   changed:=true;
 end if;

 select replace(pg_get_functiondef('bid_active_catalog_private.search_match(jsonb,jsonb,jsonb,timestamptz)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('industry-code-match-v1' in definition)=0 then
   anchor:=$a$if p_notice->>'licenseComplete' is distinct from 'true' or jsonb_typeof(p_notice->'licenses') is distinct from 'array' then pending:=true;
   elsif not exists(select 1 from jsonb_array_elements_text(p_notice->'licenses') license
     where bid_active_catalog_private.license_key(license)=bid_active_catalog_private.license_key(p_filters->>'license')) then return 'excluded';end if;$a$;
   anchor:=replace(anchor,E'\r\n',E'\n');
   if position(anchor in definition)=0 then raise exception 'Audited industry matcher changed';end if;
   execute replace(definition,anchor,$a$-- industry-code-match-v1
   geo:=bid_active_catalog_private.industry_state(p_notice,jsonb_build_array(p_filters->>'license'));
   if geo='excluded' then return 'excluded';elsif geo='review' then pending:=true;end if;$a$);
   changed:=true;
 end if;

 -- The code array belongs to participant enrichment, just like display names.
 -- Source hashes and same-clock conflict diagnostics must not classify it as
 -- an edited source notice. Apply this to every existing condition-cache path.
 foreach fn in array array['bid_active_catalog_private.worker_deadline(text,text,jsonb)',
   'bid_active_catalog_private.worker_legacy(text,text,jsonb)',
   'bid_active_catalog_private.worker_before_current(text,text,jsonb)',
   'bid_active_catalog_private.publication_conflict(jsonb,jsonb,text,integer,timestamptz)'] loop
   select replace(pg_get_functiondef(fn::regprocedure),E'\r\n',E'\n') into definition;
   if position('industry-code-condition-cache-v1' in definition)>0 then continue;end if;
   -- All four spellings are audited existing same-source cache merges.
   definition:=replace(definition,$a$jsonb_build_object('licenses',indexed.notice->'licenses','licenseComplete',true)$a$,
     $a$jsonb_build_object('licenses',indexed.notice->'licenses','licenseComplete',true)||case when indexed.notice?'licenseCodes' then jsonb_build_object('licenseCodes',indexed.notice->'licenseCodes') else '{}'::jsonb end$a$);
   definition:=replace(definition,$a$jsonb_build_object('licenses',prior_notice->'licenses','licenseComplete',true)$a$,
     $a$jsonb_build_object('licenses',prior_notice->'licenses','licenseComplete',true)||case when prior_notice?'licenseCodes' then jsonb_build_object('licenseCodes',prior_notice->'licenseCodes') else '{}'::jsonb end$a$);
   definition:=replace(definition,$a$jsonb_build_object('licenses',preserved->'licenses','licenseComplete',true)$a$,
     $a$jsonb_build_object('licenses',preserved->'licenses','licenseComplete',true)||case when preserved?'licenseCodes' then jsonb_build_object('licenseCodes',preserved->'licenseCodes') else '{}'::jsonb end$a$);
   definition:=replace(definition,$a$jsonb_build_object('licenses',n->'licenses','licenseComplete',true)$a$,
     $a$jsonb_build_object('licenses',n->'licenses','licenseComplete',true)||case when n?'licenseCodes' then jsonb_build_object('licenseCodes',n->'licenseCodes') else '{}'::jsonb end$a$);
   definition:=replace(definition,$a$'allowedRegions','licenses','regionComplete','licenseComplete'$a$,
     $a$'allowedRegions','licenses','licenseCodes','regionComplete','licenseComplete'$a$);
   -- Enrichment validation and compact budgets are still enforced by the
   -- existing worker. Reject malformed provided arrays before normalization.
   if fn='bid_active_catalog_private.worker_legacy(text,text,jsonb)' then
     anchor:=$a$if n->>'licenseComplete'='true' then$a$;
     if position(anchor in definition)=0 then raise exception 'Audited condition enrichment license guard changed';end if;
     definition:=replace(definition,anchor,anchor||$a$
         if n?'licenseCodes' and (jsonb_typeof(n->'licenseCodes') is distinct from 'array' or
           jsonb_array_length(n->'licenseCodes')>100 or exists(select 1 from jsonb_array_elements(n->'licenseCodes') x
             where jsonb_typeof(x)<>'string' or (x#>>'{}')!~'^[0-9]{4}$')) then raise exception 'Invalid industry code enrichment';end if;$a$);
   end if;
   -- Insert a harmless comment after the function header, before its body.
   definition:=replace(definition,E'AS $function$\n',E'AS $function$\n-- industry-code-condition-cache-v1\n');
   execute definition;
 end loop;

 -- Verified legacy rows can have complete display labels but no code facts.
 -- A code-filtered search must be able to request their exact recheck too.
 select replace(pg_get_functiondef('bid_active_catalog_private.request_search_verification(jsonb)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('industry-code-search-demand-v1' in definition)=0 then
   anchor:=$a$where (d.verified_at is null or d.source_version is distinct from d.verified_version)$a$;
   if position(anchor in definition)=0 then raise exception 'Audited exact search-demand eligibility changed';end if;
   definition:=replace(definition,anchor,$a$where (d.verified_at is null or d.source_version is distinct from d.verified_version
     or f->>'license'<>'전체' and bid_active_catalog_private.industry_refresh_due(d.notice,d.verified_at,stamp)) -- industry-code-search-demand-v1$a$);
   -- A legacy main code or incomplete response can omit other allowed codes.
   -- Relax only this verification prefilter; actual result membership still
   -- uses industry_state and therefore never publishes an assumed match.
   anchor:=$a$and bid_active_catalog_private.search_match(d.notice,f$a$;
   if position(anchor in definition)=0 then raise exception 'Audited possible-match search prefilter changed';end if;
   definition:=replace(definition,anchor,anchor||$a$
       ||case when bid_active_catalog_private.industry_refresh_due(d.notice,d.verified_at,stamp) then '{"license":"전체"}'::jsonb else '{}'::jsonb end$a$);
   execute definition;
 end if;

 select replace(pg_get_functiondef('public.bid_active_catalog_worker(text,text,jsonb)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('industry-code-saved-rule-demand-v1' in definition)=0 then
   anchor:=$a$if p_action<>'claim' or outcome->>'leaseId' is null then return outcome;end if;$a$;
   if position(anchor in definition)=0 then raise exception 'Audited industry claim lease boundary changed';end if;
   execute replace(definition,anchor,anchor||$a$
 -- industry-code-saved-rule-demand-v1: underlying worker has checked token,
 -- scope and lease and holds the catalog -> alert lock order.
 perform bid_active_catalog_private.request_industry_verification(outcome->>'scopeVersion',stamp);$a$);
 end if;
 if changed then
   update bid_active_catalog_private.runtime set search_generation=search_generation+1,search_changed_xid=txid_current() where singleton;
 end if;
end $$;

revoke all on function bid_active_catalog_private.industry_name_key(text),bid_active_catalog_private.industry_directory(),
 bid_active_catalog_private.explicit_industry_code(text),bid_active_catalog_private.selected_industry_code(text),
 bid_active_catalog_private.notice_industry_codes(jsonb),bid_active_catalog_private.industry_state(jsonb,jsonb),
 bid_active_catalog_private.industry_refresh_due(jsonb,timestamptz,timestamptz),
 bid_active_catalog_private.request_industry_verification(text,timestamptz),
 bid_active_catalog_private.source_version(jsonb),bid_active_catalog_private.compact(jsonb)
 from public,anon,authenticated;
commit;
