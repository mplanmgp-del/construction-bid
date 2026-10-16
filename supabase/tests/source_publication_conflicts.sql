-- Source races are a structured deferral, never an overwrite or queue acknowledgement.
begin;
update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8'));
update public.bid_menu_settings set locked=false where menu_key='notices';
create function pg_temp.conflict_notice(p_number text,p_price integer default 100,p_revision text default '000')
returns jsonb language sql as $$
 select jsonb_build_object('id','g2b:공사:'||p_number||':'||p_revision,'type','공사','number',p_number,'revision',p_revision,
 'title','철거 공사','agency','공공기관','category','철거·해체','province','서울특별시','district','강남구',
 'postedAt',now()-interval '1 day','sourceUpdatedAt',now()-interval '1 minute','biddingStartAt',now()-interval '1 hour',
 'deadline',now()+interval '30 days','openingAt',now()+interval '31 days','status','접수중','source','live',
 'allowedRegions',jsonb_build_array('서울특별시'),'licenses',jsonb_build_array('구조물해체·비계공사업'),
 'regionComplete',true,'licenseComplete',true,'estimatedPrice',p_price);
$$;
create function pg_temp.seed_publication(n jsonb,p_lease uuid,p_scope text,p_verified boolean default false)
returns void language plpgsql as $$begin
 n:=bid_active_catalog_private.compact(n);
 insert into bid_active_catalog_private.deadline_index(type,number,revision,notice,source_updated_at,deadline,opening_at,verified_at,source_version,verified_version)
 values(n->>'type',n->>'number',(n->>'revision')::integer,n,(n->>'sourceUpdatedAt')::timestamptz,
 (n->>'deadline')::timestamptz,(n->>'openingAt')::timestamptz,case when p_verified then now() end,
 bid_active_catalog_private.source_version(n),case when p_verified then bid_active_catalog_private.source_version(n) end);
 insert into bid_active_catalog_private.verification(type,number,revision,source_updated_at,scope_version,source_version,claimed_lease)
 values(n->>'type',n->>'number',(n->>'revision')::integer,(n->>'sourceUpdatedAt')::timestamptz,p_scope,bid_active_catalog_private.source_version(n),p_lease);
end $$;
do $$declare c jsonb;l uuid;s text;a jsonb;b jsonb;r jsonb;before_row jsonb;before_queue jsonb;scenario text;failed boolean;expected_version text;begin
 c:=public.bid_active_catalog_worker(repeat('a',64),'claim','{}');l:=(c->>'leaseId')::uuid;s:=c->>'scopeVersion';assert l is not null;
 foreach scenario in array array['same_clock_content','older_revision','older_source_time']loop
  a:=pg_temp.conflict_notice('R26CONFLICT'||scenario);
  b:=case scenario when 'same_clock_content' then a||'{"estimatedPrice":200}'::jsonb
   when 'older_revision' then a||jsonb_build_object('id','g2b:공사:R26CONFLICT'||scenario||':001','revision','001')
   else a||jsonb_build_object('sourceUpdatedAt',now())end;
  perform pg_temp.seed_publication(b,l,s,scenario='same_clock_content');
  select to_jsonb(d) into before_row from bid_active_catalog_private.deadline_index d where number=b->>'number';
  select to_jsonb(v) into before_queue from bid_active_catalog_private.verification v where number=b->>'number';
  begin
   r:=public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',l,'scopeVersion',s,'groups',jsonb_build_array(jsonb_build_array(a))));
  exception when raise_exception then assert false,'source conflict must return a structured retry instead of generic P0001';end;
  assert r->>'ok'='false' and r->>'retryRequired'='true' and r->>'reason'='source_changed','exact nonfatal source retry contract';
  assert r->>'conflict'=scenario and jsonb_typeof(r->'changedFields')='array','safe conflict diagnosis identifies the guard';
  assert r->'indexedHead'=before_row->'notice' and r->>'sourceVersion'=before_row->>'source_version','server-only diagnosis carries the current compact public head';
  if scenario='same_clock_content' then assert r->'changedFields'='["estimatedPrice"]'::jsonb,'only meaningful source-version keys explain same-clock mismatch';end if;
  assert (select to_jsonb(d)=before_row from bid_active_catalog_private.deadline_index d where number=b->>'number'),'no current source fields or verification badge overwritten';
  assert (select to_jsonb(v)=before_queue from bid_active_catalog_private.verification v where number=b->>'number'),'source retry never removes, acknowledges or mutates the newest queue';
  if scenario<>'same_clock_content' then
   -- The index can also advance after a queue snapshot was claimed.
   update bid_active_catalog_private.verification set revision=0,source_updated_at=(a->>'sourceUpdatedAt')::timestamptz where number=b->>'number';
   r:=public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',l,'scopeVersion',s,'groups',jsonb_build_array(jsonb_build_array(a))));
   assert r->>'retryRequired'='true' and r->>'conflict'=scenario,'a newer indexed head independently fences an older claimed snapshot';
   assert (select to_jsonb(d)=before_row from bid_active_catalog_private.deadline_index d where number=b->>'number'),'index race cannot overwrite current facts';
   update bid_active_catalog_private.verification set revision=(b->>'revision')::integer,source_updated_at=(b->>'sourceUpdatedAt')::timestamptz where number=b->>'number';
  end if;
  -- A later matching provider read can safely publish without a scope reset.
  r:=public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',l,'scopeVersion',s,'groups',jsonb_build_array(jsonb_build_array(b))));
  assert r->>'ok'='true','matching fresh source publication succeeds';
  assert exists(select 1 from bid_active_catalog_private.verification where number=b->>'number'),'successful public publication still awaits private acknowledgement';
 end loop;
 -- A conflict in a multi-group RPC rolls back earlier publication, never partially acknowledges it.
 a:=pg_temp.conflict_notice('R26BATCHGOOD');perform pg_temp.seed_publication(a,l,s);
 b:=pg_temp.conflict_notice('R26BATCHCONFLICT');perform pg_temp.seed_publication(b||'{"estimatedPrice":200}'::jsonb,l,s);
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',l,'scopeVersion',s,'groups',jsonb_build_array(jsonb_build_array(a),jsonb_build_array(b))));
 assert r->>'retryRequired'='true' and (select verified_at is null from bid_active_catalog_private.deadline_index where number='R26BATCHGOOD'),'conflict result keeps publication batch atomic';
 assert (select count(*)=2 from bid_active_catalog_private.verification where number in ('R26BATCHGOOD','R26BATCHCONFLICT')),'both queue records survive batch rollback';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',l,'scopeVersion',s,'groups',jsonb_build_array(jsonb_build_array(a))));
 assert r->>'ok'='true','unrelated valid work succeeds after a source conflict';
 assert (bid_active_catalog_private.current_coverage()->>'verificationPending')::integer>0,'retained focused work remains visibly pending';
 -- Repeated full-history validation may reconcile only its omitted-content
 -- digest, against the exact source version still owned by this queue lease.
 a:=pg_temp.conflict_notice('R26DIGESTCAS')||jsonb_build_object('sourceOmittedDigest',repeat('a',64));
 b:=a||jsonb_build_object('sourceOmittedDigest',repeat('b',64));
 perform pg_temp.seed_publication(b,l,s,true);
 expected_version:=bid_active_catalog_private.source_version(bid_active_catalog_private.compact(b));
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',l,'scopeVersion',s,'groups',jsonb_build_array(jsonb_build_array(a))));
 assert r->>'retryRequired'='true' and r->'changedFields'='["sourceOmittedDigest"]'::jsonb,'ordinary digest mismatch still defers';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',l,'scopeVersion',s,'expectedSourceVersion',repeat('f',64),'groups',jsonb_build_array(jsonb_build_array(a))));
 assert r->>'retryRequired'='true','a stale expected source version cannot reconcile';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',l,'scopeVersion',s,'expectedSourceVersion',expected_version,'groups',jsonb_build_array(jsonb_build_array(a||'{"estimatedPrice":300}'::jsonb))));
 assert r->>'retryRequired'='true','digest reconciliation cannot change another source fact';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',l,'scopeVersion',s,'expectedSourceVersion',expected_version,'groups',jsonb_build_array(jsonb_build_array(a||'{"revision":"001","id":"g2b:공사:R26DIGESTCAS:001"}'::jsonb))));
 assert r->>'retryRequired'='true','an explicit digest CAS cannot change the official revision';
 update bid_active_catalog_private.verification set source_version=repeat('f',64) where number='R26DIGESTCAS';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',l,'scopeVersion',s,'expectedSourceVersion',expected_version,'groups',jsonb_build_array(jsonb_build_array(a))));
 assert r->>'retryRequired'='true','the lease-owned queue must still carry the same expected source version';
 update bid_active_catalog_private.verification set source_version=expected_version where number='R26DIGESTCAS';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',l,'scopeVersion',s,'expectedSourceVersion',expected_version,'groups',jsonb_build_array(jsonb_build_array(a))));
 assert r->>'ok'='true','exact lease-owned compare-and-swap accepts only authoritative omitted-content reconciliation';
 assert (select notice->>'sourceOmittedDigest'=repeat('a',64) and source_version=verified_version and verified_at is not null from bid_active_catalog_private.deadline_index where number='R26DIGESTCAS'),'reconciled source gets only its matching verified badge';
 assert exists(select 1 from bid_active_catalog_private.verification where number='R26DIGESTCAS' and claimed_lease=l),'reconciliation never acknowledges the private queue';
 -- Reusing the old CAS after any newer source update cannot overwrite it.
 update bid_active_catalog_private.deadline_index set notice=notice||'{"estimatedPrice":400}'::jsonb where number='R26DIGESTCAS';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',l,'scopeVersion',s,'expectedSourceVersion',expected_version,'groups',jsonb_build_array(jsonb_build_array(a))));
 assert r->>'retryRequired'='true' and (select notice->>'estimatedPrice'='400' and verified_at is null from bid_active_catalog_private.deadline_index where number='R26DIGESTCAS'),'concurrent current source wins over an old reconciliation';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',l,'scopeVersion',s,'groups',jsonb_build_array(jsonb_build_array(a||'{"estimatedPrice":400}'::jsonb))));
 assert r->>'ok'='true','a fresh normal publication accepts the current source after the CAS race';
 perform public.bid_active_catalog_worker(repeat('a',64),'commit',jsonb_build_object('leaseId',l,'scopeVersion',s,'rejectedGroups',jsonb_build_array(jsonb_build_object('type','공사','number','R26DIGESTCAS'))));
 assert not exists(select 1 from bid_active_catalog_private.verification where number='R26DIGESTCAS') and (select notice->>'estimatedPrice'='400' from bid_active_catalog_private.deadline_index where number='R26DIGESTCAS'),'ordinary acknowledgement follows successful publication without dropping current facts';
 -- Unknown validation failures and authentication/lease failures remain failures.
 a:=pg_temp.conflict_notice('R26BATCHGOOD');
 failed:=false;begin
  perform public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',l,'scopeVersion',s,'groups',jsonb_build_array(jsonb_build_array(a,a))));
 exception when raise_exception then failed:=true;end;assert failed,'unknown P0001 validation error is not converted to a retry';
 failed:=false;begin perform public.bid_active_catalog_worker('wrong','search_publish','{}');
 exception when insufficient_privilege then failed:=true;end;assert failed,'auth gate unchanged';
 failed:=false;begin perform public.bid_active_catalog_worker(repeat('a',64),'search_publish',jsonb_build_object('leaseId',gen_random_uuid(),'scopeVersion',s,'groups',jsonb_build_array(jsonb_build_array(a))));
 exception when insufficient_privilege then failed:=true;end;assert failed,'lease gate unchanged';
 assert (select storage_ceiling=25165824 from bid_active_catalog_private.runtime) and (select storage_ceiling=33554432 from bid_alert_private.runtime),'storage guards retain existing allocations';
 assert not has_function_privilege('anon','bid_active_catalog_private.worker_before_current(text,text,jsonb)','execute'),'private worker cannot bypass token wrapper';
end $$;
rollback;
