-- Keep provider keywords within the existing 4 KiB compact-record allowance.
-- PostgreSQL text positions count Unicode characters, matching Array.from in JS.
begin;
create or replace function bid_active_catalog_private.compact(p_notice jsonb)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare result jsonb;projection text;lower_bound integer:=0;upper_bound integer;midpoint integer;
begin
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into result from jsonb_each(p_notice)
 where key=any(array['id','number','revision','title','agency','demandAgency','type','category','province','district',
 'allowedRegions','estimatedPrice','plannedAmount','contractMethod','status','postedAt','deadline','openingAt',
 'registrationDeadline','biddingStartAt','licenses','specialRegionCondition','revised','source','sourceUpdatedAt',
 'regionComplete','licenseComplete','noticeKind','detailUrl','sourceOmittedDigest','openingCompleted',
 'regionSearchText','regionSearchDigest','procurementSource','bidMethod']);
 result:=result||'{"description":"","duration":"","requirements":[],"documents":[]}'::jsonb;
 if jsonb_typeof(result->'regionSearchDigest') is distinct from 'string'
   or coalesce(result->>'regionSearchDigest','')!~'^[a-f0-9]{64}$' then result:=result-'regionSearchDigest';end if;
 -- region-name-keyword-compact-v2: count the final JSONB representation,
 -- including escaped quotes/newlines and the fixed omitted-field placeholders.
 if jsonb_typeof(result->'regionSearchText') is distinct from 'string' then return result-'regionSearchText';end if;
 projection:=left(result->>'regionSearchText',3000);
 result:=jsonb_set(result,'{regionSearchText}',to_jsonb(projection));
 if octet_length(result::text)<=4096 then return result;end if;
 result:=jsonb_set(result,'{regionSearchText}','""'::jsonb);
 if octet_length(result::text)>4096 then return result-'regionSearchText';end if;
 upper_bound:=length(projection);
 while lower_bound<upper_bound loop
   midpoint:=(lower_bound+upper_bound+1)/2;
   if octet_length(jsonb_set(result,'{regionSearchText}',to_jsonb(left(projection,midpoint)))::text)<=4096 then
     lower_bound:=midpoint;
   else upper_bound:=midpoint-1;end if;
 end loop;
 return jsonb_set(result,'{regionSearchText}',to_jsonb(left(projection,lower_bound)));
end $$;
revoke all on function bid_active_catalog_private.compact(jsonb) from public,anon,authenticated;

-- The visible prefix gets shorter when participant facts take more space.
-- Compare the stable provider-text digest instead, so enrichment alone cannot
-- look like a same-clock source edit or continually invalidate verification.
create or replace function bid_active_catalog_private.source_version(p_notice jsonb)
returns text language sql immutable security invoker set search_path='' as $$
 select encode(sha256(convert_to((p_notice-array['allowedRegions','licenses','regionComplete','licenseComplete',
 'openingCompleted','status','description','documents','requirements','duration','regionSearchText'])::text,'UTF8')),'hex');
$$;
revoke all on function bid_active_catalog_private.source_version(jsonb) from public,anon,authenticated;

-- Cached participant conditions can consume more bytes than the raw listing.
-- Recompact after each database-side merge as well as after provider merges.
do $$declare definition text;anchor text;begin
 select replace(pg_get_functiondef('bid_active_catalog_private.worker_deadline(text,text,jsonb)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('region-keyword-after-cache-merge-v1' in definition)=0 then
   anchor:=$a$if not bid_active_catalog_private.ongoing(n,stamp) then continue; end if;$a$;
   if position(anchor in definition)=0 then raise exception 'Audited cached condition merge boundary changed';end if;
   execute replace(definition,anchor,$a$-- region-keyword-after-cache-merge-v1
       n:=bid_active_catalog_private.compact(n);
       $a$||anchor);
 end if;
 select replace(pg_get_functiondef('bid_active_catalog_private.worker_legacy(text,text,jsonb)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('region-keyword-after-enrichment-v1' in definition)=0 then
   anchor:=$a$if octet_length(enriched::text)>4096 then raise exception 'Condition enrichment exceeded compact budget'; end if;$a$;
   if position(anchor in definition)=0 then raise exception 'Audited condition enrichment budget guard changed';end if;
   execute replace(definition,anchor,$a$-- region-keyword-after-enrichment-v1
       enriched:=bid_active_catalog_private.compact(enriched);
       $a$||anchor);
 end if;

 -- A first digest can be adopted only for a claimed, unchanged indexed head.
 -- A pre-existing digest, different source fact or failed explicit CAS retains
 -- the existing structured conflict; no source race is silently accepted.
 select replace(pg_get_functiondef('bid_active_catalog_private.worker_before_current(text,text,jsonb)'::regprocedure),E'\r\n',E'\n') into definition;
 if position('region-keyword-first-digest-adoption-v1' in definition)=0 then
   anchor:=$a$if (p_payload?'expectedSourceVersion' or indexed.type is not null and$a$;
   if position(anchor in definition)=0 then raise exception 'Audited source conflict CAS boundary changed';end if;
   execute replace(definition,anchor,$a$-- region-keyword-first-digest-adoption-v1
       cas_allowed:=cas_allowed or (
         indexed.type is not null and not(indexed.notice?'regionSearchDigest')
         and coalesce(head->>'regionSearchDigest','')~'^[0-9a-f]{64}$'
         and revision_value=indexed.revision and source_time=indexed.source_updated_at
         and candidate.source_version=indexed.source_version
         and (not(p_payload?'expectedSourceVersion') or p_payload->>'expectedSourceVersion'=indexed.source_version)
         and bid_active_catalog_private.source_version(head-'regionSearchDigest')=
           bid_active_catalog_private.source_version(indexed.notice)
       ) is true;
       $a$||anchor);
 end if;
 select replace(pg_get_functiondef('bid_active_catalog_private.publication_conflict(jsonb,jsonb,text,integer,timestamptz)'::regprocedure),E'\r\n',E'\n') into definition;
 anchor:=$a$'description','documents','requirements','duration'])$a$;
 if position(anchor in definition)>0 then
   execute replace(definition,anchor,$a$'description','documents','requirements','duration','regionSearchText'])$a$);
 end if;
end $$;

-- Queue expectations and index hashes move together only for the same current
-- source head. A newer pending revision retains its original verification task.
update bid_active_catalog_private.verification v set source_version=bid_active_catalog_private.source_version(d.notice)
from bid_active_catalog_private.deadline_index d
where v.type=d.type and v.number=d.number and v.revision=d.revision
 and v.source_updated_at is not distinct from d.source_updated_at and v.source_version=d.source_version;

-- A smaller representation does not mean that the source notice changed.
-- Rebase a previously consistent verification hash atomically with its body;
-- the existing trigger still rejects incomplete or inconsistent verification.
with reduced as materialized (
 select type,number,notice,bid_active_catalog_private.compact(notice) compacted
 from bid_active_catalog_private.deadline_index
), changed as (
 select type,number,case when compacted?'regionSearchText'
   then jsonb_set(notice,'{regionSearchText}',compacted->'regionSearchText') else notice-'regionSearchText' end notice
 from reduced
)
update bid_active_catalog_private.deadline_index d set notice=c.notice,
 verified_version=case when d.verified_at is not null and d.source_version=d.verified_version
   then bid_active_catalog_private.source_version(c.notice) else null end
from changed c where d.type=c.type and d.number=c.number
 and (d.notice is distinct from c.notice or d.source_version is distinct from bid_active_catalog_private.source_version(c.notice));

-- Retained personal-history groups use the same compact projection. Only this
-- optional search field changes; their original facts and verification remain.
update bid_active_catalog_private.groups g set
 latest=case when latest?'regionSearchText' then
   case when bid_active_catalog_private.compact(latest)?'regionSearchText'
     then jsonb_set(latest,'{regionSearchText}',bid_active_catalog_private.compact(latest)->'regionSearchText')
     else latest-'regionSearchText' end else latest end,
 versions=(select coalesce(jsonb_agg(case when v?'regionSearchText' then
   case when bid_active_catalog_private.compact(v)?'regionSearchText'
     then jsonb_set(v,'{regionSearchText}',bid_active_catalog_private.compact(v)->'regionSearchText')
     else v-'regionSearchText' end else v end order by ordinal),'[]'::jsonb)
   from jsonb_array_elements(g.versions) with ordinality rows(v,ordinal))
where latest?'regionSearchText' or exists(select 1 from jsonb_array_elements(versions) v where v?'regionSearchText');
commit;
