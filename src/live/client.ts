import type { BidNotice } from '../types';

export function koreanToday(now = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function recentDates(days: number, now = new Date()): { from: string; to: string } {
  return { from: koreanToday(new Date(now.getTime() - (days - 1) * 86_400_000)), to: koreanToday(now) };
}

export function dateRangeError(from: string, to: string, maxDays: number): string | null {
  const parse = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value).toISOString().slice(0, 10) === value ? Date.parse(value) : NaN;
  let start: number, end: number;
  try { start = parse(from); end = parse(to); } catch { return '조회 시작일과 종료일을 선택해 주세요.'; }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '조회 시작일과 종료일을 선택해 주세요.';
  if (end < start) return '종료일은 시작일 이후여야 합니다.';
  return (end - start) / 86_400_000 >= maxDays ? `한 번에 최대 ${maxDays}일을 조회할 수 있습니다.` : null;
}

export function safeG2bUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return undefined;
    return url.hostname === 'g2b.go.kr' || url.hostname.endsWith('.g2b.go.kr') ? url.href : undefined;
  } catch { return undefined; }
}

export function mergeById<T extends { id: string }>(previous: T[], next: T[]): T[] {
  return [...new Map([...previous, ...next].map(item => [item.id, item])).values()];
}

export function currentNotice(bid: BidNotice, now = new Date()): BidNotice {
  if (bid.source !== 'live' || bid.status === '취소' || !bid.deadline) return bid;
  const deadline = Date.parse(bid.deadline);
  return Number.isFinite(deadline) && deadline < now.getTime() ? { ...bid, status: '마감' } : bid;
}

export async function fetchApi<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, headers: { Accept: 'application/json' } });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.error) throw new Error(data?.error?.message || '나라장터 데이터를 가져오지 못했습니다. 잠시 후 다시 조회해 주세요.');
  return data as T;
}
