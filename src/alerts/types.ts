import type { BidNotice, Category, CompanyProfile } from '../types.ts';
import type { ActiveCatalogStatus } from '../live/active-catalog-types.ts';

export type AlertRegionBasis = 'auto' | 'site' | 'participation' | 'either' | 'both';
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
  /** Absent fields in saved settings keep the previous matching behavior. */
  regionBasis?: AlertRegionBasis;
  agencies?: string[];
  contractMethods?: string[];
  minDaysUntilDeadline?: number | null;
  useCompanyLicenses?: boolean;
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
  /** Hash of canonical full description/documents/requirements retained by a compact source record. */
  sourceOmittedDigest?: string;
}
export interface AlertInboxItem {
  id: string;
  kind: AlertEventKind;
  notice: AlertNotice | null;
  message: string;
  changeFields: string[];
  createdAt: string;
  readAt: string | null;
  deletedAt?: string | null;
  existingCount?: number;
}
export interface AlertServiceStatus {
  catalog?: ActiveCatalogStatus;
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
  deletedNotifications?: AlertInboxItem[];
  deletedHasMore?: boolean;
  deletedCount?: number;
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
    categories: [], regions: [], licenses: [], minAmount: null, maxAmount: null, includeUnknown: true, useCompanyRegion: false,
    regionBasis: 'either', agencies: [], contractMethods: [], minDaysUntilDeadline: null, useCompanyLicenses: false },
  notifyChanges: true, pushEnabled: false, activatedAt: null, updatedAt: null,
};
