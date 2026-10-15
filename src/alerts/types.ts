import type { BidNotice, Category, CompanyProfile } from '../types.ts';

export interface AlertFilter {
  keywords: string[];
  excludeKeywords: string[];
  types: ('공사' | '용역')[];
  categories: Category[];
  regions: string[];
  licenses: string[];
  minAmount: number | null;
  maxAmount: number | null;
  includeUnknown: boolean;
  useCompanyRegion: boolean;
}
export interface AlertSettings {
  enabled: boolean;
  filter: AlertFilter;
  notifyChanges: boolean;
  pushEnabled: boolean;
  activatedAt: string | null;
  updatedAt: string | null;
}
export type AlertEventKind = 'initial' | 'new' | 'changed' | 'cancelled' | 'test';
export interface AlertNotice extends BidNotice {
  sourceUpdatedAt: string;
  regionComplete: boolean;
  licenseComplete: boolean;
}
export interface AlertInboxItem {
  id: string;
  kind: AlertEventKind;
  notice: AlertNotice | null;
  message: string;
  changeFields: string[];
  createdAt: string;
  readAt: string | null;
  existingCount?: number;
}
export interface AlertServiceStatus {
  configured: boolean;
  lastCheckedAt: string | null;
  coverageFrom: string | null;
  backfillPending: boolean;
  error: string | null;
  paused: boolean;
  pushConfigured: boolean;
}
export interface AlertOverview {
  settings: AlertSettings;
  notifications: AlertInboxItem[];
  unreadCount: number;
  hasMore: boolean;
  existingMatches: AlertNotice[];
  existingHasMore: boolean;
  status: AlertServiceStatus;
  subscriptionCount: number;
  publicKey: string | null;
}
export interface BrowserPushSubscription {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}
export interface AlertMatch {
  matched: boolean;
  reasons: string[];
  needsReview: boolean;
}
export interface WorkerRule {
  userId: string;
  settings: AlertSettings;
  profile: CompanyProfile | null;
}
export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  enabled: false,
  filter: { keywords: ['철거', '해체', '석면', '건설폐기물'], excludeKeywords: [], types: ['공사', '용역'],
    categories: [], regions: [], licenses: [], minAmount: null, maxAmount: null, includeUnknown: true, useCompanyRegion: false },
  notifyChanges: true, pushEnabled: false, activatedAt: null, updatedAt: null,
};
