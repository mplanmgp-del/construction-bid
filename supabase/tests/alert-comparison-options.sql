-- Transactional assertions for a disposable/local Supabase database only.
-- Apply member-workspaces.sql, menu-access.sql, alerts.sql and the comparison
-- options migration first. No cron, provider calls, or production data is used.
begin;

do $$ declare preferences jsonb; normalized jsonb; filter_value jsonb; field_name text; bad_value jsonb; begin
 preferences:=bid_alert_private.defaults();
 assert preferences#>>'{filter,regionBasis}'='either', 'new rules compare either location basis by default';
 assert preferences#>'{filter,agencies}'='[]'::jsonb, 'new agency condition is empty';
 assert preferences#>'{filter,contractMethods}'='[]'::jsonb, 'new contract condition is empty';
 assert preferences#>'{filter,minDaysUntilDeadline}'='null'::jsonb, 'new deadline condition is unset';
 assert preferences#>>'{filter,useCompanyLicenses}'='false', 'company license matching is opt in';

 -- A literal pre-extension payload must retain its original regional meaning.
 preferences:='{"enabled":true,"filter":{"keywords":["철거"],"excludeKeywords":[],"types":["공사","용역"],"categories":[],"regions":[],"licenses":[],"minAmount":null,"maxAmount":null,"includeUnknown":true,"useCompanyRegion":false},"notifyChanges":true,"pushEnabled":false}'::jsonb;
 normalized:=bid_alert_private.validate_settings(preferences);
 assert normalized#>>'{filter,regionBasis}'='auto', 'legacy rules preserve the old regional interpretation';
 assert normalized#>'{filter,agencies}'='[]'::jsonb and normalized#>'{filter,contractMethods}'='[]'::jsonb, 'legacy rules acquire empty optional arrays';
 assert normalized#>'{filter,minDaysUntilDeadline}'='null'::jsonb and normalized#>>'{filter,useCompanyLicenses}'='false', 'legacy rules acquire safe optional values';
 assert bid_alert_private.validate_settings(normalized)=normalized, 'legacy normalization is stable across resave';

 filter_value:=preferences->'filter';
 filter_value:=filter_value||'{"regionBasis":"both","agencies":["서울시"," 경기도 ","서울시"],"contractMethods":["제한경쟁"," 일반경쟁 ","제한경쟁"],"minDaysUntilDeadline":7,"useCompanyLicenses":true}'::jsonb;
 normalized:=bid_alert_private.validate_settings(jsonb_set(preferences,'{filter}',filter_value));
 assert normalized#>>'{filter,regionBasis}'='both', 'explicit region comparison survives normalization';
 assert normalized#>'{filter,agencies}'='["경기도","서울시"]'::jsonb, 'agencies are trimmed sorted and deduplicated';
 assert normalized#>'{filter,contractMethods}'='["일반경쟁","제한경쟁"]'::jsonb, 'contract methods are trimmed sorted and deduplicated';
 assert normalized#>>'{filter,minDaysUntilDeadline}'='7' and normalized#>>'{filter,useCompanyLicenses}'='true', 'deadline and license conditions survive normalization';
 assert bid_alert_private.validate_settings(normalized)=normalized, 'new settings round trip without losing comparison fields';

 foreach field_name in array array['auto','site','participation','either','both'] loop
   normalized:=bid_alert_private.validate_settings(jsonb_set(preferences,'{filter,regionBasis}',to_jsonb(field_name)));
   assert normalized#>>'{filter,regionBasis}'=field_name, 'all supported regional bases are accepted';
 end loop;

 for bad_value in select value from jsonb_array_elements('[null,true,1,"unknown",{},[]]'::jsonb) loop
   begin
     perform bid_alert_private.validate_settings(jsonb_set(preferences,'{filter,regionBasis}',bad_value));
     assert false, 'invalid region basis must be rejected';
   exception when invalid_parameter_value then null; end;
 end loop;
 for bad_value in select value from jsonb_array_elements('[null,"true",1,{},[]]'::jsonb) loop
   begin
     perform bid_alert_private.validate_settings(jsonb_set(preferences,'{filter,useCompanyLicenses}',bad_value));
     assert false, 'license matching must be a non-null boolean';
   exception when invalid_parameter_value then null; end;
 end loop;
 foreach field_name in array array['agencies','contractMethods'] loop
   for bad_value in select value from jsonb_array_elements('[null,"서울시",1,true,{},[null],[1],[""],["  "],["줄\n바꿈"]]'::jsonb) loop
     begin
       perform bid_alert_private.validate_settings(jsonb_set(preferences,array['filter',field_name],bad_value));
       assert false, 'agency and contract arrays reject wrong types and invalid strings';
     exception when invalid_parameter_value then null; end;
   end loop;
   begin
     perform bid_alert_private.validate_settings(jsonb_set(preferences,array['filter',field_name],jsonb_build_array(repeat('가',101))));
     assert false, 'agency and contract entries are limited to 100 characters';
   exception when invalid_parameter_value then null; end;
   begin
     select jsonb_agg(to_jsonb('기관'||n)) into bad_value from generate_series(1,21) n;
     perform bid_alert_private.validate_settings(jsonb_set(preferences,array['filter',field_name],bad_value));
     assert false, 'agency and contract arrays are limited to 20 entries';
   exception when invalid_parameter_value then null; end;
   select jsonb_agg(to_jsonb('기관'||n)) into bad_value from generate_series(1,20) n;
   normalized:=bid_alert_private.validate_settings(jsonb_set(preferences,array['filter',field_name],bad_value));
   assert jsonb_array_length(normalized#>array['filter',field_name])=20, '20 entries are accepted';
   normalized:=bid_alert_private.validate_settings(jsonb_set(preferences,array['filter',field_name],jsonb_build_array(repeat('가',100))));
   assert length(normalized#>>array['filter',field_name,'0'])=100, '100 character entries are accepted';
 end loop;
 for bad_value in select value from jsonb_array_elements('[-1,366,1.5,"7",true,{},[]]'::jsonb) loop
   begin
     perform bid_alert_private.validate_settings(jsonb_set(preferences,'{filter,minDaysUntilDeadline}',bad_value));
     assert false, 'deadline days require an integer from 0 through 365 or null';
   exception when invalid_parameter_value then null; end;
 end loop;
 for bad_value in select value from jsonb_array_elements('[null,0,365]'::jsonb) loop
   normalized:=bid_alert_private.validate_settings(jsonb_set(preferences,'{filter,minDaysUntilDeadline}',bad_value));
   assert normalized#>'{filter,minDaysUntilDeadline}'=bad_value, 'nullable and boundary deadline values are accepted';
 end loop;

 -- Each added match condition may independently bound an enabled rule.
 preferences:=jsonb_set(preferences,'{filter,keywords}','[]');
 foreach field_name in array array['agencies','contractMethods','minDaysUntilDeadline','useCompanyLicenses'] loop
   bad_value:=case field_name when 'agencies' then '["서울시"]'::jsonb when 'contractMethods' then '["제한경쟁"]'::jsonb when 'minDaysUntilDeadline' then '0'::jsonb else 'true'::jsonb end;
   normalized:=bid_alert_private.validate_settings(jsonb_set(preferences,array['filter',field_name],bad_value));
   assert normalized->>'enabled'='true', 'each additional condition can bound an enabled rule';
 end loop;
 begin
   perform bid_alert_private.validate_settings(jsonb_set(preferences,'{filter,regionBasis}','"either"'));
   assert false, 'region basis alone does not bound a rule';
 exception when invalid_parameter_value then null; end;
end $$;

-- Exercise the actual owner RPC so fixed allowlists cannot silently discard fields.
insert into auth.users(id,email) values ('33333333-3333-4333-8333-333333333333','comparison-options@example.invalid');
set local role authenticated;
set local request.jwt.claim.sub='33333333-3333-4333-8333-333333333333';
do $$ declare preferences jsonb; result jsonb; begin
 result:=public.bid_alert_user('get','{}');
 preferences:=jsonb_set(result->'settings','{enabled}','true');
 preferences:=jsonb_set(preferences,'{filter}',(preferences->'filter')||'{"regionBasis":"participation","agencies":["서울시"],"contractMethods":["제한경쟁"],"minDaysUntilDeadline":3,"useCompanyLicenses":true}'::jsonb);
 perform public.bid_alert_user('save',jsonb_build_object('settings',preferences));
 result:=public.bid_alert_user('get','{}');
 assert result#>'{settings,filter}' @> '{"regionBasis":"participation","agencies":["서울시"],"contractMethods":["제한경쟁"],"minDaysUntilDeadline":3,"useCompanyLicenses":true}'::jsonb, 'owner save and get preserve all new comparison options';
end $$;
reset role;
rollback;
