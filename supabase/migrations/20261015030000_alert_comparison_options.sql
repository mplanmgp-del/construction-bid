-- Extend comparison options without rewriting saved settings, budgets, data or cron.
-- Legacy rules normalize to regionBasis=auto; newly created rules use either.
begin;
create or replace function bid_alert_private.defaults()
returns jsonb language sql immutable security invoker set search_path='' as $$
 select '{"enabled":false,"filter":{"keywords":["철거","해체","석면","건설폐기물"],"excludeKeywords":[],"types":["공사","용역"],"categories":[],"regions":[],"licenses":[],"minAmount":null,"maxAmount":null,"includeUnknown":true,"useCompanyRegion":false,"regionBasis":"either","agencies":[],"contractMethods":[],"minDaysUntilDeadline":null,"useCompanyLicenses":false},"notifyChanges":true,"pushEnabled":false,"activatedAt":null,"updatedAt":null}'::jsonb;
$$;

create or replace function bid_alert_private.validate_settings(p_settings jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare f jsonb; name text; item jsonb; result jsonb; lower_amount numeric; upper_amount numeric; deadline_days numeric; max_length integer;
begin
 if jsonb_typeof(p_settings) is distinct from 'object' or octet_length(p_settings::text)>16384 then raise exception using errcode='22023',message='알림 설정 형식을 확인해 주세요.'; end if;
 f:=p_settings->'filter';
 if jsonb_typeof(f) is distinct from 'object' then raise exception using errcode='22023',message='알림 조건을 확인해 주세요.'; end if;
 -- Missing extension fields belong to a legacy rule. Preserve its original
 -- regional meaning; explicit nulls remain visible to the type checks below.
 f:='{"regionBasis":"auto","agencies":[],"contractMethods":[],"minDaysUntilDeadline":null,"useCompanyLicenses":false}'::jsonb||f;
 foreach name in array array['enabled','notifyChanges','pushEnabled'] loop
   if jsonb_typeof(p_settings->name) is distinct from 'boolean' then raise exception using errcode='22023',message='알림 선택 값을 확인해 주세요.'; end if;
 end loop;
 foreach name in array array['includeUnknown','useCompanyRegion','useCompanyLicenses'] loop
   if jsonb_typeof(f->name) is distinct from 'boolean' then raise exception using errcode='22023',message='알림 지역 조건을 확인해 주세요.'; end if;
 end loop;
 if jsonb_typeof(f->'regionBasis') is distinct from 'string' or f->>'regionBasis' not in ('auto','site','participation','either','both') then
   raise exception using errcode='22023',message='알림 지역 비교 기준을 확인해 주세요.'; end if;
 if f->'minDaysUntilDeadline'<>'null'::jsonb then
   if jsonb_typeof(f->'minDaysUntilDeadline') is distinct from 'number' then
     raise exception using errcode='22023',message='남은 마감일은 0부터 365 사이의 정수로 입력해 주세요.'; end if;
   deadline_days:=(f->>'minDaysUntilDeadline')::numeric;
   if deadline_days<0 or deadline_days>365 or trunc(deadline_days)<>deadline_days then
     raise exception using errcode='22023',message='남은 마감일은 0부터 365 사이의 정수로 입력해 주세요.'; end if;
 end if;
 foreach name in array array['keywords','excludeKeywords','types','categories','regions','licenses','agencies','contractMethods'] loop
   max_length:=case when name in ('keywords','excludeKeywords') then 80 when name='licenses' then 120 else 100 end;
   if jsonb_typeof(f->name) is distinct from 'array' or jsonb_array_length(f->name)>20 then raise exception using errcode='22023',message='알림 조건은 항목별 20개 이하로 지정해 주세요.'; end if;
   for item in select value from jsonb_array_elements(f->name) loop
     if jsonb_typeof(item)<>'string' or length(btrim(item#>>'{}')) not between 1 and max_length or
        item#>>'{}'~'[[:cntrl:]]' then raise exception using errcode='22023',message='알림 조건의 글자 수를 확인해 주세요.'; end if;
     if name='types' and item#>>'{}' not in ('공사','용역') then raise exception using errcode='22023',message='알림 업무 구분을 확인해 주세요.'; end if;
     if name='categories' and item#>>'{}' not in ('철거·해체','석면','건축·리모델링','토목','보수·유지관리','전기·통신·소방','기계·설비','조경','폐기물','조사·설계·감리','기타') then raise exception using errcode='22023',message='알림 분류를 확인해 주세요.'; end if;
   end loop;
   select coalesce(jsonb_agg(v order by v),'[]'::jsonb) into item from (select distinct btrim(value#>>'{}') v from jsonb_array_elements(f->name)) s;
   f:=jsonb_set(f,array[name],item);
 end loop;
 if jsonb_array_length(f->'types')=0 then raise exception using errcode='22023',message='공사 또는 용역을 선택해 주세요.'; end if;
 foreach name in array array['minAmount','maxAmount'] loop
   if not f?name or (f->name<>'null'::jsonb and (jsonb_typeof(f->name)<>'number' or (f->>name)::numeric<0 or (f->>name)::numeric>9007199254740991 or trunc((f->>name)::numeric)<>(f->>name)::numeric)) then raise exception using errcode='22023',message='금액은 0 이상의 원 단위 정수로 입력해 주세요.'; end if;
 end loop;
 lower_amount:=(f->>'minAmount')::numeric; upper_amount:=(f->>'maxAmount')::numeric;
 if lower_amount>upper_amount then raise exception using errcode='22023',message='최소 금액은 최대 금액 이하로 입력해 주세요.'; end if;
 if p_settings->>'enabled'='true' and jsonb_array_length(f->'keywords')=0 and jsonb_array_length(f->'categories')=0 and
    jsonb_array_length(f->'regions')=0 and jsonb_array_length(f->'licenses')=0 and jsonb_array_length(f->'agencies')=0 and
    jsonb_array_length(f->'contractMethods')=0 and f->>'useCompanyRegion'='false' and f->>'useCompanyLicenses'='false' and
    lower_amount is null and upper_amount is null and deadline_days is null then
   raise exception using errcode='22023',message='맞춤 알림 조건을 한 가지 이상 입력해 주세요.'; end if;
 -- Rebuild a fixed allowlist; supplied identity, timestamps and extra fields are ignored.
 result:=jsonb_build_object('enabled',p_settings->'enabled','notifyChanges',p_settings->'notifyChanges','pushEnabled',p_settings->'pushEnabled',
 'filter',jsonb_build_object('keywords',f->'keywords','excludeKeywords',f->'excludeKeywords','types',f->'types','categories',f->'categories',
 'regions',f->'regions','licenses',f->'licenses','minAmount',f->'minAmount','maxAmount',f->'maxAmount','includeUnknown',f->'includeUnknown','useCompanyRegion',f->'useCompanyRegion',
 'regionBasis',f->'regionBasis','agencies',f->'agencies','contractMethods',f->'contractMethods','minDaysUntilDeadline',f->'minDaysUntilDeadline','useCompanyLicenses',f->'useCompanyLicenses'));
 return result;
end $$;
commit;
