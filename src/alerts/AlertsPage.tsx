import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Bell, BellRing, CheckCheck, ChevronRight, CircleAlert, Clock3, RefreshCw, Save, Settings2 } from 'lucide-react';
import { CATEGORIES, type Category } from '../types';
import { formatDateTime, formatPrice } from '../domain';
import { DEFAULT_ALERT_SETTINGS, type AlertFilter, type AlertInboxItem, type AlertNotice, type AlertSettings } from './types';
import type { AlertsAccess } from './useAlerts';
import { BrowserPushControls } from './BrowserPushControls';
import { normalizeAlertSettings } from './domain';
import './alerts.css';

export function AlertBell({ unreadCount, onOpen, disabled = false }: { unreadCount: number; onOpen: () => void; disabled?: boolean }) {
  const count = Math.max(0, unreadCount);
  return <button type="button" className="alerts-bell" onClick={onOpen} disabled={disabled} aria-label={count ? `알림, 읽지 않은 알림 ${count}개` : '알림'} title={disabled ? '예시 모드에서는 알림을 사용할 수 없습니다.' : '내 알림'}>
    <Bell size={21} aria-hidden="true" />{count > 0 && <span className="alerts-unread-badge" aria-hidden="true">{count > 99 ? '99+' : count}</span>}
  </button>;
}

interface AlertForm {
  enabled: boolean; notifyChanges: boolean; keywords: string; excludeKeywords: string;
  types: ('공사' | '용역')[]; categories: Category[]; regions: string; licenses: string;
  minAmount: string; maxAmount: string; includeUnknown: boolean; useCompanyRegion: boolean;
}
function formFromSettings(settings: AlertSettings): AlertForm {
  const filter = settings.filter;
  return { enabled: settings.enabled, notifyChanges: settings.notifyChanges, keywords: filter.keywords.join(', '), excludeKeywords: filter.excludeKeywords.join(', '),
    types: [...filter.types], categories: [...filter.categories], regions: filter.regions.join(', '), licenses: filter.licenses.join(', '),
    minAmount: filter.minAmount === null ? '' : String(filter.minAmount), maxAmount: filter.maxAmount === null ? '' : String(filter.maxAmount), includeUnknown: filter.includeUnknown, useCompanyRegion: filter.useCompanyRegion };
}
const splitValues = (text: string) => [...new Set(text.split(/[,\n]+/).map(value => value.trim()).filter(Boolean))];
const timeLabel = (value: string | null) => value ? formatDateTime(value) : '아직 확인 전';
const eventLabels: Record<AlertInboxItem['kind'], string> = { initial: '첫 알림', new: '새 공고', changed: '주요 변경', cancelled: '취소', test: '테스트' };
function noticeHref(notice: AlertNotice): string {
  return `/notice-detail.html?${new URLSearchParams({ number: notice.number, revision: notice.revision, type: notice.type })}`;
}

export function AlertsPage({ alerts, signedIn, onLogin, isAdmin = false, demo = false, initialFilter, onInitialFilterConsumed }: {
  alerts: AlertsAccess; signedIn: boolean; onLogin: () => void; isAdmin?: boolean; demo?: boolean; initialFilter?: AlertFilter | null; onInitialFilterConsumed?: () => void;
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
  const update = <K extends keyof AlertForm>(key: K, value: AlertForm[K]) => { dirtyRef.current = true; setDirty(true); editVersion.current++; setForm(previous => ({ ...previous, [key]: value })); setFormError(''); };
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const minAmount = form.minAmount.trim() ? Number(form.minAmount) : null;
    const maxAmount = form.maxAmount.trim() ? Number(form.maxAmount) : null;
    const keywords = splitValues(form.keywords);
    const submittedVersion = editVersion.current;
    const filter: AlertFilter = { keywords, excludeKeywords: splitValues(form.excludeKeywords), types: form.types, categories: form.categories,
      regions: splitValues(form.regions), licenses: splitValues(form.licenses), minAmount, maxAmount, includeUnknown: form.includeUnknown, useCompanyRegion: form.useCompanyRegion };
    let nextSettings: AlertSettings;
    try { nextSettings = normalizeAlertSettings({ ...settings, enabled: form.enabled, notifyChanges: form.notifyChanges, filter }); }
    catch (error) { setFormError(error instanceof Error ? error.message : '알림 조건을 확인해 주세요.'); firstInput.current?.focus(); return; }
    const result = await alerts.save(nextSettings);
    // Preserve edits made while the request was in progress.
    if (result && editVersion.current === submittedVersion) { dirtyRef.current = false; setDirty(false); }
  }
  function openExisting() {
    setShowExisting(true);
    window.setTimeout(() => existingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  }
  if (demo) return <section className="alerts-page"><div className="alerts-page-heading"><h1>내 알림</h1></div><div className="alerts-login panel"><Bell size={32} /><h2>실제 공고 알림은 회원 모드에서 이용할 수 있습니다.</h2><p>예시 공고는 서버 알림에 포함되지 않습니다.</p></div></section>;
  if (!signedIn) return <section className="alerts-page"><div className="alerts-page-heading"><div><div className="eyebrow">내 업체에 맞는 공고</div><h1>내 알림</h1></div></div><div className="alerts-login panel"><BellRing size={34} /><h2>관심 조건을 저장하고 새 공고를 받아보세요.</h2><p>로그인하면 알림 조건과 받은 알림을 기기 간에 이어서 사용할 수 있습니다.</p><button type="button" className="button button-primary" onClick={onLogin}>로그인하고 알림 받기<ChevronRight size={16} /></button></div></section>;

  const overview = alerts.overview;
  const status = overview?.status;
  const busy = alerts.saving || alerts.settingUp;
  const existingCount = overview?.existingMatches.length ?? 0;
  return <section className="alerts-page">
    <div className="alerts-page-heading"><div><div className="eyebrow">새 공고와 중요한 변경을 한곳에</div><h1>내 알림</h1><p>저장한 조건을 서버에서 약 10분마다 확인합니다.</p></div><button type="button" className="button button-secondary" disabled={alerts.loading || busy} onClick={() => { void alerts.refresh(); }}><RefreshCw size={15} className={alerts.loading ? 'alerts-spinning' : ''} />{alerts.loading ? '확인 중' : '새로고침'}</button></div>
    {alerts.error && <div className="alerts-feedback alerts-feedback-error" role="alert"><CircleAlert size={17} /><span>{alerts.error}</span></div>}
    {alerts.message && !alerts.error && <div className="alerts-feedback" role="status"><CheckCheck size={17} /><span>{alerts.message}</span></div>}
    {!overview && <div className="alerts-loading panel" role="status">{alerts.loading ? '회원의 알림 정보를 불러오고 있습니다.' : '알림 정보를 불러오지 못했습니다. 새로고침으로 다시 확인해 주세요.'}</div>}
    {status && <div className={`alerts-service-status panel${status.paused || status.error || !status.configured ? ' alerts-service-attention' : ''}`}>
      <div><span className={`alerts-status-dot${status.configured && settings.enabled && !status.paused && !status.error ? ' is-active' : ''}`} /><strong>{!status.configured ? '서버 알림 설정 필요' : status.paused ? '수집 일시 중지' : status.error ? '공고 확인 지연' : !settings.enabled ? '내 알림 꺼짐' : !status.lastCheckedAt ? '첫 공고 확인 대기' : '서버에서 공고 확인 중'}</strong></div>
      <dl><div><dt>마지막 확인</dt><dd>{timeLabel(status.lastCheckedAt)}</dd></div><div><dt>확인 범위</dt><dd>{status.coverageFrom ? `${timeLabel(status.coverageFrom)} 이후` : '수집 시작 대기'}</dd></div></dl>
      {status.backfillPending && <p>기존 공고를 확인하고 있습니다. 확인이 끝난 공고부터 표시됩니다.</p>}
      {status.error && <p role="status">{status.error}</p>}
      {!status.configured && <p>서버 연결을 완료해야 브라우저가 닫혀 있어도 공고를 확인할 수 있습니다.</p>}
      {isAdmin && <button type="button" className="button button-secondary" disabled={busy} onClick={() => { void alerts.setup(); }}><Settings2 size={15} />{alerts.settingUp ? '서버 설정 중' : '서버 알림 설정'}</button>}
    </div>}
    <div className="alerts-layout">
      <div className="alerts-main">
        <section className="alerts-inbox panel" aria-labelledby="alerts-inbox-heading">
          <div className="alerts-section-heading"><div><Bell size={19} /><h2 id="alerts-inbox-heading">받은 알림 <span>{overview?.unreadCount ?? 0}</span></h2></div><button className="text-button" type="button" disabled={!overview?.unreadCount || alerts.reading} onClick={() => { void alerts.read({ all: true }); }}><CheckCheck size={15} />모두 읽음</button></div>
          {overview && overview.notifications.length === 0 && <div className="alerts-empty"><Bell size={28} /><h3>아직 받은 알림이 없습니다.</h3><p>{settings.enabled ? '조건에 맞는 공고가 확인되면 이곳에 표시됩니다.' : '알림 조건을 저장하고 알림 받기를 켜주세요.'}</p></div>}
          <ol className="alerts-inbox-list">{overview?.notifications.map(item => <li key={item.id} className={`alerts-event${item.readAt ? '' : ' is-unread'}`}>
            <div className="alerts-event-top"><span className={`alerts-event-kind is-${item.kind}`}>{eventLabels[item.kind]}</span><time dateTime={item.createdAt}>{timeLabel(item.createdAt)}</time>{!item.readAt && <span className="alerts-unread-dot" aria-label="읽지 않음" />}</div>
            {item.notice && <a className="alerts-event-title" href={noticeHref(item.notice)} target="_blank" rel="noopener noreferrer" onClick={() => { if (!item.readAt) void alerts.read({ id: item.id }); }}>{item.notice.title}</a>}
            <p>{item.message}</p>
            {item.changeFields.length > 0 && <div className="alerts-change-fields" aria-label="변경 항목">{item.changeFields.map((field, index) => <span key={`${field}-${index}`}>{field}</span>)}</div>}
            <div className="alerts-event-actions">{item.kind === 'initial' && <button type="button" className="text-button" onClick={openExisting}>기존 공고 {item.existingCount ?? 0}건 보기<ChevronRight size={14} /></button>}{!item.readAt && <button type="button" className="text-button" disabled={alerts.reading} onClick={() => { void alerts.read({ id: item.id }); }}>읽음으로 표시</button>}</div>
          </li>)}</ol>
          {overview?.hasMore && <button type="button" className="button button-secondary alerts-load-more" disabled={alerts.loadingMore || alerts.loading} onClick={() => { void alerts.loadMore(); }}>{alerts.loadingMore ? '불러오는 중' : '이전 알림 더 보기'}</button>}
        </section>
        <details ref={existingRef} className="alerts-existing panel" open={showExisting} onToggle={event => setShowExisting(event.currentTarget.open)}>
          <summary><div><Clock3 size={18} /><strong>조건에 맞는 기존 공고</strong><span>{existingCount}건{overview?.existingHasMore ? '+' : ''}</span></div><ChevronRight size={17} /></summary>
          <div className="alerts-existing-body"><p className="alerts-help">알림을 켤 때 이미 있던 공고를 함께 확인할 수 있습니다.</p>
            {overview?.existingMatches.length === 0 && <p className="alerts-help">{status?.backfillPending ? '기존 공고 확인이 진행 중입니다.' : '현재 저장한 조건에 맞는 기존 공고가 없습니다.'}</p>}
            {overview?.existingMatches.map(notice => <article key={notice.id} className="alerts-existing-notice"><span>{notice.type} · {notice.number}-{notice.revision}</span><a href={noticeHref(notice)} target="_blank" rel="noopener noreferrer">{notice.title}<ChevronRight size={15} /></a><p>{notice.agency}</p><div><span>{notice.province} {notice.district}</span><strong>{formatPrice(notice.estimatedPrice)}</strong><span>마감 {timeLabel(notice.deadline)}</span></div></article>)}
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
            <p className="alerts-help">공사는 현장 위치, 용역은 참가 가능 지역으로 비교합니다.</p>
            <label className="alerts-field"><span>업종·면허 <small>쉼표로 구분 · 비워두면 전체</small></span><input className="field" name="licenses" value={form.licenses} maxLength={1000} placeholder="구조물해체·비계공사업" onChange={event => update('licenses', event.target.value)} /></label>
            <div className="alerts-field"><span>추정가격 범위</span><div className="alerts-amounts"><label><span className="sr-only">최소 추정가격</span><input className="field" type="number" name="minAmount" min="0" step="1" value={form.minAmount} placeholder="최소 금액" onChange={event => update('minAmount', event.target.value)} /></label><span>~</span><label><span className="sr-only">최대 추정가격</span><input className="field" type="number" name="maxAmount" min="0" step="1" value={form.maxAmount} placeholder="최대 금액" onChange={event => update('maxAmount', event.target.value)} /></label><span>원</span></div></div>
            <label className="alerts-checkbox"><input type="checkbox" checked={form.useCompanyRegion} onChange={event => update('useCompanyRegion', event.target.checked)} /><span>등록한 내 업체 소재지로 참가 지역 비교</span></label>
            <label className="alerts-checkbox"><input type="checkbox" checked={form.includeUnknown} onChange={event => update('includeUnknown', event.target.checked)} /><span>지역·면허·가격 미확인 공고도 포함</span></label>
            <label className="alerts-checkbox"><input type="checkbox" checked={form.notifyChanges} onChange={event => update('notifyChanges', event.target.checked)} /><span>정정·취소 등 중요한 변경도 알림 받기</span></label>
            <p className="alerts-help">관심 검색어·분야·지역·면허·가격 중 조건을 하나 이상 정해 주세요. 최종 참가 자격과 제출 일정은 공고 원문을 확인해 주세요.</p>
            {formError && <p className="alerts-form-error" role="alert">{formError}</p>}
            <button type="submit" className="button button-primary alerts-save"><Save size={16} />{alerts.saving ? '저장 중' : '알림 조건 저장'}</button>
          </fieldset>
        </form>
        {overview && <div className="alerts-push panel"><BrowserPushControls publicKey={overview.publicKey} configured={overview.status.pushConfigured} enabled={overview.settings.enabled} onChanged={async () => { await alerts.refresh(); }} disabled={busy} /></div>}
      </aside>
    </div>
  </section>;
}
