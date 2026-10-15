-- Disposable regression: useful current phases precede old submission dates.
begin;
update bid_alert_private.runtime set configured=true,token_hash=sha256(convert_to(repeat('a',64),'UTF8'));
delete from bid_active_catalog_private.deadline_index;
delete from bid_active_catalog_private.verification;

create function pg_temp.priority_notice(p_number text,p_close interval,p_start interval,p_open interval,p_posted text,p_price integer)
returns jsonb language sql as $$
 select jsonb_build_object('id','g2b:공사:'||p_number||':000','type','공사','number',p_number,'revision','000',
 'title','철거 공사 '||p_number,'agency','공공 기관','category','철거·해체','province','서울특별시','district','강남구',
 'postedAt',p_posted,'sourceUpdatedAt',now()-interval '1 minute','biddingStartAt',now()+p_start,
 'deadline',now()+p_close,'openingAt',now()+p_open,'status','접수중','source','live',
 'licenses','[]'::jsonb,'allowedRegions',jsonb_build_array('전국'),'regionComplete',true,'licenseComplete',true,
 'contractMethod','일반경쟁','estimatedPrice',p_price);
$$;
create function pg_temp.priority_seed(n jsonb) returns void language sql as $$
 insert into bid_active_catalog_private.deadline_index(type,number,revision,notice,source_updated_at,deadline,opening_at,verified_at,source_version,verified_version)
 select n->>'type',n->>'number',0,bid_active_catalog_private.compact(n),(n->>'sourceUpdatedAt')::timestamptz,
 (n->>'deadline')::timestamptz,(n->>'openingAt')::timestamptz,now(),
 bid_active_catalog_private.source_version(bid_active_catalog_private.compact(n)),bid_active_catalog_private.source_version(bid_active_catalog_private.compact(n));
$$;
create function pg_temp.priority_query(p_more jsonb default '{}'::jsonb) returns jsonb language sql as $$
 select '{"type":"공사","from":"1995-10-01","to":"2100-12-31","keyword":"","limit":1,"filters":{"keyword":""}}'::jsonb||p_more;
$$;

do $$declare r jsonb;q jsonb;seen text[]:='{}';expected text[]:=array['R26URGENT1','R26URGENT2','R26ACTIVE1','R26ACTIVE2','R26WAITING1','R26WAITING2','R26SCHEDULE1','R26SCHEDULE2'];
 n text;cursor_value text;body jsonb;secret bytea;failed boolean:=false;begin
 -- Intentionally shuffled insert order; very old posted dates stay searchable.
 perform pg_temp.priority_seed(pg_temp.priority_notice('R26WAITING2','-1 hour','-4 days','4 hours','2026-10-07T09:00:00+09:00',7));
 perform pg_temp.priority_seed(pg_temp.priority_notice('R26SCHEDULE1','6 hours','1 hour','7 hours','2026-10-15T09:00:00+09:00',8));
 perform pg_temp.priority_seed(pg_temp.priority_notice('R26ACTIVE2','5 days','-1 day','6 days','2026-10-02T09:00:00+09:00',2));
 perform pg_temp.priority_seed(pg_temp.priority_notice('R26URGENT2','20 hours','-1 day','21 hours','1995-10-01T09:00:00+09:00',4));
 perform pg_temp.priority_seed(pg_temp.priority_notice('R26SCHEDULE2','2 days','1 day','3 days','2026-10-14T09:00:00+09:00',6));
 perform pg_temp.priority_seed(pg_temp.priority_notice('R26WAITING1','-2 hours','-4 days','3 hours','2026-10-08T09:00:00+09:00',5));
 perform pg_temp.priority_seed(pg_temp.priority_notice('R26URGENT1','10 hours','-1 day','11 hours','2001-01-01T09:00:00+09:00',3));
 perform pg_temp.priority_seed(pg_temp.priority_notice('R26ACTIVE1','4 days','-1 day','5 days','2026-10-01T09:00:00+09:00',1));
 q:=pg_temp.priority_query();
 foreach n in array expected loop
   r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',q);
   assert r->>'totalCount'='8','wide search keeps every current notice independent of posting age';
   assert r#>>'{items,0,number}'=n,format('phase-first global page expected %s, received %s',n,r#>>'{items,0,number}');
   assert not (r#>>'{items,0,number}'=any(seen)),'phase boundary pagination never repeats a notice';
   seen:=array_append(seen,r#>>'{items,0,number}');
   if n<>expected[8] then
     assert r->>'hasMore'='true' and r->>'nextCursor' is not null,'every phase can continue using the signed cursor';
     q:=q||jsonb_build_object('cursor',r->>'nextCursor');
   else assert r->>'hasMore'='false','last scheduled notice closes the page';end if;
 end loop;
 assert seen=expected,'urgent, actionable active, opening wait, scheduled are globally ordered';
 -- Explicit user sorts must not inherit the phase preference.
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.priority_query('{"limit":50,"filters":{"sort":"newest"}}'));
 assert r#>>'{items,0,number}'='R26SCHEDULE1' and r#>>'{items,7,number}'='R26URGENT2','explicit newest order stays based on posted time';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.priority_query('{"limit":50,"filters":{"sort":"amountAsc"}}'));
 assert r#>>'{items,0,number}'='R26ACTIVE1' and r#>>'{items,7,number}'='R26SCHEDULE1','explicit amount ascending remains global';
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.priority_query('{"limit":50,"filters":{"sort":"amountDesc"}}'));
 assert r#>>'{items,0,number}'='R26SCHEDULE1' and r#>>'{items,7,number}'='R26ACTIVE1','explicit amount descending remains global';
 -- Even a correctly signed impossible rank cannot bypass mode validation.
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.priority_query());
 cursor_value:=r->>'nextCursor';body:=convert_from(decode(translate(cursor_value,'-_','+/'),'base64'),'UTF8')::jsonb-'sig';
 select token_hash into secret from bid_alert_private.runtime where singleton;
 body:=jsonb_set(body,'{k,nr}','5'::jsonb);body:=body||jsonb_build_object('sig',encode(sha256(secret||convert_to(body::text,'UTF8')),'hex'));
 begin perform public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.priority_query(jsonb_build_object('cursor',replace(encode(convert_to(body::text,'UTF8'),'base64'),E'\n',''))));
 exception when raise_exception then failed:=sqlerrm='SEARCH_CHANGED';end;
 assert failed,'deadline cursor rejects a rank outside the supported phases';
end $$;

do $$declare r jsonb;q jsonb;seen text[]:='{}';entry text;cursor_value text;body jsonb;invalid jsonb;signed_body jsonb;secret bytea;failed boolean;begin
 delete from bid_active_catalog_private.deadline_index;
 delete from bid_active_catalog_private.verification;
 -- Identical deadlines deliberately oppose the business/number fallback.
 perform pg_temp.priority_seed(pg_temp.priority_notice('R26TIEZ','3 days','-1 day','4 days','1995-10-01T09:00:00+09:00',1));
 perform pg_temp.priority_seed(pg_temp.priority_notice('R26TIEA','3 days','-1 day','4 days','2026-10-14T09:00:00+09:00',1)||'{"type":"용역","id":"g2b:용역:R26TIEA:000"}'::jsonb);
 perform pg_temp.priority_seed(pg_temp.priority_notice('R26TIEB','3 days','-1 day','4 days','2026-10-15T09:00:00+09:00',1));
 perform pg_temp.priority_seed(pg_temp.priority_notice('R26TIEB','3 days','-1 day','4 days','2026-10-15T09:00:00+09:00',1)||'{"type":"용역","id":"g2b:용역:R26TIEB:000"}'::jsonb);
 perform pg_temp.priority_seed(pg_temp.priority_notice('R26TIENULL','3 days','-1 day','4 days','',1));
 q:=pg_temp.priority_query('{"type":"공사·용역"}');
 foreach entry in array array['공사:R26TIEB','용역:R26TIEB','용역:R26TIEA','공사:R26TIEZ','공사:R26TIENULL'] loop
   r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',q);
   assert r#>>'{items,0,type}'||':'||(r#>>'{items,0,number}')=entry,format('equal deadlines prefer latest posting before identity: expected %s, received %s:%s',entry,r#>>'{items,0,type}',r#>>'{items,0,number}');
   seen:=array_append(seen,r#>>'{items,0,type}'||':'||(r#>>'{items,0,number}'));
   q:=q||jsonb_build_object('cursor',r->>'nextCursor');
 end loop;
 assert cardinality(seen)=5 and r->>'hasMore'='false','posting tie pages reach every business identity once';
 -- Signed cursor validation must reject nonfinite and missing tie values.
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.priority_query('{"type":"공사·용역"}'));
 cursor_value:=r->>'nextCursor';body:=convert_from(decode(translate(cursor_value,'-_','+/'),'base64'),'UTF8')::jsonb-'sig';
 select token_hash into secret from bid_alert_private.runtime where singleton;
 for invalid in select value from jsonb_array_elements('["NaN","Infinity","-Infinity",null]'::jsonb) loop
   signed_body:=jsonb_set(body,'{k,ps}',invalid);signed_body:=signed_body||jsonb_build_object('sig',encode(sha256(secret||convert_to(signed_body::text,'UTF8')),'hex'));
   failed:=false;
   begin perform public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.priority_query(jsonb_build_object('type','공사·용역','cursor',replace(encode(convert_to(signed_body::text,'UTF8'),'base64'),E'\n',''))));
   exception when raise_exception then failed:=sqlerrm='SEARCH_CHANGED';end;
   assert failed,'nonfinite or missing signed posting keys are rejected';
 end loop;
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.priority_query('{"type":"공사·용역","filters":{"sort":"newest"}}'));
 body:=convert_from(decode(translate(r->>'nextCursor','-_','+/'),'base64'),'UTF8')::jsonb-'sig';
 body:=jsonb_set(body,'{k,nr}','3'::jsonb);body:=body||jsonb_build_object('sig',encode(sha256(secret||convert_to(body::text,'UTF8')),'hex'));
 failed:=false;
 begin perform public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.priority_query(jsonb_build_object('type','공사·용역','filters','{"sort":"newest"}'::jsonb,'cursor',replace(encode(convert_to(body::text,'UTF8'),'base64'),E'\n',''))));
 exception when raise_exception then failed:=sqlerrm='SEARCH_CHANGED';end;
 assert failed,'non-deadline sort still rejects phase ranks';
end $$;

do $$declare r jsonb;s jsonb;n jsonb;begin
 delete from bid_active_catalog_private.deadline_index;
 delete from bid_active_catalog_private.verification;
 perform pg_temp.priority_seed(pg_temp.priority_notice('R26BOUNDARYURGENT','2 hours','-1 day','3 hours','1995-10-01T09:00:00+09:00',1));
 n:=pg_temp.priority_notice('R26BOUNDARYSTART','1 day','15 seconds','2 days','2026-10-15T09:00:00+09:00',1);
 perform pg_temp.priority_seed(n);
 r:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.priority_query());
 assert r#>>'{items,0,number}'='R26BOUNDARYURGENT','near-start scheduled notice stays behind urgent notice';
 assert (r->>'validUntil')::timestamptz=(n->>'biddingStartAt')::timestamptz,'priority pages expire when the earliest phase can change';
 s:=public.bid_active_catalog_worker(repeat('a',64),'search_page',pg_temp.priority_query(jsonb_build_object('cursor',r->>'nextCursor')));
 assert s->>'asOf'=r->>'asOf' and s->>'validUntil'=r->>'validUntil' and s#>>'{items,0,number}'='R26BOUNDARYSTART','posting tie pages keep the same phase snapshot and expiry';
end $$;
rollback;
