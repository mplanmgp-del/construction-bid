import type { G2bDetailSection, G2bNoticeDetail } from '../g2b-types';
import type { BidNotice } from '../types';

export interface BidHelperSeed {
  noticeId: string;
  title: string;
  number: string;
  revision: string;
  baseAmount?: number;
  lowerRate?: number;
  netCost?: number;
  rangeMin?: number;
  rangeMax?: number;
  aApplied?: boolean;
  notes: string[];
}

const TRANSFER_KEY = 'construction-bid.bid-helper.pending.v1';
type SeedStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const seedKeys = new Set(['noticeId', 'title', 'number', 'revision', 'baseAmount', 'lowerRate', 'netCost', 'rangeMin', 'rangeMax', 'aApplied', 'notes']);

function field(section: G2bDetailSection | undefined, key: string): string | null {
  const matches = section?.fields.filter(item => item.key === key) ?? [];
  return matches.length === 1 ? matches[0].value : null;
}

function amount(value: string | null): number | undefined {
  if (value === null) return undefined;
  const match = /^((?:\d+|\d{1,3}(?:,\d{3})+))\s*원$/.exec(value.trim());
  if (!match) return undefined;
  const result = Number(match[1].replaceAll(',', ''));
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}

function percentage(value: string | null, minimum: number): number | undefined {
  if (value === null) return undefined;
  const match = /^([+-]?\d+(?:\.\d+)?)%$/.exec(value.trim());
  if (!match) return undefined;
  const result = Number(match[1]);
  return Number.isFinite(result) && result >= minimum && result <= 100 ? result : undefined;
}

/** Seed only the exact revision's disclosed values. Missing values stay editable and empty. */
export function buildBidHelperSeed(bid: BidNotice, detail?: G2bNoticeDetail | null): BidHelperSeed {
  const seed: BidHelperSeed = { noticeId: bid.id, title: bid.title, number: bid.number, revision: bid.revision.padStart(3, '0'), notes: [] };
  if (!detail || detail.number !== bid.number || detail.revision !== bid.revision) {
    seed.notes.push('공고 원문에서 기초금액과 낙찰 하한율을 확인해 직접 입력하세요.');
    return seed;
  }
  const sections = detail.sections ?? [];
  const pricing = sections.filter(section => section.id === 'pricing');
  const lowerRate = pricing.length === 1 ? percentage(field(pricing[0], 'sucsfbidLwltRate'), 0) : undefined;
  if (lowerRate !== undefined && lowerRate > 0) seed.lowerRate = lowerRate;

  const disclosures = sections.filter(section => /^baseAmount(?:-\d+)?$/.test(section.id) && section.fields.some(item => item.key === 'bssamt'));
  if (disclosures.length > 1) {
    seed.notes.push('복수 기초금액 공개 내역이 있습니다. 적용할 공고 분류와 공개 시점을 확인해 금액을 직접 입력하세요.');
  } else if (disclosures.length === 1) {
    const base = disclosures[0];
    const values = {
      baseAmount: amount(field(base, 'bssamt')),
      netCost: amount(field(base, 'bssAmtPurcnstcst')),
      rangeMin: percentage(field(base, 'rsrvtnPrceRngBgnRate'), -100),
      rangeMax: percentage(field(base, 'rsrvtnPrceRngEndRate'), -100),
    };
    for (const key of ['baseAmount', 'netCost', 'rangeMin', 'rangeMax'] as const) {
      if (values[key] !== undefined) seed[key] = values[key];
    }
    if (seed.rangeMin !== undefined && seed.rangeMax !== undefined && seed.rangeMin > seed.rangeMax) {
      delete seed.rangeMin; delete seed.rangeMax;
      seed.notes.push('예가 변동폭의 공개 범위를 확인해 직접 입력하세요.');
    }
    const applied = field(base, 'bidPrceCalclAYn');
    if (applied === '예' || applied === '아니오') seed.aApplied = applied === '예';
  }
  if (seed.baseAmount === undefined) seed.notes.push('기초금액을 확인해 직접 입력하세요.');
  if (seed.lowerRate === undefined) seed.notes.push('적용할 낙찰 하한율을 확인해 직접 입력하세요.');
  seed.notes.push('A값 적용 시 공고 원문에서 확인한 금액을 직접 입력하세요.');
  return seed;
}

export function isBidHelperSeed(value: unknown): value is BidHelperSeed {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !seedKeys.has(key))) return false;
  const text = (item: unknown, maximum: number) => typeof item === 'string' && item.length > 0 && item.length <= maximum && !/[\u0000-\u001f\u007f]/.test(item);
  if (!text(row.noticeId, 160) || !text(row.title, 500)
    || typeof row.number !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(row.number)
    || typeof row.revision !== 'string' || !/^\d{3}$/.test(row.revision)
    || !Array.isArray(row.notes) || row.notes.length > 20 || !row.notes.every(item => text(item, 500))) return false;
  for (const key of ['baseAmount', 'netCost'] as const) {
    const item = row[key];
    if (item !== undefined && (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0)) return false;
  }
  for (const key of ['lowerRate', 'rangeMin', 'rangeMax'] as const) {
    const item = row[key];
    if (item !== undefined && (typeof item !== 'number' || !Number.isFinite(item) || item < (key === 'lowerRate' ? Number.MIN_VALUE : -100) || item > 100)) return false;
  }
  if (typeof row.rangeMin === 'number' && typeof row.rangeMax === 'number' && row.rangeMin > row.rangeMax) return false;
  return row.aApplied === undefined || typeof row.aApplied === 'boolean';
}

function browserStorage(): SeedStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage; } catch { return undefined; }
}

export function storePendingBidHelperSeed(seed: BidHelperSeed, storage: SeedStorage | undefined = browserStorage()): boolean {
  if (!storage || !isBidHelperSeed(seed)) return false;
  try { storage.setItem(TRANSFER_KEY, JSON.stringify({ version: 1, seed })); return true; } catch { return false; }
}

export function readPendingBidHelperSeed(storage: SeedStorage | undefined = browserStorage()): BidHelperSeed | undefined {
  try {
    const raw = storage?.getItem(TRANSFER_KEY);
    if (!raw || raw.length > 20_000) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const envelope = value as Record<string, unknown>;
    if (envelope.version !== 1 || Object.keys(envelope).some(key => key !== 'version' && key !== 'seed') || !isBidHelperSeed(envelope.seed)) return undefined;
    return envelope.seed;
  } catch { return undefined; }
}

export function clearPendingBidHelperSeed(storage: SeedStorage | undefined = browserStorage()): void {
  try { storage?.removeItem(TRANSFER_KEY); } catch { /* A blocked store must not prevent opening the helper. */ }
}
