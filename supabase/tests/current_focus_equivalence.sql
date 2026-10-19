-- Independent original NFKC/whitespace/trim oracle. All fixtures roll back.
begin;
create function pg_temp.original_current_focus(p_notice jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
 select btrim(regexp_replace(normalize(coalesce(p_notice->>'title',''),NFKC),'\s+',' ','g'))
   ~'(철거|해체|석면|건설폐기물)';
$$;
create temporary table current_focus_cases(id text primary key,notice jsonb);
insert into current_focus_cases
select token||':'||form_index||':'||code||':'||placement,
 jsonb_build_object('title',case placement
   when 1 then whitespace||form when 2 then form||whitespace
   when 3 then whitespace||form||whitespace
   when 4 then '앞'||whitespace||form||whitespace||'뒤'
   when 5 then left(form,1)||whitespace||substr(form,2)
   when 6 then left(form,1)||whitespace||whitespace||substr(form,2)
   when 7 then '앞'||form||whitespace||'뒤'
   when 8 then '공고'||whitespace||'앞'||form||'뒤'||whitespace
   when 9 then '가격123'||whitespace||form||'0원'
   else 'prefix'||whitespace||form||whitespace||'suffix' end,
   'documents',jsonb_build_array(jsonb_build_object('name','석면 폐기물 문서')),
   'description','철거 해체 석면 건설폐기물')
from unnest(array['철거','해체','석면','건설폐기물']) token,
 lateral unnest(array[token,normalize(token,NFD)]) with ordinality forms(form,form_index),
 unnest(array[9,10,11,12,13,28,29,30,31,32,133,160,5760,6158,
   8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8203,
   8232,8233,8239,8287,12288,65279]) code,
 lateral(select chr(code) whitespace)w,generate_series(1,10)placement;

insert into current_focus_cases values
 ('sql-null',null),('json-null','null'),('scalar-string','"철거"'),('scalar-number','123'),('scalar-bool','true'),
 ('array-notice','["철거",{"title":"석면"}]'),('empty-object','{}'),
 ('null-title','{"title":null}'),('number-title','{"title":123}'),('bool-title','{"title":true}'),
 ('object-title','{"title":{"name":"철거"}}'),('array-title','{"title":["석면"]}'),
 ('irrelevant-keys','{"description":"철거","documents":[{"name":"해체"}],"regionSearchText":"석면"}'),
 ('partial-word','{"title":"재철거예정및해체비용"}'),
 ('fullwidth-ascii','{"title":"ＡＢＣ１２３ 철거 ＦＯＯ"}'),
 ('halfwidth-katakana','{"title":"ﾊﾝｶｸ 해체 ｶﾀｶﾅ"}'),
 ('compatibility-jamo','{"title":"ㅊㅓㄹㄱㅓ ㄱㅓㄴㅅㅓㄹㅍㅖㄱㅣㅁㅜㄹ"}'),
 ('decomposed-jamo',jsonb_build_object('title',normalize('학교 철거 및 건설폐기물 처리',NFD))),
 ('compatibility-mixed',jsonb_build_object('title',normalize('석면 처리 ＡＢＣ',NFKD)));

-- Every halfwidth Hangul and compatibility Jamo code point also appears around
-- an intact keyword and in a title that contains no keyword.
insert into current_focus_cases
select 'jamo:'||code||':'||placement,jsonb_build_object('title',case placement
 when 1 then chr(code)||'철거'||chr(code) else chr(code)||'일반 공사'||chr(code)end)
from (select generate_series(12593,12686)code union all select generate_series(65440,65500))j,
 generate_series(1,2)placement;

do $$declare checked bigint;different bigint;begin
 select count(*),count(*)filter(where pg_temp.original_current_focus(notice)
   is distinct from bid_active_catalog_private.current_focus(notice))into checked,different from current_focus_cases;
 assert checked>=2800,'at least 2800 independent text and malformed-notice cases';
 assert different=0,'current focus differs from the original whitespace-normalizing oracle';
 assert bid_active_catalog_private.current_focus('{"title":"공고 철거 예정"}'),'ordinary token remains matched';
 assert not bid_active_catalog_private.current_focus('{"title":"철 거 건설 폐기물"}'),'internal spaces never join tokens';
 assert not bid_active_catalog_private.current_focus('{"description":"철거"}'),'unrelated fields never create a title match';
 assert not has_function_privilege('anon','bid_active_catalog_private.current_focus(jsonb)','execute'),'focus helper stays private';
 assert not has_function_privilege('authenticated','bid_active_catalog_private.current_focus(jsonb)','execute'),'focus helper stays token guarded';
 assert(select provolatile='i'and not prosecdef from pg_proc
   where oid='bid_active_catalog_private.current_focus(jsonb)'::regprocedure),'immutable invoker metadata preserved';
end $$;
select count(*)checked,count(*)filter(where pg_temp.original_current_focus(notice)
 is distinct from bid_active_catalog_private.current_focus(notice))mismatches from current_focus_cases;
rollback;
