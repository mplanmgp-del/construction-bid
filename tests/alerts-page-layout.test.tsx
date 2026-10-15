import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AlertsPage } from '../src/alerts/AlertsPage';
import { DEFAULT_ALERT_SETTINGS, type AlertOverview } from '../src/alerts/types';
import type { AlertsAccess } from '../src/alerts/useAlerts';
import { NOTICES } from '../src/data';

function access(): AlertsAccess {
  const overview: AlertOverview = {
    settings: { ...structuredClone(DEFAULT_ALERT_SETTINGS), enabled: true }, unreadCount: 1, hasMore: false,
    notifications: [{ id: 'inbox-only', kind: 'test', notice: null, message: '이 내용은 종 버튼 알림창에만 표시합니다.', changeFields: [], createdAt: '', readAt: null }],
    existingMatches: [{ ...NOTICES[0], id: 'existing-card', title: '설정에 맞는 기존 공고', sourceUpdatedAt: '', regionComplete: true, licenseComplete: true }], existingHasMore: false,
    status: { configured: true, lastCheckedAt: null, coverageFrom: null, backfillPending: false, error: null, paused: false, pushConfigured: false },
    subscriptionCount: 0, publicKey: null,
  };
  return { userId: 'member-a', overview, loading: false, loadingMore: false, loadingExisting: false, saving: false, reading: false, settingUp: false, error: null, message: '',
    refresh: async () => true, save: async () => true, read: async () => true, setup: async () => true, loadMore: async () => true, loadExisting: async () => true };
}

describe('alert settings page after inbox moves to the bell', () => {
  it('removes the large inbox panel and its notification content from the page', () => {
    const html = renderToStaticMarkup(<AlertsPage alerts={access()} signedIn onLogin={() => {}} />);
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
