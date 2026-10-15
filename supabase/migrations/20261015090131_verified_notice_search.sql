-- Verified, globally filtered search within the EXISTING 16/32 MiB budgets.
-- No snapshot copies, raw-body retention, role grants, cron or budget changes.
begin;
alter table bid_active_catalog_private.runtime add column if not exists search_generation bigint not null default 0;
alter table bid_active_catalog_private.runtime add column if not exists search_changed_xid bigint;
alter table bid_active_catalog_private.runtime add column if not exists storage_blocked boolean not null default false;
alter table bid_active_catalog_private.deadline_index add column if not exists source_version text;
alter table bid_active_catalog_private.deadline_index add column if not exists verified_version text;

create or replace function bid_active_catalog_private.source_version(p_notice jsonb)
returns text language sql immutable security invoker set search_path='' as $$
 select encode(sha256(convert_to((p_notice-array['allowedRegions','licenses','regionComplete','licenseComplete',
 'openingCompleted','status','description','documents','requirements','duration'])::text,'UTF8')),'hex');
$$;
update bid_active_catalog_private.deadline_index set source_version=bid_active_catalog_private.source_version(notice),
 verified_version=case when verified_at is not null then bid_active_catalog_private.source_version(notice) end
where source_version is null;
update bid_active_catalog_private.deadline_index set verified_at=null,verified_version=null
 where (notice->>'regionComplete' is distinct from 'true' or notice->>'licenseComplete' is distinct from 'true')
   and (verified_at is not null or verified_version is not null);
create index if not exists bid_verified_deadline_range on bid_active_catalog_private.deadline_index(deadline,type,number)
 where verified_at is not null and source_version=verified_version;

create or replace function bid_active_catalog_private.search_index_version()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 new.source_version:=bid_active_catalog_private.source_version(new.notice);
 if new.verified_version is distinct from new.source_version or new.notice->>'regionComplete' is distinct from 'true'
   or new.notice->>'licenseComplete' is distinct from 'true' then new.verified_at:=null;new.verified_version:=null;
 elsif tg_op='UPDATE' and old.source_version=new.source_version and old.verified_version=new.verified_version
   and new.verified_at is null then new.verified_at:=old.verified_at;end if;
 if tg_op='UPDATE' and old.source_version is distinct from new.source_version and new.verified_version is null then
   new.notice:=new.notice||'{"regionComplete":false,"licenseComplete":false}'::jsonb;
 end if;
 return new;
end $$;

-- STABLE gives every count, row and generation read in this call the same
-- PostgreSQL MVCC snapshot. Later pages must present the same generation.
create or replace function bid_active_catalog_private.search_page(p_payload jsonb)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare cfg bid_active_catalog_private.runtime%rowtype;f jsonb;profile jsonb;query_hash text;cursor_data jsonb;cursor_body jsonb;
 key_secret bytea;cursor_value text:=coalesce(p_payload->>'cursor','');signature text;generation text;
 as_of timestamptz:=statement_timestamp();first_day date;last_day date;business text;sort_name text;page_limit integer;page_number integer:=1;
 last_null integer;last_value numeric;last_type text;last_number text;result_items jsonb;last_key jsonb;next_cursor text;
 total_count bigint;verified_count bigint;pending_count bigint;condition_count bigint;more boolean;coverage jsonb;synced timestamptz;storage_size bigint;
 field text;bound text;title_keyword text;valid_until timestamptz;boundary_time timestamptz;simple_filters boolean;
begin
 if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>20000 then raise exception using errcode='22023',message='검색 요청 형식을 확인해 주세요.';end if;
 select * into strict cfg from bid_active_catalog_private.runtime where singleton;
 select token_hash into key_secret from bid_alert_private.runtime where singleton;
 business:=coalesce(p_payload->>'type','공사·용역');page_limit:=coalesce((p_payload->>'limit')::integer,50);
 if business not in ('공사','용역','공사·용역') or page_limit not between 1 and 50
 or coalesce(p_payload->>'from','')!~'^\d{4}-\d{2}-\d{2}$' or coalesce(p_payload->>'to','')!~'^\d{4}-\d{2}-\d{2}$'
 then raise exception using errcode='22023',message='검색 기간과 업무 구분을 확인해 주세요.';end if;
 first_day:=(p_payload->>'from')::date;last_day:=(p_payload->>'to')::date;
 if first_day<'1995-10-01'::date or last_day>'2100-12-31'::date or first_day>last_day then raise exception using errcode='22023',message='검색 기간을 확인해 주세요.';end if;
 if p_payload?'filters' and jsonb_typeof(p_payload->'filters') is distinct from 'object' then raise exception 'Invalid search filters';end if;
 f:='{"keyword":"","excludeKeyword":"","category":"전체","type":"전체","siteProvince":"전체","license":"전체","minAmount":"","maxAmount":"","status":"전체","contractMethod":"전체","deadlineFrom":"","deadlineTo":"","regionView":"all","autoRegion":false,"sort":"deadline"}'::jsonb||coalesce(p_payload->'filters','{}'::jsonb);
 if not (p_payload->'filters'?'keyword') then f:=f||jsonb_build_object('keyword',coalesce(p_payload->>'keyword',''));end if;
 profile:=coalesce(p_payload->'profile','{}'::jsonb);
 if jsonb_typeof(profile) is distinct from 'object' then raise exception 'Invalid company region';end if;
 profile:=jsonb_build_object('province',coalesce(profile->>'province',''),'district',coalesce(profile->>'district',''));
 if f->>'sort' not in ('deadline','newest','amountAsc','amountDesc') or f->>'type' not in ('전체','공사','용역')
 or f->>'regionView' not in ('all','matched','excluded','review') or jsonb_typeof(f->'autoRegion') is distinct from 'boolean'
 or length(f->>'keyword')>100 or length(f->>'excludeKeyword')>1000 or length(profile->>'province')>100 or length(profile->>'district')>100
 then raise exception using errcode='22023',message='검색 조건을 확인해 주세요.';end if;
 foreach field in array array['regions','statuses'] loop
   if f?field and (jsonb_typeof(f->field) is distinct from 'array' or jsonb_array_length(f->field)>100) then raise exception 'Invalid filter array';end if;
 end loop;
 foreach field in array array['minAmount','maxAmount'] loop
   bound:=coalesce(f->>field,'');
   if bound<>'' and (bound!~'^([0-9]+|[0-9]{1,3}(,[0-9]{3})+)$' or replace(bound,',','')::numeric>9007199254740991) then
   raise exception using errcode='22023',message='검색 금액을 확인해 주세요.';end if;
 end loop;
 if nullif(replace(f->>'minAmount',',',''),'')::numeric>nullif(replace(f->>'maxAmount',',',''),'')::numeric then raise exception 'Invalid amount range';end if;
 title_keyword:=lower(bid_active_catalog_private.clean_search_text(p_payload->>'keyword'));
 if length(title_keyword)>120 then raise exception 'Invalid title keyword';end if;
 sort_name:=f->>'sort';generation:=cfg.search_generation::text;valid_until:=as_of+interval '10 minutes';
 simple_filters:=coalesce(f->>'keyword','')='' and coalesce(f->>'excludeKeyword','')='' and f->>'category'='전체' and f->>'type'='전체'
   and f->>'siteProvince'='전체' and f->>'license'='전체' and f->>'minAmount'='' and f->>'maxAmount'=''
   and f->>'status'='전체' and f->>'contractMethod'='전체' and f->>'deadlineFrom'='' and f->>'deadlineTo'=''
   and f->>'regionView'='all' and f->>'autoRegion'='false'
   and (not(f?'regions') or jsonb_array_length(f->'regions')=0) and (not(f?'statuses') or jsonb_array_length(f->'statuses')=0);
 query_hash:=encode(sha256(convert_to(jsonb_build_object('type',business,'from',first_day,'to',last_day,'keyword',title_keyword,'filters',f,'profile',profile,'limit',page_limit)::text,'UTF8')),'hex');
 if cursor_value<>'' then
   begin cursor_data:=convert_from(decode(translate(cursor_value,'-_','+/'),'base64'),'UTF8')::jsonb;
   exception when others then raise exception using errcode='22023',message='검색 이어보기 정보를 확인해 주세요.';end;
   cursor_body:=cursor_data-'sig';
   signature:=encode(sha256(key_secret||convert_to(cursor_body::text,'UTF8')),'hex');
   if length(cursor_value)>4096 or cursor_data->>'v'<>'1' or cursor_data->>'sig' is distinct from signature then raise exception using errcode='22023',message='검색 이어보기 정보를 확인해 주세요.';end if;
   if cursor_data->>'g' is distinct from generation or cursor_data->>'q' is distinct from query_hash then
   raise exception using errcode='P0001',message='SEARCH_CHANGED',detail='공고나 검색 조건이 바뀌었습니다. 처음부터 다시 조회해 주세요.';end if;
   begin
     as_of:=(cursor_data->>'a')::timestamptz;valid_until:=(cursor_data->>'u')::timestamptz;page_number:=(cursor_data->>'p')::integer+1;
     last_null:=(cursor_data#>>'{k,nr}')::integer;last_value:=(cursor_data#>>'{k,s}')::numeric;
     last_type:=cursor_data#>>'{k,t}';last_number:=cursor_data#>>'{k,n}';
   exception when others then raise exception using errcode='22023',message='검색 이어보기 정보를 확인해 주세요.';end;
   if as_of is null or valid_until is null or valid_until<=statement_timestamp() or valid_until>as_of+interval '10 minutes'
   or as_of>statement_timestamp()+interval '5 seconds' or as_of<statement_timestamp()-interval '10 minutes'
   or last_null not in (0,1) or last_value is null or last_type not in ('공사','용역') or coalesce(last_number,'')!~'^[A-Za-z0-9_-]{1,40}$' then
   raise exception using errcode='P0001',message='SEARCH_CHANGED',detail='검색 확인 시간이 지났습니다. 처음부터 다시 조회해 주세요.';end if;
 end if;
 with ranged as materialized (
   select d.*,d.verified_at is not null and d.source_version=d.verified_version verified,
     case when simple_filters then 'match' else bid_active_catalog_private.search_match(d.notice,f,profile,as_of) end classification,
     case when sort_name in ('amountAsc','amountDesc') and jsonb_typeof(d.notice->'estimatedPrice') is distinct from 'number' then 1
       when sort_name='newest' and bid_active_catalog_private.safe_time(d.notice->>'postedAt') is null then 1 else 0 end null_rank,
     coalesce(case sort_name when 'amountAsc' then (d.notice->>'estimatedPrice')::numeric when 'amountDesc' then -(d.notice->>'estimatedPrice')::numeric
       when 'newest' then -extract(epoch from bid_active_catalog_private.safe_time(d.notice->>'postedAt'))*1000
       else extract(epoch from d.deadline)*1000 end,0) sort_value
   from bid_active_catalog_private.deadline_index d
   where (business='공사·용역' or d.type=business)
     and (title_keyword='' or strpos(lower(bid_active_catalog_private.clean_search_text(d.notice->>'title')),title_keyword)>0)
     and d.deadline>=(first_day::timestamp at time zone 'Asia/Seoul') and d.deadline<((last_day+1)::timestamp at time zone 'Asia/Seoul')
     and isfinite(d.deadline) and (d.deadline>as_of or d.opening_at>as_of)
     and (d.opening_at is null or isfinite(d.opening_at) and d.opening_at>as_of)
     and d.notice->>'status' is distinct from '취소' and coalesce(d.notice->>'noticeKind','') not like '%취소%'
     and d.notice->>'openingCompleted' is distinct from 'true'
     and not exists(select 1 from bid_active_catalog_private.deadline_invalidations h where h.type=d.type and h.number=d.number
       and (h.revision>d.revision or h.revision=d.revision and h.source_updated_at>=d.source_updated_at))
     and not exists(select 1 from bid_active_catalog_private.groups g where g.type=d.type and g.number=d.number
       and (g.revision>d.revision or g.revision=d.revision and g.source_updated_at>=d.source_updated_at)
       and not bid_active_catalog_private.ongoing(g.latest,as_of))
 ),counts as (
   select count(*) filter(where verified and classification in ('match','match_unknown')) total,
     count(*) filter(where verified and classification<>'excluded') verified_total,
     count(*) filter(where not verified and classification<>'excluded') pending_total,
     count(*) filter(where classification in ('pending','match_unknown')) conditions_total from ranged
 ),page_rows as materialized (
   select * from ranged where verified and classification in ('match','match_unknown')
     and (cursor_value='' or (null_rank,sort_value,type,number)>(last_null,last_value,last_type,last_number))
   order by null_rank,sort_value,type,number limit page_limit+1
 ),numbered as (
   select *,row_number() over(order by null_rank,sort_value,type,number) ordinal from page_rows
 ) select counts.total,counts.verified_total,counts.pending_total,counts.conditions_total,
   (select coalesce(jsonb_agg(p.notice||jsonb_build_object('sourceVersion',p.source_version,'verifiedVersion',p.verified_version,'verifiedAt',p.verified_at)
     order by p.null_rank,p.sort_value,p.type,p.number),'[]'::jsonb) from numbered p where ordinal<=page_limit),
   (select count(*)>page_limit from numbered),
   (select jsonb_build_object('nr',null_rank,'s',sort_value,'t',type,'n',number) from numbered where ordinal=page_limit)
 into total_count,verified_count,pending_count,condition_count,result_items,more,last_key from counts;
 if cursor_value='' then
     select min(t.boundary) into boundary_time from bid_active_catalog_private.deadline_index d
       cross join lateral (values(d.deadline),(d.deadline-interval '24 hours'),(d.opening_at),
         (bid_active_catalog_private.safe_time(d.notice->>'biddingStartAt'))) t(boundary)
       where (business='공사·용역' or d.type=business) and d.deadline>=(first_day::timestamp at time zone 'Asia/Seoul')
         and d.deadline<((last_day+1)::timestamp at time zone 'Asia/Seoul') and t.boundary>as_of;
     valid_until:=least(valid_until,coalesce(boundary_time,valid_until));
 end if;
 if more then
   cursor_body:=jsonb_build_object('v',1,'g',generation,'q',query_hash,'a',as_of,'u',valid_until,'k',last_key,'p',page_number);
   cursor_data:=cursor_body||jsonb_build_object('sig',encode(sha256(key_secret||convert_to(cursor_body::text,'UTF8')),'hex'));
   next_cursor:=replace(replace(translate(encode(convert_to(cursor_data::text,'UTF8'),'base64'),'+/','-_'),E'\n',''),E'\r','');
 end if;
 coverage:=bid_active_catalog_private.index_coverage();
 coverage:=coverage||jsonb_build_object('complete',coverage->>'complete'='true' and pending_count=0);
 select case when count(*)=case when business='공사·용역' then 4 else 2 end then min(cursor_at) end into synced
 from bid_active_catalog_private.live_cursors where scope_version=bid_active_catalog_private.scope_version() and (business='공사·용역' or type=business);
 storage_size:=bid_active_catalog_private.storage_bytes();
 return jsonb_build_object('items',result_items,'totalCount',total_count,'page',page_number,'pageSize',page_limit,'hasMore',more,
   'fetchedAt',statement_timestamp(),'source','나라장터 검증 공고 색인','nextCursor',next_cursor,'snapshotVersion',generation,'asOf',as_of,'validUntil',valid_until,
   'indexCoverage',coverage,'sourceSyncedThrough',synced,'verifiedCount',verified_count,'pendingCount',pending_count,'conditionPendingCount',condition_count,
   'storage',jsonb_build_object('bytes',storage_size,'ceiling',cfg.storage_ceiling,'full',cfg.storage_blocked or storage_size+65536>=cfg.storage_ceiling or bid_alert_private.storage_bytes()+65536>=33554432),
   'sourceError',cfg.last_error,'warnings',case when coverage->>'complete'='true' then '[]'::jsonb else '["공통 공고 수집·검증이 진행 중입니다. 확인한 범위의 결과입니다."]'::jsonb end);
end $$;
create or replace function bid_active_catalog_private.search_generation_changed()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='UPDATE' and (old.notice,old.source_version,old.verified_version,old.verified_at is null)
   is not distinct from (new.notice,new.source_version,new.verified_version,new.verified_at is null) then return null;end if;
 -- One generation per transaction, even when a raw page writes 200 heads.
 update bid_active_catalog_private.runtime set search_generation=search_generation+1,search_changed_xid=txid_current()
 where singleton and search_changed_xid is distinct from txid_current();
 return null;
end $$;
drop trigger if exists bid_search_index_version on bid_active_catalog_private.deadline_index;
create trigger bid_search_index_version before insert or update on bid_active_catalog_private.deadline_index
 for each row execute function bid_active_catalog_private.search_index_version();
drop trigger if exists bid_search_generation_changed on bid_active_catalog_private.deadline_index;
create trigger bid_search_generation_changed after insert or update or delete on bid_active_catalog_private.deadline_index
 for each row execute function bid_active_catalog_private.search_generation_changed();

create or replace function bid_active_catalog_private.clean_search_text(p_text text)
returns text language sql immutable security invoker set search_path='' as $$
 select btrim(regexp_replace(normalize(coalesce(p_text,''),NFKC),'\s+',' ','g'));
$$;
create or replace function bid_active_catalog_private.license_key(p_text text)
returns text language sql immutable security invoker set search_path='' as $$
 select regexp_replace(regexp_replace(bid_active_catalog_private.clean_search_text(translate(p_text,'ㆍ・ᆞ','···')),'/[0-9]+$',''),'\s','','g');
$$;
create or replace function bid_active_catalog_private.geo_directory()
returns jsonb language sql immutable security invoker set search_path='' as $$
 select '{"aliases":{"서울특별시":"서울특별시","부산광역시":"부산광역시","대구광역시":"대구광역시","인천광역시":"인천광역시","광주광역시":"광주광역시","대전광역시":"대전광역시","울산광역시":"울산광역시","세종특별자치시":"세종특별자치시","경기도":"경기도","강원특별자치도":"강원특별자치도","충청북도":"충청북도","충청남도":"충청남도","전북특별자치도":"전북특별자치도","전라남도":"전라남도","경상북도":"경상북도","경상남도":"경상남도","제주특별자치도":"제주특별자치도","서울":"서울특별시","부산":"부산광역시","대구":"대구광역시","인천":"인천광역시","광주":"광주광역시","대전":"대전광역시","울산":"울산광역시","세종":"세종특별자치시","세종시":"세종특별자치시","경기":"경기도","강원":"강원특별자치도","강원도":"강원특별자치도","충북":"충청북도","충남":"충청남도","전북":"전북특별자치도","전라북도":"전북특별자치도","전남":"전라남도","경북":"경상북도","경남":"경상남도","제주":"제주특별자치도","제주도":"제주특별자치도"},"districts":{"서울특별시":["종로구","중구","용산구","성동구","광진구","동대문구","중랑구","성북구","강북구","도봉구","노원구","은평구","서대문구","마포구","양천구","강서구","구로구","금천구","영등포구","동작구","관악구","서초구","강남구","송파구","강동구"],"부산광역시":["중구","서구","동구","영도구","부산진구","동래구","남구","북구","해운대구","사하구","금정구","강서구","연제구","수영구","사상구","기장군"],"대구광역시":["중구","동구","서구","남구","북구","수성구","달서구","달성군","군위군"],"인천광역시":["제물포구","영종구","미추홀구","연수구","남동구","부평구","계양구","서해구","검단구","강화군","옹진군"],"광주광역시":["동구","서구","남구","북구","광산구"],"대전광역시":["동구","중구","서구","유성구","대덕구"],"울산광역시":["중구","남구","동구","북구","울주군"],"세종특별자치시":["세종시"],"경기도":["수원시","성남시","의정부시","안양시","부천시","광명시","평택시","동두천시","안산시","고양시","과천시","구리시","남양주시","오산시","시흥시","군포시","의왕시","하남시","용인시","파주시","이천시","안성시","김포시","화성시","광주시","양주시","포천시","여주시","연천군","가평군","양평군"],"강원특별자치도":["춘천시","원주시","강릉시","동해시","태백시","속초시","삼척시","홍천군","횡성군","영월군","평창군","정선군","철원군","화천군","양구군","인제군","고성군","양양군"],"충청북도":["청주시","충주시","제천시","보은군","옥천군","영동군","증평군","진천군","괴산군","음성군","단양군"],"충청남도":["천안시","공주시","보령시","아산시","서산시","논산시","계룡시","당진시","금산군","부여군","서천군","청양군","홍성군","예산군","태안군"],"전북특별자치도":["전주시","군산시","익산시","정읍시","남원시","김제시","완주군","진안군","무주군","장수군","임실군","순창군","고창군","부안군"],"전라남도":["목포시","여수시","순천시","나주시","광양시","담양군","곡성군","구례군","고흥군","보성군","화순군","장흥군","강진군","해남군","영암군","무안군","함평군","영광군","장성군","완도군","진도군","신안군"],"경상북도":["포항시","경주시","김천시","안동시","구미시","영주시","영천시","상주시","문경시","경산시","의성군","청송군","영양군","영덕군","청도군","고령군","성주군","칠곡군","예천군","봉화군","울진군","울릉군"],"경상남도":["창원시","진주시","통영시","사천시","김해시","밀양시","거제시","양산시","의령군","함안군","창녕군","고성군","남해군","하동군","산청군","함양군","거창군","합천군"],"제주특별자치도":["제주시","서귀포시"]}}'::jsonb;
$$;
create or replace function bid_active_catalog_private.canonical_province(p_text text,p_search boolean default true)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare name text;begin
 name:=bid_active_catalog_private.geo_directory()#>>array['aliases',bid_active_catalog_private.clean_search_text(p_text)];
 if p_search and (name in ('광주광역시','전라남도') or bid_active_catalog_private.clean_search_text(p_text)='전남광주통합특별시') then return '전남광주통합특별시';end if;
 return name;
end $$;
create or replace function bid_active_catalog_private.region_path(p_text text,p_search boolean default true)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare normalized text:=bid_active_catalog_private.clean_search_text(p_text);parts text[];province text;parent text;parents text[];children text[];
begin
 if normalized='전국' then return '{"nationwide":true}'::jsonb;end if;
 if not p_search then
   province:=bid_active_catalog_private.canonical_province(normalized,false);
   if province is not null then return jsonb_build_object('province',province,'parts','[]'::jsonb);end if;
 end if;
 parts:=string_to_array(normalized,' ');province:=bid_active_catalog_private.canonical_province(parts[1],p_search);
 if province is not null then
   children:=coalesce(parts[case when p_search and province='세종특별자치시' and parts[2]='세종시' then 3 else 2 end:],'{}'::text[]);
   if p_search and not exists(select 1 from unnest(children) child where child!~'^[가-힣A-Za-z0-9·.,]+(시|군|구|읍|면|동|가|리)$')
   then return jsonb_build_object('province',province,'parts',to_jsonb(children));end if;
   if not p_search and (bid_active_catalog_private.geo_directory()#>array['districts',province])?array_to_string(children,' ')
   then return jsonb_build_object('province',province,'parts',to_jsonb(children));end if;
   return null;
 end if;
 select array_agg(distinct bid_active_catalog_private.canonical_province(d.key,p_search)) into parents
 from jsonb_each(bid_active_catalog_private.geo_directory()->'districts') d
 where exists(select 1 from jsonb_array_elements_text(d.value) district where
   case when p_search then parts[1:array_length(string_to_array(district,' '),1)]=string_to_array(district,' ') else district=normalized end);
 if cardinality(parents)=1 and (not p_search or not exists(select 1 from unnest(parts) part where part!~'^[가-힣A-Za-z0-9·.,]+(시|군|구|읍|면|동|가|리)$'))
 then return jsonb_build_object('province',parents[1],'parts',to_jsonb(parts));end if;
 return null;
end $$;
create or replace function bid_active_catalog_private.region_search_state(p_notice jsonb,p_regions jsonb)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare selection jsonb;path jsonb;allowed jsonb;province text;selected_parts text[];source_parts text[];assessment text;review boolean:=false;matched boolean;
begin
 if jsonb_array_length(p_regions)=0 then return 'matched';end if;
 for selection in select value from jsonb_array_elements(p_regions) loop
   province:=bid_active_catalog_private.canonical_province(selection->>'province');
   selected_parts:=string_to_array(bid_active_catalog_private.clean_search_text(concat_ws(' ',
     case when province='세종특별자치시' and selection->>'district'='세종시' then '' else selection->>'district' end,selection->>'locality')),' ');
   if selected_parts=array[''] then selected_parts:='{}';end if;
   if province is null then continue;end if;
   if p_notice->>'type'='공사' then
     if bid_active_catalog_private.canonical_province(p_notice->>'province') is distinct from province then continue;end if;
     if cardinality(selected_parts)=0 then return 'matched';end if;
     path:=bid_active_catalog_private.region_path(concat_ws(' ',p_notice->>'province',p_notice->>'district'));
     if path is null then review:=true;continue;end if;
     select coalesce(array_agg(value),'{}') into source_parts from jsonb_array_elements_text(path->'parts');
     if cardinality(source_parts)<cardinality(selected_parts) and selected_parts[1:cardinality(source_parts)]=source_parts then review:=true;
     elsif source_parts[1:cardinality(selected_parts)]=selected_parts then return 'matched';end if;
   else
     if jsonb_typeof(p_notice->'allowedRegions') is distinct from 'array' or jsonb_array_length(p_notice->'allowedRegions')=0 then review:=true;continue;end if;
     matched:=false;assessment:='excluded';
     for allowed in select value from jsonb_array_elements(p_notice->'allowedRegions') loop
       path:=bid_active_catalog_private.region_path(allowed#>>'{}');
       if path is null then assessment:='review';continue;end if;
       select coalesce(array_agg(value),'{}') into source_parts from jsonb_array_elements_text(coalesce(path->'parts','[]'));
       if path->>'nationwide'='true' or path->>'province'=province and
         (cardinality(source_parts)=0 or cardinality(selected_parts)=0 or source_parts[1:cardinality(selected_parts)]=selected_parts
         or selected_parts[1:cardinality(source_parts)]=source_parts) then matched:=true;end if;
     end loop;
     if assessment='review' then review:=true;elsif matched then return 'matched';end if;
   end if;
 end loop;
 return case when review then 'review' else 'excluded' end;
end $$;
create or replace function bid_active_catalog_private.profile_region_state(p_notice jsonb,p_profile jsonb)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare province text:=bid_active_catalog_private.canonical_province(p_profile->>'province',false);
 district text:=bid_active_catalog_private.clean_search_text(p_profile->>'district');path jsonb;allowed jsonb;parts text[];matched boolean:=false;
begin
 if province is null or district='' or not ((bid_active_catalog_private.geo_directory()#>array['districts',province])?district)
 or jsonb_typeof(p_notice->'allowedRegions') is distinct from 'array' or jsonb_array_length(p_notice->'allowedRegions')=0 then return 'review';end if;
 for allowed in select value from jsonb_array_elements(p_notice->'allowedRegions') loop
   path:=bid_active_catalog_private.region_path(allowed#>>'{}',false);if path is null then return 'review';end if;
   select coalesce(array_agg(value),'{}') into parts from jsonb_array_elements_text(coalesce(path->'parts','[]'));
   if path->>'nationwide'='true' or path->>'province'=province and (cardinality(parts)=0 or array_to_string(parts,' ')=district) then matched:=true;end if;
 end loop;
 if matched then return 'matched';end if;
 return case when p_notice->>'specialRegionCondition'='true' then 'review' else 'excluded' end;
end $$;
create or replace function bid_active_catalog_private.safe_time(p_value text)
returns timestamptz language plpgsql immutable security invoker set search_path='' as $$
begin
 if coalesce(p_value,'')!~'^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?)?$' then return null;end if;
 if p_value~'([Zz]|[+-]\d{2}:?\d{2})$' then return p_value::timestamptz;end if;
 return p_value::timestamp at time zone 'Asia/Seoul';
 exception when invalid_datetime_format or datetime_field_overflow then return null;end $$;
create or replace function bid_active_catalog_private.phase(p_notice jsonb,p_at timestamptz)
returns text language plpgsql stable security invoker set search_path='' as $$
declare closing timestamptz:=bid_active_catalog_private.safe_time(p_notice->>'deadline');
 opening timestamptz:=bid_active_catalog_private.safe_time(p_notice->>'openingAt');starting timestamptz:=bid_active_catalog_private.safe_time(p_notice->>'biddingStartAt');
begin
 if p_notice->>'status'='취소' or coalesce(p_notice->>'noticeKind','') like '%취소%' then return '';end if;
 if p_notice->>'openingCompleted'='true' or opening<=p_at then return '개찰 완료';end if;
 if starting>p_at or starting is null and p_notice->>'status'='접수예정' and closing>p_at then return '예정';end if;
 if closing>p_at and closing<=p_at+interval '24 hours' then return '마감 임박';end if;
 if closing>p_at or closing<=p_at and opening>p_at then return '진행중';end if;
 return '';
end $$;

-- match_unknown is included only when the owner explicitly includes unknown
-- geographical facts; pending is withheld and reported separately.
create or replace function bid_active_catalog_private.search_match(p_notice jsonb,p_filters jsonb,p_profile jsonb,p_at timestamptz)
returns text language plpgsql stable security invoker set search_path='' as $$
declare search_text text;
 keyword text:=lower(bid_active_catalog_private.clean_search_text(p_filters->>'keyword'));excluded text;regions jsonb;statuses jsonb;
 lower_amount numeric;upper_amount numeric;price numeric;geo text;profile_geo text;unknown boolean:=false;pending boolean:=false;closing_day date;
begin
 if keyword<>'' or coalesce(p_filters->>'excludeKeyword','')<>'' then
   search_text:=lower(bid_active_catalog_private.clean_search_text(concat_ws(' ',p_notice->>'title',p_notice->>'number',p_notice->>'agency')));end if;
 if keyword<>'' and strpos(search_text,keyword)=0 then return 'excluded';end if;
 for excluded in select btrim(value) from unnest(string_to_array(lower(bid_active_catalog_private.clean_search_text(p_filters->>'excludeKeyword')),',')) value loop
   if excluded<>'' and strpos(search_text,excluded)>0 then return 'excluded';end if;
 end loop;
 if p_filters->>'category'<>'전체' and p_notice->>'category' is distinct from p_filters->>'category' then return 'excluded';end if;
 if p_filters->>'type'<>'전체' and p_notice->>'type' is distinct from p_filters->>'type' then return 'excluded';end if;
 statuses:=coalesce(p_filters->'statuses',case when p_filters->>'status'='전체' then '[]'::jsonb else jsonb_build_array(p_filters->>'status') end);
 if jsonb_array_length(statuses)>0 and not statuses?bid_active_catalog_private.phase(p_notice,p_at) then return 'excluded';end if;
 if p_filters->>'contractMethod'<>'전체' and p_notice->>'contractMethod' is distinct from p_filters->>'contractMethod' then return 'excluded';end if;
 lower_amount:=nullif(replace(p_filters->>'minAmount',',',''),'')::numeric;upper_amount:=nullif(replace(p_filters->>'maxAmount',',',''),'')::numeric;
 price:=case when jsonb_typeof(p_notice->'estimatedPrice')='number' and (p_notice->>'estimatedPrice')::numeric>=0 then (p_notice->>'estimatedPrice')::numeric end;
 if (lower_amount is not null or upper_amount is not null) and price is null then return 'excluded';end if;
 if price<lower_amount or price>upper_amount then return 'excluded';end if;
 closing_day:=(bid_active_catalog_private.safe_time(p_notice->>'deadline') at time zone 'Asia/Seoul')::date;
 if coalesce(p_filters->>'deadlineFrom','')<>'' and closing_day<(p_filters->>'deadlineFrom')::date then return 'excluded';end if;
 if coalesce(p_filters->>'deadlineTo','')<>'' and closing_day>(p_filters->>'deadlineTo')::date then return 'excluded';end if;
 if p_filters->>'license'<>'전체' then
   if p_notice->>'licenseComplete' is distinct from 'true' or jsonb_typeof(p_notice->'licenses') is distinct from 'array' then pending:=true;
   elsif not exists(select 1 from jsonb_array_elements_text(p_notice->'licenses') license
     where bid_active_catalog_private.license_key(license)=bid_active_catalog_private.license_key(p_filters->>'license')) then return 'excluded';end if;
 end if;
 regions:=coalesce(p_filters->'regions',case when p_filters->>'siteProvince'='전체' then '[]'::jsonb else jsonb_build_array(jsonb_build_object('province',p_filters->>'siteProvince')) end);
 if jsonb_array_length(regions)>0 then
   geo:=bid_active_catalog_private.region_search_state(p_notice,regions);
   if p_notice->>'type'='용역' and p_notice->>'regionComplete' is distinct from 'true' then geo:='review';end if;
   if geo='excluded' then return 'excluded';end if;
   if geo='review' then
     if p_filters?'regions' and coalesce((p_filters->>'includeUnknownRegions')::boolean,false)=false then pending:=true;else unknown:=true;end if;
   end if;
 end if;
 if p_filters->>'regionView'<>'all' or p_filters->>'autoRegion'='true' then
   profile_geo:=bid_active_catalog_private.profile_region_state(p_notice,p_profile);
   if p_notice->>'regionComplete' is distinct from 'true' then profile_geo:='review';end if;
   if p_filters->>'regionView'<>'all' then
     if profile_geo is distinct from p_filters->>'regionView' then
       if profile_geo='review' then pending:=true;else return 'excluded';end if;
     elsif profile_geo='review' then unknown:=true;end if;
   elsif profile_geo<>'matched' then if profile_geo='review' then pending:=true;else return 'excluded';end if;end if;
 end if;
 return case when pending then 'pending' when unknown then 'match_unknown' else 'match' end;
end $$;

alter table bid_active_catalog_private.verification add column if not exists source_version text;
-- The existing collector still owns durable source cursors and personal history.
-- This layer adds shared verification without replaying any historical scope.
do $$ begin
 if to_regprocedure('bid_active_catalog_private.worker_deadline(text,text,jsonb)') is null then
   alter function public.bid_active_catalog_worker(text,text,jsonb) set schema bid_active_catalog_private;
   alter function bid_active_catalog_private.bid_active_catalog_worker(text,text,jsonb) rename to worker_deadline;
 end if;
end $$;

create or replace function bid_active_catalog_private.queue_search_verification(p_numbers jsonb default null)
returns void language plpgsql security invoker set search_path='' as $$
begin
 insert into bid_active_catalog_private.verification(type,number,revision,source_updated_at,scope_version,source_version)
 select d.type,d.number,d.revision,d.source_updated_at,bid_active_catalog_private.scope_version(),d.source_version
 from bid_active_catalog_private.deadline_index d where bid_active_catalog_private.ongoing(d.notice)
   and (d.verified_at is null or d.source_version is distinct from d.verified_version
     or d.notice->>'regionComplete' is distinct from 'true' or d.notice->>'licenseComplete' is distinct from 'true'
     or d.deadline<=clock_timestamp() and d.opening_at>clock_timestamp() and (d.verified_at<d.deadline or d.verified_at<=clock_timestamp()-interval '10 minutes'))
   and (p_numbers is null or exists(select 1 from jsonb_array_elements(p_numbers) n where n->>'type'=d.type and n->>'number'=d.number))
 on conflict(type,number) do update set revision=excluded.revision,source_updated_at=excluded.source_updated_at,
   source_version=excluded.source_version,scope_version=excluded.scope_version,next_attempt=clock_timestamp(),failures=0,last_error=null,claimed_lease=null
 where excluded.revision>bid_active_catalog_private.verification.revision
   or excluded.revision=bid_active_catalog_private.verification.revision and excluded.source_updated_at>=bid_active_catalog_private.verification.source_updated_at
     and excluded.source_version is distinct from bid_active_catalog_private.verification.source_version
   or bid_active_catalog_private.verification.scope_version is distinct from excluded.scope_version;
end $$;

create or replace function public.bid_active_catalog_worker(p_token text,p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare auth_cfg bid_alert_private.runtime%rowtype;cfg bid_active_catalog_private.runtime%rowtype;outcome jsonb;
 stamp timestamptz:=clock_timestamp();lease uuid;queue_count bigint;cost bigint;selected_keys text[];versions jsonb;n jsonb;head jsonb;ids text[];preserved jsonb;
 typ text;number_value text;revision_value integer;source_time timestamptz;head_hash text;
 candidate bid_active_catalog_private.verification%rowtype;indexed bid_active_catalog_private.deadline_index%rowtype;
begin
 select * into strict auth_cfg from bid_alert_private.runtime where singleton;
 if p_token is null or length(p_token) not between 43 and 128 or auth_cfg.token_hash is null
 or sha256(convert_to(p_token,'UTF8')) is distinct from auth_cfg.token_hash then
 raise exception using errcode='42501',message='공고 수집 작업 인증에 실패했습니다.';end if;
 if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>2800000 then
 raise exception using errcode='22023',message='공고 색인 요청 형식을 확인해 주세요.';end if;
 if p_action='search_page' then return bid_active_catalog_private.search_page(p_payload);end if;
 if p_action not in ('claim','index_upsert','search_publish','publish_verified','enrich') then
   return bid_active_catalog_private.worker_deadline(p_token,p_action,p_payload);end if;
 select * into strict cfg from bid_active_catalog_private.runtime where singleton for update;
 perform 1 from bid_alert_private.runtime where singleton for update;
 if not exists(select 1 from bid_alert_private.runtime where singleton and token_hash=sha256(convert_to(p_token,'UTF8'))) then
 raise exception using errcode='42501',message='공고 수집 작업 인증에 실패했습니다.';end if;

 if p_action='claim' then
   if cfg.lease_until>stamp or cfg.retry_after_at>stamp or not auth_cfg.configured
     or coalesce((select locked from public.bid_menu_settings where menu_key='notices'),true) then
     return bid_active_catalog_private.worker_deadline(p_token,p_action,p_payload);end if;
   select count(*) into queue_count from bid_active_catalog_private.deadline_index d
   where bid_active_catalog_private.ongoing(d.notice) and (d.verified_at is null or d.source_version is distinct from d.verified_version
     or d.notice->>'regionComplete' is distinct from 'true' or d.notice->>'licenseComplete' is distinct from 'true'
     or d.deadline<=stamp and d.opening_at>stamp and (d.verified_at<d.deadline or d.verified_at<=stamp-interval '10 minutes'))
     and not exists(select 1 from bid_active_catalog_private.verification v where v.type=d.type and v.number=d.number);
   cost:=queue_count*1536+65536;
   if bid_active_catalog_private.storage_bytes()+cost>=cfg.storage_ceiling or bid_alert_private.storage_bytes()+cost>=33554432 then
     update bid_active_catalog_private.runtime set storage_blocked=true,last_error='기존 저장 한도 안의 공고 검증 공간이 부족해 수집을 대기합니다.' where singleton;
     return jsonb_build_object('leaseId',null,'scopeVersion',bid_active_catalog_private.scope_version(),'rules',bid_active_catalog_private.rules(),
       'sources','[]'::jsonb,'verify','[]'::jsonb,'status',bid_active_catalog_private.status());end if;
   begin
     perform bid_active_catalog_private.queue_search_verification();
     if bid_active_catalog_private.storage_bytes()+65536>=cfg.storage_ceiling or bid_alert_private.storage_bytes()+65536>=33554432 then
       raise exception using errcode='54000',message='Shared verification capacity reached';end if;
     outcome:=bid_active_catalog_private.worker_deadline(p_token,p_action,p_payload);lease:=(outcome->>'leaseId')::uuid;
     if lease is null then return outcome;end if;
     -- Eight existing known heads plus eight shared public heads; fairness and
     -- the server's provider-call budget bound work within each invocation.
     select array_agg(key) into selected_keys from (
       select v.type||':'||v.number key from bid_active_catalog_private.verification v
       where v.scope_version=outcome->>'scopeVersion' and v.next_attempt<=stamp and v.claimed_lease is distinct from lease
       order by v.queued_at,v.type,v.number limit greatest(0,16-jsonb_array_length(outcome->'verify'))
     ) q;
     update bid_active_catalog_private.verification set claimed_lease=lease where type||':'||number=any(coalesce(selected_keys,'{}'::text[]));
     select coalesce(jsonb_agg(jsonb_build_object('type',v.type,'number',v.number,'revision',lpad(v.revision::text,3,'0'),
       'sourceUpdatedAt',v.source_updated_at,'tracked',exists(select 1 from bid_active_catalog_private.known_heads() k where k.type=v.type and k.number=v.number))
       ||case when d.verified_at is not null and d.source_version=d.verified_version and d.revision=v.revision and d.source_updated_at=v.source_updated_at
         then jsonb_build_object('notice',d.notice) else '{}'::jsonb end order by v.queued_at,v.type,v.number),'[]'::jsonb)
       into versions from bid_active_catalog_private.verification v left join bid_active_catalog_private.deadline_index d using(type,number)
       where v.claimed_lease=lease and v.scope_version=outcome->>'scopeVersion';
     update bid_active_catalog_private.runtime set storage_blocked=false where singleton;
     if bid_active_catalog_private.storage_bytes()>=cfg.storage_ceiling or bid_alert_private.storage_bytes()>=33554432 then
       raise exception using errcode='54000',message='Shared claim capacity reached';end if;
     return outcome||jsonb_build_object('verify',versions,'status',bid_active_catalog_private.status());
   exception when program_limit_exceeded then
     update bid_active_catalog_private.runtime set storage_blocked=true,last_error='기존 저장 한도 안의 공고 검증 공간이 부족해 수집을 대기합니다.' where singleton;
     return jsonb_build_object('leaseId',null,'scopeVersion',bid_active_catalog_private.scope_version(),'rules',bid_active_catalog_private.rules(),
       'sources','[]'::jsonb,'verify','[]'::jsonb,'status',bid_active_catalog_private.status());
   end;
 elsif p_action='index_upsert' then
   cost:=greatest(65536,coalesce(jsonb_array_length(p_payload->'notices'),0)*1536+octet_length(p_payload::text)*3);
   if bid_active_catalog_private.storage_bytes()+cost>=cfg.storage_ceiling or bid_alert_private.storage_bytes()+cost>=33554432 then
     update bid_active_catalog_private.runtime set storage_blocked=true,last_error='기존 저장 한도 안의 공고 색인 공간이 부족해 수집을 대기합니다.' where singleton;
     return jsonb_build_object('ok',false,'storageFull',true);end if;
   begin
     outcome:=bid_active_catalog_private.worker_deadline(p_token,p_action,p_payload);
     if outcome->>'ok' is distinct from 'true' then
       if outcome->>'storageFull'='true' then update bid_active_catalog_private.runtime set storage_blocked=true where singleton;end if;
       return outcome;end if;
     perform bid_active_catalog_private.queue_search_verification(p_payload->'notices');
     if bid_active_catalog_private.storage_bytes()>=cfg.storage_ceiling or bid_alert_private.storage_bytes()>=33554432 then
       raise exception using errcode='54000',message='Shared index and queue capacity reached';end if;
     update bid_active_catalog_private.runtime set storage_blocked=false where singleton;
     return outcome;
   exception when program_limit_exceeded then
     update bid_active_catalog_private.runtime set storage_blocked=true,last_error='기존 저장 한도 안의 공고 색인 공간이 부족해 수집을 대기합니다.' where singleton;
     return jsonb_build_object('ok',false,'storageFull',true);
   end;
 elsif p_action='search_publish' then
   begin lease:=(p_payload->>'leaseId')::uuid;exception when others then lease:=null;end;
   if lease is null or cfg.lease_id is distinct from lease or cfg.lease_until<=stamp
     or p_payload->>'scopeVersion' is distinct from cfg.scope_version or cfg.scope_version is distinct from bid_active_catalog_private.scope_version()
     then raise exception using errcode='42501',message='공고 검증 작업 임대를 확인해 주세요.';end if;
   if jsonb_typeof(p_payload->'groups') is distinct from 'array' or jsonb_array_length(p_payload->'groups') not between 1 and 16 then raise exception 'Invalid shared verified batch';end if;
   -- This estimate includes transient full-history payloads conservatively;
   -- only one compact head per identity is stored by this action.
   cost:=greatest(65536,octet_length(p_payload::text)*3);
   if bid_active_catalog_private.storage_bytes()+cost>=cfg.storage_ceiling or bid_alert_private.storage_bytes()+cost>=33554432 then
     update bid_active_catalog_private.runtime set storage_blocked=true where singleton;return jsonb_build_object('ok',false,'storageFull',true);end if;
   begin
     for versions in select value from jsonb_array_elements(p_payload->'groups') loop
       if jsonb_typeof(versions) is distinct from 'array' or jsonb_array_length(versions) not between 1 and 1000 then raise exception 'Incomplete shared history';end if;
       typ:=versions->0->>'type';number_value:=versions->0->>'number';head:=null;ids:='{}';
       if typ not in ('공사','용역') or coalesce(number_value,'')!~'^[A-Za-z0-9_-]{1,40}$' then raise exception 'Invalid shared identity';end if;
       select * into strict candidate from bid_active_catalog_private.verification where type=typ and number=number_value and scope_version=cfg.scope_version and claimed_lease=lease for update;
       for n in select value from jsonb_array_elements(versions) order by (value->>'revision')::integer desc loop
         if n->>'type' is distinct from typ or n->>'number' is distinct from number_value or coalesce(n->>'revision','')!~'^[0-9]{3}$'
           or n->>'source' is distinct from 'live' or n->>'revision'=any(ids) then raise exception 'Invalid shared revision history';end if;
         source_time:=bid_active_catalog_private.safe_time(n->>'sourceUpdatedAt');
         if source_time is null or not isfinite(source_time) then raise exception 'Invalid shared source time';end if;
         ids:=array_append(ids,n->>'revision');n:=bid_active_catalog_private.compact(n);
         if octet_length(n::text)>4096 then raise exception 'Shared head exceeded compact budget';end if;
         if head is null then head:=n;end if;
       end loop;
       revision_value:=(head->>'revision')::integer;source_time:=(head->>'sourceUpdatedAt')::timestamptz;
       head_hash:=bid_active_catalog_private.source_version(head);
       if revision_value<candidate.revision or revision_value=candidate.revision and source_time<candidate.source_updated_at then raise exception 'Stale shared history';end if;
       select * into indexed from bid_active_catalog_private.deadline_index where type=typ and number=number_value for update;
       if found and (revision_value<indexed.revision or revision_value=indexed.revision and source_time<indexed.source_updated_at
         or revision_value=indexed.revision and source_time=indexed.source_updated_at and head_hash is distinct from indexed.source_version)
         then raise exception 'Stale shared source facts';end if;
       if exists(select 1 from bid_active_catalog_private.deadline_invalidations h where h.type=typ and h.number=number_value
         and (h.revision>revision_value or h.revision=revision_value and h.source_updated_at>=source_time))
         and bid_active_catalog_private.ongoing(head,stamp) then raise exception 'Previously invalidated shared head';end if;
       if exists(select 1 from bid_active_catalog_private.groups g where g.type=typ and g.number=number_value and (
         g.revision>revision_value or g.revision=revision_value and g.source_updated_at>source_time
         or exists(select 1 from jsonb_array_elements(g.versions) old where not(old->>'revision'=any(ids))))) then raise exception 'Incomplete known shared history';end if;
       if exists(select 1 from bid_active_catalog_private.groups g where g.type=typ and g.number=number_value and g.revision=revision_value
         and g.source_updated_at=source_time and g.latest->>'openingCompleted'='true') then head:=head||'{"openingCompleted":true}'::jsonb;end if;
       if bid_active_catalog_private.ongoing(head,stamp) then
         if head->>'regionComplete' is distinct from 'true' or head->>'licenseComplete' is distinct from 'true' then
           raise exception 'Shared verification requires complete participant conditions';end if;
         insert into bid_active_catalog_private.deadline_index(type,number,revision,notice,source_updated_at,deadline,opening_at,indexed_at,verified_at,source_version,verified_version)
         values(typ,number_value,revision_value,head,source_time,(head->>'deadline')::timestamptz,nullif(head->>'openingAt','')::timestamptz,stamp,stamp,head_hash,head_hash)
         on conflict(type,number) do update set revision=excluded.revision,notice=excluded.notice,source_updated_at=excluded.source_updated_at,
           deadline=excluded.deadline,opening_at=excluded.opening_at,indexed_at=excluded.indexed_at,verified_at=excluded.verified_at,
           source_version=excluded.source_version,verified_version=excluded.verified_version;
       else
         delete from bid_active_catalog_private.deadline_index where type=typ and number=number_value;
         insert into bid_active_catalog_private.deadline_invalidations(type,number,revision,source_updated_at) values(typ,number_value,revision_value,source_time)
         on conflict(type,number) do update set revision=excluded.revision,source_updated_at=excluded.source_updated_at
           where excluded.revision>bid_active_catalog_private.deadline_invalidations.revision or excluded.revision=bid_active_catalog_private.deadline_invalidations.revision
             and excluded.source_updated_at>bid_active_catalog_private.deadline_invalidations.source_updated_at;
       end if;
     end loop;
     if bid_active_catalog_private.storage_bytes()>=cfg.storage_ceiling or bid_alert_private.storage_bytes()>=33554432 then raise exception using errcode='54000',message='Shared publication capacity reached';end if;
     update bid_active_catalog_private.runtime set storage_blocked=false where singleton;
     -- Keep the lease-owned queue intact. The worker next commits personal
     -- matches or rejectedGroups; that successful step consumes the queue.
     return jsonb_build_object('ok',true);
   exception when program_limit_exceeded then
     update bid_active_catalog_private.runtime set storage_blocked=true where singleton;return jsonb_build_object('ok',false,'storageFull',true);
   end;
 else
   if p_action='publish_verified' then
     versions:='[]'::jsonb;
     for n in select value from jsonb_array_elements(p_payload->'notices') loop
       if exists(select 1 from bid_active_catalog_private.groups g where g.type=n->>'type' and g.number=n->>'number'
         and g.revision=(n->>'revision')::integer and g.source_updated_at=(n->>'sourceUpdatedAt')::timestamptz
         and g.latest->>'openingCompleted'='true') then n:=n||'{"openingCompleted":true}'::jsonb;end if;
       select d.notice into preserved from bid_active_catalog_private.deadline_index d where d.type=n->>'type' and d.number=n->>'number'
         and d.revision=(n->>'revision')::integer and d.source_updated_at=(n->>'sourceUpdatedAt')::timestamptz
         and d.source_version=bid_active_catalog_private.source_version(bid_active_catalog_private.compact(n));
       if found then
         if n->>'regionComplete' is distinct from 'true' and preserved->>'regionComplete'='true' then
           n:=n||jsonb_build_object('allowedRegions',preserved->'allowedRegions','regionComplete',true);end if;
         if n->>'licenseComplete' is distinct from 'true' and preserved->>'licenseComplete'='true' then
           n:=n||jsonb_build_object('licenses',preserved->'licenses','licenseComplete',true);end if;
       end if;
       versions:=versions||jsonb_build_array(n);
     end loop;
     select value into head from jsonb_array_elements(versions) order by (value->>'revision')::integer desc limit 1;
     if bid_active_catalog_private.ongoing(head,stamp) and exists(select 1 from bid_active_catalog_private.deadline_invalidations h
       where h.type=head->>'type' and h.number=head->>'number' and (h.revision>(head->>'revision')::integer
         or h.revision=(head->>'revision')::integer and h.source_updated_at>=(head->>'sourceUpdatedAt')::timestamptz))
       then return jsonb_build_object('ok',false);end if;
     p_payload:=p_payload||jsonb_build_object('notices',versions);
   end if;
   outcome:=bid_active_catalog_private.worker_deadline(p_token,p_action,p_payload);
   if outcome->>'ok'='true' then
     update bid_active_catalog_private.deadline_index d set verified_version=d.source_version,verified_at=g.verified_at
       from bid_active_catalog_private.groups g where g.type=d.type and g.number=d.number and g.revision=d.revision and g.source_updated_at=d.source_updated_at
         and bid_active_catalog_private.source_version(g.latest)=d.source_version
         and g.latest->>'regionComplete'='true' and g.latest->>'licenseComplete'='true'
         and (d.verified_version is distinct from d.source_version or d.verified_at is null);
   elsif outcome->>'storageFull'='true' then update bid_active_catalog_private.runtime set storage_blocked=true where singleton;end if;
   return outcome;
 end if;
end $$;

revoke all on all functions in schema bid_active_catalog_private from public,anon,authenticated;
revoke all on function public.bid_active_catalog_worker(text,text,jsonb) from public;
grant execute on function public.bid_active_catalog_worker(text,text,jsonb) to anon,authenticated;
do $$ begin
 if bid_active_catalog_private.storage_bytes()>=16777216 or bid_alert_private.storage_bytes()>=33554432 then
   raise exception using errcode='54000',message='Existing storage budget cannot fit verified search metadata';end if;
end $$;
commit;
