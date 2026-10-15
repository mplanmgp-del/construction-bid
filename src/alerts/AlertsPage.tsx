import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Bell, BellRing, CheckCheck, ChevronRight, CircleAlert, Clock3, Save, Search, Settings2 } from 'lucide-react';
import { CATEGORIES, type Category, type CompanyProfile } from '../types';
import { formatDateTime, formatPrice } from '../domain';
import { DEFAULT_ALERT_SETTINGS, type AlertFilter, type AlertNotice, type AlertSettings } from './types';
import type { AlertsAccess } from './useAlerts';
import { BrowserPushControls } from './BrowserPushControls';
import { BookmarkButton } from '../components/BookmarkButton';
import { matchAlarmNotice, normalizeAlertSettings } from './domain';
import { deadlineDayWindow } from '../notice-deadline-window';
import './alerts.css';

interface AlertForm {
  enabled: boolean; notifyChanges: boolean; keywords: string; excludeKeywords: string;
  types: ('공사' | '용역')[]; categories: Category[]; regions: string; licenses: string;
  minAmount: string; maxAmount: string; includeUnknown: boolean; useCompanyRegion: boolean;
  regionBasis: NonNullable<AlertFilter['regionBasis']>; agencies: string; contractMethods: string;
  minDaysUntilDeadline: string; useCompanyLicenses: boolean;
}
function formFromSettings(settings: AlertSettings): AlertForm {
  const filter = settings.filter;
  return { enabled: settings.enabled, notifyChanges: settings.notifyChanges, keywords: filter.keywords.join(', '), excludeKeywords: filter.excludeKeywords.join(', '),
    types: [...filter.types], categories: [...filter.categories], regions: filter.regions.join(', '), licenses: filter.licenses.join(', '),
    minAmount: filter.minAmount === null ? '' : String(filter.minAmount), maxAmount: filter.maxAmount === null ? '' : String(filter.maxAmount), includeUnknown: filter.includeUnknown, useCompanyRegion: filter.useCompanyRegion,
    regionBasis: filter.regionBasis ?? 'auto', agencies: (filter.agencies ?? []).join(', '), contractMethods: (filter.contractMethods ?? []).join(', '),
    minDaysUntilDeadline: filter.minDaysUntilDeadline == null ? '' : String(filter.minDaysUntilDeadline), useCompanyLicenses: filter.useCompanyLicenses ?? false };
}
const splitValues = (text: string) => [...new Set(text.split(/[,\n]+/).map(value => value.trim()).filter(Boolean))];
const timeLabel = (value: string | null) => value ? formatDateTime(value, { includeYear: true }) : '아직 확인 전';
function noticeHref(notice: AlertNotice): string {
  return `/notice-detail.html?${new URLSearchParams({ number: notice.number, revision: notice.revision, type: notice.type })}`;
}

export function AlertsPage({ alerts, signedIn, onLogin, profile = null, isAdmin = false, demo = false, initialFilter, onInitialFilterConsumed, openExistingRequest = 0, bookmarks = [], onBookmark, onSearch, initialSettings, onInitialSettingsConsumed }: {
  alerts: AlertsAccess; signedIn: boolean; onLogin: () => void; profile?: CompanyProfile | null; isAdmin?: boolean; demo?: boolean; initialFilter?: AlertFilter | null; onInitialFilterConsumed?: () => void; openExistingRequest?: number; bookmarks?: string[]; onBookmark?: (notice: AlertNotice) => void; onSearch?: (settings: AlertSettings) => void; initialSettings?: AlertSettings | null; onInitialSettingsConsumed?: () => void;
}) {
  const settings = alerts.overview?.settings ?? DEFAULT_ALERT_SETTINGS;
  const [form, setForm] = useState<AlertForm>(() => formFromSettings(settings));
  const [formError, setFormError] = useState('');
  const [showExisting, setShowExisting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const editVersion = useRef(0);
  const existingRef = useRef<HTMLDetailsElement>(null);
  const firstInput = useRef<HTMLInputElement>(null);
  const incomingKey = JSON.stringify(formFromSettings(settings));
  useEffect(() => { if (signedIn && !demo) void alerts.refresh(); }, [alerts.userId, alerts.refresh, signedIn, demo]);
  useEffect(() => {
    if (!dirtyRef.current) setForm(formFromSettings(settings));
  }, [incomingKey]);
  useEffect(() => {
    setForm(formFromSettings(settings)); dirtyRef.current = false; setDirty(false); editVersion.current++;
    setFormError(''); setShowExisting(false);
  }, [alerts.userId]);
  useEffect(() => {
    if (!initialFilter) return;
    setForm(formFromSettings({ ...settings, enabled: true, filter: initialFilter }));
    dirtyRef.current = true; setDirty(true); editVersion.current++; setFormError('');
    onInitialFilterConsumed?.();
  }, [initialFilter]);
  useEffect(() => {
    if (!initialSettings) return;
    setForm(formFromSettings(initialSettings)); dirtyRef.current = true; setDirty(true); editVersion.current++; setFormError('');
    onInitialSettingsConsumed?.();
  }, [initialSettings]);
  const update = <K extends keyof AlertForm>(key: K, value: AlertForm[K]) => { dirtyRef.current = true; setDirty(true); editVersion.current++; setForm(previous => ({ ...previous, [key]: value })); setFormError(''); };
  function readSettings(forLookup = false): AlertSettings {
    const filter: AlertFilter = { keywords: splitValues(form.keywords), excludeKeywords: splitValues(form.excludeKeywords), types: form.types, categories: form.categories,
      regions: splitValues(form.regions), licenses: splitValues(form.licenses), minAmount: form.minAmount.trim() ? Number(form.minAmount) : null, maxAmount: form.maxAmount.trim() ? Number(form.maxAmount) : null,
      includeUnknown: form.includeUnknown, useCompanyRegion: form.useCompanyRegion, regionBasis: form.regionBasis,
      agencies: splitValues(form.agencies), contractMethods: splitValues(form.contractMethods), minDaysUntilDeadline: form.minDaysUntilDeadline.trim() ? Number(form.minDaysUntilDeadline) : null, useCompanyLicenses: form.useCompanyLicenses };
    const normalized = normalizeAlertSettings({ ...settings, enabled: forLookup || form.enabled, notifyChanges: form.notifyChanges, filter });
    return { ...normalized, enabled: form.enabled };
  }
  function showFormError(error: unknown) { setFormError(error instanceof Error ? error.message : '알림 조건을 확인해 주세요.'); firstInput.current?.focus(); }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const submittedVersion = editVersion.current;
    let nextSettings: AlertSettings;
    try { nextSettings = readSettings(); } catch (error) { showFormError(error); return; }
    const result = await alerts.save(nextSettings);
    if (result && editVersion.current === submittedVersion) { dirtyRef.current = false; setDirty(false); }
  }
  function lookup() { try { onSearch?.(readSettings(true)); } catch (error) { showFormError(error); } }
  useEffect(() => {
    if (openExistingRequest <= 0 || !signedIn || demo) return;
    setShowExisting(true);
    const timer = window.setTimeout(() => existingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
    return () => window.clearTimeout(timer);
  }, [openExistingRequest, alerts.userId, signedIn, demo]);
  if (demo) return <section className="alerts-page"><div className="alerts-page-heading"><h1>알림 조건</h1></div><div className="alerts-login panel"><Bell size={32} /><h2>실제 공고 알림은 회원 모드에서 이용할 수 있습니다.</h2><p>예시 공고는 서버 알림에 포함되지 않습니다.</p></div></section>;
  if (!signedIn) return <section className="alerts-page"><div className="alerts-page-heading"><div><div className="eyebrow">내 업체에 맞는 공고</div><h1>알림 조건</h1></div></div><div className="alerts-login panel"><BellRing size={34} /><h2>관심 조건을 저장하고 새 공고를 받아보세요.</h2><p>로그인하면 알림 조건과 받은 알림을 기기 간에 이어서 사용할 수 있습니다.</p><button type="button" className="button button-primary" onClick={onLogin}>로그인하고 알림 받기<ChevronRight size={16} /></button></div></section>;

  const overview = alerts.overview;
  const status = overview?.status;
  const busy = alerts.saving || alerts.settingUp;
  const now=Date.now(),alarmWindow=deadlineDayWindow(7,now);
  const existingMatches=overview?.existingMatches.filter(notice=>matchAlarmNotice(notice,settings,profile,now).matched)??[];
  const existingCount = existingMatches.length;
  return <section className="alerts-page">
    <div className="alerts-page-heading"><div><div className="eyebrow">내 업체에 맞는 공고를 자동으로</div><h1>알림 조건</h1><p>제출 마감일이 오늘 앞뒤 7일인 진행중·마감 임박·예정 공고를 약 10분마다 확인합니다. 개찰이 완료된 공고는 새 알림에서 제외합니다.</p></div></div>
    {alerts.error && <div className="alerts-feedback alerts-feedback-error" role="alert"><CircleAlert size={17} /><span>{alerts.error}</span></div>}
    {alerts.message && !alerts.error && <div className="alerts-feedback" role="status"><CheckCheck size={17} /><span>{alerts.message}</span></div>}
    {!overview && <div className="alerts-loading panel" role="status">{alerts.loading ? '회원의 알림 정보를 불러오고 있습니다.' : '알림 정보를 불러오지 못했습니다. 잠시 후 자동으로 다시 확인합니다.'}</div>}
    {status && <div className={`alerts-service-status panel${status.paused || status.error || !status.configured ? ' alerts-service-attention' : ''}`}>
      <div><span className={`alerts-status-dot${status.configured && settings.enabled && !status.paused && !status.error ? ' is-active' : ''}`} /><strong>{!status.configured ? '서버 알림 설정 필요' : !settings.enabled ? '내 알림 꺼짐' : status.paused ? '수집 일시 중지' : status.error ? '공고 확인 지연' : !status.lastCheckedAt ? '첫 공고 확인 대기' : '서버에서 공고 확인 중'}</strong></div>
      <dl><div><dt>마지막 확인</dt><dd>{timeLabel(status.lastCheckedAt)}</dd></div><div><dt>확인 범위</dt><dd>제출 마감 기준 {alarmWindow.from} ~ {alarmWindow.to}</dd></div></dl>
      {status.catalog && <p>완료한 구간 {status.catalog.completedSources.toLocaleString()}개 · 남은 구간 {status.catalog.pendingSources.toLocaleString()}개 · 상세 확인 대기 {status.catalog.pendingVerification.toLocaleString()}건</p>}
      {status.backfillPending && <p>약 1,000건씩 읽어 조건에 맞는 공고만 보관합니다. 완료한 구간부터 기존 공고에 표시하며, 중단되어도 처리 위치에서 이어집니다.</p>}
      {status.error && <p role="status">{status.error}</p>}
      {!status.configured && <p>서버 연결을 완료해야 브라우저가 닫혀 있어도 공고를 확인할 수 있습니다.</p>}
      {isAdmin && <button type="button" className="button button-secondary" disabled={busy} onClick={() => { void alerts.setup(); }}><Settings2 size={15} /><span>{alerts.settingUp ? '서버 설정 중' : '서버 알림 설정'}</span></button>}
    </div>}
    <div className="alerts-layout">
      <div className="alerts-main">
        <details ref={existingRef} className="alerts-existing panel" open={showExisting} onToggle={event => setShowExisting(event.currentTarget.open)}>
          <summary><div><Clock3 size={18} /><strong>조건에 맞는 기존 공고</strong><span>{existingCount}건{overview?.existingHasMore ? '+' : ''}</span></div><ChevronRight size={17} /></summary>
          <div className="alerts-existing-body"><p className="alerts-help">오늘 앞뒤 7일의 제출 마감 범위에서 개찰 전 공고를 확인합니다. 제출은 마감되었어도 개찰을 기다리는 공고는 포함됩니다.</p>
            {existingMatches.length === 0 && <p className="alerts-help">{status?.backfillPending ? '기존 공고 확인이 진행 중입니다.' : '현재 저장한 조건에 맞는 기존 공고가 없습니다.'}</p>}
            {existingMatches.map(notice => {
              const comparison=matchAlarmNotice(notice,settings,profile,now);
              return <article key={notice.id} className="alerts-existing-notice"><span>{notice.type} · {notice.number}-{notice.revision}</span><a href={noticeHref(notice)} target="_blank" rel="noopener noreferrer">{notice.title}<ChevronRight size={15} /></a><p>{notice.agency}</p><div><span>{notice.province} {notice.district}</span><strong>{formatPrice(notice.estimatedPrice)}</strong><span>마감 {timeLabel(notice.deadline)}</span></div>
                <div className={`alerts-comparison${comparison.needsReview?' needs-review':''}`} aria-label="현재 저장한 조건 비교"><strong>{comparison.matched?comparison.needsReview?'조건 확인 필요':'저장 조건 일치':'현재 저장한 조건과 다름'}</strong>{comparison.matched&&<p>{comparison.reasons.join(' · ')}</p>}</div>
                {onBookmark && <div className="alerts-existing-actions"><BookmarkButton noticeTitle={notice.title} saved={bookmarks.includes(notice.id)} onToggle={() => onBookmark(notice)} /></div>}
              </article>;
            })}
            {overview?.existingHasMore && <button type="button" className="button button-secondary alerts-load-more" disabled={alerts.loadingExisting || alerts.loading} onClick={() => { void alerts.loadExisting(); }}>{alerts.loadingExisting ? '불러오는 중' : '기존 공고 더 보기'}</button>}
          </div>
        </details>
      </div>
      <aside className="alerts-settings-column">
        <form className="alerts-settings panel" onSubmit={event => { void save(event); }} aria-labelledby="alerts-settings-heading">
          <div className="alerts-section-heading"><div><Settings2 size={19} /><h2 id="alerts-settings-heading">내 알림 조건</h2></div>{dirty && <span className="alerts-dirty">저장 전</span>}</div>
          <fieldset disabled={!overview || busy}>
            <label className="alerts-checkbox alerts-enabled"><input type="checkbox" checked={form.enabled} onChange={event => update('enabled', event.target.checked)} /><span><strong>알림 받기</strong><small>새 공고를 내 알림함에 보관합니다.</small></span></label>
            <label className="alerts-field"><span>관심 검색어 <small>쉼표로 구분 · 하나 이상 일치</small></span><input ref={firstInput} className="field" name="keywords" value={form.keywords} maxLength={1000} placeholder="철거, 해체, 석면" onChange={event => update('keywords', event.target.value)} /></label>
            <label className="alerts-field"><span>제외 검색어</span><input className="field" name="excludeKeywords" value={form.excludeKeywords} maxLength={1000} placeholder="설계, 감리" onChange={event => update('excludeKeywords', event.target.value)} /></label>
            <div className="alerts-field"><span>업무 구분</span><div className="alerts-check-options">{(['공사', '용역'] as const).map(type => <label className="alerts-checkbox" key={type}><input type="checkbox" checked={form.types.includes(type)} onChange={() => update('types', form.types.includes(type) ? form.types.filter(value => value !== type) : [...form.types, type])} />{type}</label>)}</div></div>
            <details className="alerts-category-options"><summary>관심 분야 <span>{form.categories.length ? `${form.categories.length}개 선택` : '전체 분야'}</span></summary><div>{CATEGORIES.map(category => <label className="alerts-checkbox" key={category}><input type="checkbox" checked={form.categories.includes(category)} onChange={() => update('categories', form.categories.includes(category) ? form.categories.filter(value => value !== category) : [...form.categories, category])} />{category}</label>)}</div></details>
            <label className="alerts-field"><span>지역 <small>쉼표로 구분 · 비워두면 전체</small></span><input className="field" name="regions" value={form.regions} maxLength={1000} placeholder="서울특별시, 경기도 성남시" onChange={event => update('regions', event.target.value)} /></label>
            <label className="alerts-field"><span>지역 비교 기준</span><select className="field" name="regionBasis" value={form.regionBasis} onChange={event => update('regionBasis', event.target.value as AlertForm['regionBasis'])} aria-describedby="alerts-region-help">
              <option value="auto">업무별 기본</option><option value="site">현장 위치</option><option value="participation">참가 가능 지역</option><option value="either">현장·참가 지역 중 하나</option><option value="both">현장·참가 지역 모두</option>
            </select></label>
            <p id="alerts-region-help" className="alerts-help">공사·용역 모두 현장 위치와 참가 가능 지역을 선택해 비교합니다. 업무별 기본은 공사 현장 위치, 용역 참가 가능 지역입니다. 현장 위치가 제공되지 않은 공고는 확인이 필요합니다.</p>
            <label className="alerts-field"><span>업종·면허 <small>쉼표로 구분 · 비워두면 전체</small></span><input className="field" name="licenses" value={form.licenses} maxLength={1000} placeholder="구조물해체·비계공사업" onChange={event => update('licenses', event.target.value)} /></label>
            <label className="alerts-field"><span>발주·수요기관 <small>쉼표로 구분 · 기관명 일부 일치</small></span><input className="field" name="agencies" value={form.agencies} maxLength={1000} placeholder="성남시, 한국환경공단" onChange={event => update('agencies', event.target.value)} /></label>
            <label className="alerts-field"><span>계약방법 <small>쉼표로 구분 · 방법명 일치</small></span><input className="field" name="contractMethods" value={form.contractMethods} maxLength={1000} placeholder="제한경쟁, 일반경쟁, 수의계약" onChange={event => update('contractMethods', event.target.value)} /></label>
            <div className="alerts-field"><span>추정가격 범위</span><div className="alerts-amounts"><label><span className="sr-only">최소 추정가격</span><input className="field" type="number" name="minAmount" min="0" step="1" value={form.minAmount} placeholder="최소 금액" onChange={event => update('minAmount', event.target.value)} /></label><span>~</span><label><span className="sr-only">최대 추정가격</span><input className="field" type="number" name="maxAmount" min="0" step="1" value={form.maxAmount} placeholder="최대 금액" onChange={event => update('maxAmount', event.target.value)} /></label><span>원</span></div></div>
            <label className="alerts-field"><span>제출 마감까지 최소 남은 일수 <small>0~365일 · 비워두면 제한 없음</small></span><input className="field" type="number" name="minDaysUntilDeadline" min="0" max="365" step="1" value={form.minDaysUntilDeadline} placeholder="예: 3" onChange={event => update('minDaysUntilDeadline', event.target.value)} /></label>
            {Number(form.minDaysUntilDeadline)>7&&<p className="alerts-form-error" role="status">최소 남은 일수가 7일을 초과하면 자동 알림의 앞뒤 7일 범위에 맞는 공고가 없습니다. 알림을 받으려면 이 조건을 7일 이하로 조정하거나 비워 주세요.</p>}
            <label className="alerts-checkbox"><input type="checkbox" checked={form.useCompanyRegion} onChange={event => update('useCompanyRegion', event.target.checked)} /><span>등록한 내 업체 소재지로 참가 지역 비교</span></label>
            <label className="alerts-checkbox"><input type="checkbox" name="useCompanyLicenses" checked={form.useCompanyLicenses} onChange={event => update('useCompanyLicenses', event.target.checked)} aria-describedby="alerts-license-help" /><span>등록한 내 업체 보유 면허와 관련 있는 공고 비교</span></label>
            <p id="alerts-license-help" className="alerts-help">보유 면허 중 하나가 관련 있는 공고를 찾습니다. 복수 면허 조합 등 최종 참가 자격은 공고 원문을 확인해 주세요.</p>
            <label className="alerts-checkbox"><input type="checkbox" checked={form.includeUnknown} onChange={event => update('includeUnknown', event.target.checked)} /><span>선택 조건의 정보가 미확인인 공고도 포함</span></label>
            <label className="alerts-checkbox"><input type="checkbox" checked={form.notifyChanges} onChange={event => update('notifyChanges', event.target.checked)} /><span>진행중·마감 임박·예정 공고의 중요한 변경도 알림 받기</span></label>
            <p className="alerts-help">검색어·분야·지역·면허·기관·계약방법·가격·남은 일수 중 조건을 하나 이상 정해 주세요. 서로 다른 조건은 모두 충족해야 하며, 같은 입력란의 여러 값은 하나 이상 일치하면 됩니다. 최종 참가 자격과 제출 일정은 공고 원문을 확인해 주세요.</p>
            {formError && <p className="alerts-form-error" role="alert">{formError}</p>}
            {onSearch && <button type="button" className="button button-secondary alerts-query-button" onClick={lookup}><Search size={16} />맞춤 조회</button>}
            <button type="submit" className="button button-primary alerts-save"><Save size={16} /><span>{alerts.saving ? '저장 중' : '알림 조건 저장'}</span></button>
          </fieldset>
        </form>
        {overview && <div className="alerts-push panel"><BrowserPushControls publicKey={overview.publicKey} configured={overview.status.pushConfigured} enabled={overview.settings.enabled} onChanged={async () => { await alerts.refresh(); }} disabled={busy} /></div>}
      </aside>
    </div>
  </section>;
}
