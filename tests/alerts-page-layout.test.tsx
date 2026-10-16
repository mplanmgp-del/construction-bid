import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlertsPage } from '../src/alerts/AlertsPage';
import { DEFAULT_ALERT_SETTINGS, type AlertOverview } from '../src/alerts/types';
import type { AlertsAccess } from '../src/alerts/useAlerts';
import { NOTICES } from '../src/data';

function access(): AlertsAccess {
  const overview: AlertOverview = {
    settings: { ...structuredClone(DEFAULT_ALERT_SETTINGS), enabled: true }, unreadCount: 1, hasMore: false,
    notifications: [{ id: 'inbox-only', kind: 'test', notice: null, message: '이 내용은 종 버튼 알림창에만 표시합니다.', changeFields: [], createdAt: '', readAt: null }],
    existingMatches: [{ ...NOTICES[0], id: 'existing-card', title: '설정에 맞는 기존 공고 · 철거', source:'live',status:'접수중',deadline:new Date(Date.now()+2*86400000).toISOString(),openingAt:new Date(Date.now()+3*86400000).toISOString(), sourceUpdatedAt: '', regionComplete: true, licenseComplete: true }], existingHasMore: false,
    status: { configured: true, lastCheckedAt: null, coverageFrom: null, backfillPending: false, error: null, paused: false, pushConfigured: false },
    subscriptionCount: 0, publicKey: null,
  };
  return { userId: 'member-a', overview, loading: false, loadingMore: false, loadingExisting: false, saving: false, reading: false, settingUp: false, error: null, message: '',
    refresh: async () => true, save: async () => true, read: async () => true, remove: async () => true, restore: async () => true, loadDeleted: async () => true, setup: async () => true, loadMore: async () => true, loadExisting: async () => true };
}

describe('alert settings page after inbox moves to the bell', () => {
  it('removes the large inbox panel and its notification content from the page', () => {
    const html = renderToStaticMarkup(<AlertsPage alerts={access()} signedIn onLogin={() => {}} />);
    expect(html).not.toContain('새로고침');
    expect(html).not.toContain('alerts-inbox');
    expect(html).not.toContain('이 내용은 종 버튼 알림창에만 표시합니다.');
    expect(html).toContain('<h1>알림 조건</h1>');
  });

  it('retains editable conditions, existing notices, collection status and push controls', () => {
    const html = renderToStaticMarkup(<AlertsPage alerts={access()} signedIn onLogin={() => {}} />);
    expect(html).toContain('name="keywords"');
    expect(html).toContain('알림 조건 저장');
    expect(html).toContain('조건에 맞는 기존 공고');
    expect(html).toContain('설정에 맞는 기존 공고');
    expect(html).toContain('/notice-detail.html?number=');
    expect(html).toContain('첫 공고 확인 대기');
    expect(html).toContain('alerts-push');
  });
});


it('keeps alert condition saving without a removed custom lookup entry',()=>{
  const html=renderToStaticMarkup(<AlertsPage alerts={access()} signedIn onLogin={()=>{}}/>);
  expect(html).not.toContain('맞춤 조회');expect(html).toContain('알림 조건 저장');
});

it('shows ongoing alarms without a fixed deadline range while final notice verification is pending', () => {
  const state=access();
  state.overview!.status={...state.overview!.status,backfillPending:true,catalog:{groupCount:3,activeCount:3,pendingSources:0,pendingVerification:1,completedSources:746,coverageFrom:'1995-10-01',bootstrapComplete:true,lastCheckedAt:null,error:null,storageBytes:65536,storageCeiling:16777216}};
  const html=renderToStaticMarkup(<AlertsPage alerts={state} signedIn onLogin={()=>{}} />);
  expect(html).toContain('마감일 제한 없이');
  expect(html).not.toContain('앞뒤 7일');
  expect(html).not.toContain('전체 제공 연도');
  expect(html).toContain('상세 확인 대기 1건');
});

afterEach(()=>vi.useRealTimers());
it('hides opened cached notices while retaining matching ongoing notices beyond seven days',()=>{
  vi.useFakeTimers();vi.setSystemTime('2026-10-15T10:00:00+09:00');
  const state=access(),base=state.overview!.existingMatches[0];
  state.overview!.existingMatches=[base,{...base,id:'opened',title:'이미 개찰한 공고',openingAt:'2026-10-15T09:00:00+09:00'},
    {...base,id:'future',title:'내년 석면 해체공사',deadline:'2027-10-23T10:00:00+09:00',openingAt:'2027-10-24T11:00:00+09:00'}];
  const html=renderToStaticMarkup(<AlertsPage alerts={state} signedIn onLogin={()=>{}} />);
  expect(html).toContain('설정에 맞는 기존 공고');
  expect(html).not.toContain('이미 개찰한 공고');
  expect(html).toContain('내년 석면 해체공사');
});

it('hides cached existing cards that no longer match the saved personal conditions',()=>{
  const state=access(),base=state.overview!.existingMatches[0];
  state.overview!.existingMatches=[base,{...base,id:'unrelated',title:'현재 조건과 관련 없는 사무용품 구매'}];
  const html=renderToStaticMarkup(<AlertsPage alerts={state} signedIn onLogin={()=>{}} />);
  expect(html).not.toContain('현재 조건과 관련 없는 사무용품 구매');
});

it('preserves a saved minimum lead time without an obsolete seven-day warning',()=>{
  const state=access();state.overview!.settings.filter.minDaysUntilDeadline=365;
  const html=renderToStaticMarkup(<AlertsPage alerts={state} signedIn onLogin={()=>{}} />);
  expect(html).not.toContain('최소 남은 일수가 7일을 초과');
  expect(html).toContain('value="365"');
});
