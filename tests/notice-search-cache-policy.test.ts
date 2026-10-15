import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { G2bNoticePage } from '../src/g2b-types';

// This repository has no DOM test runtime. Run the hook's state/effect boundary
// locally while retaining its real cache, abort, age and request-option logic.
const hooks = vi.hoisted(() => {
  type Slot = { value?: unknown; dependencies?: unknown[]; cleanup?: () => void };
  const slots: Slot[] = [];
  let cursor = 0;
  let dirty = true;
  let effects: Array<() => void> = [];
  const changed = (before: unknown[] | undefined, after: unknown[]) => !before || before.length !== after.length || before.some((value, i) => !Object.is(value, after[i]));
  return {
    state<T>(initial: T | (() => T)) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? (initial as () => T)() : initial };
      return [slots[index].value as T, (next: T | ((value: T) => T)) => {
        const value = typeof next === 'function' ? (next as (value: T) => T)(slots[index].value as T) : next;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; }
      }] as const;
    },
    memo<T>(create: () => T, dependencies: unknown[]) {
      const index = cursor++;
      if (!slots[index] || changed(slots[index].dependencies, dependencies)) slots[index] = { value: create(), dependencies };
      return slots[index].value as T;
    },
    effect(create: () => void | (() => void), dependencies: unknown[]) {
      const index = cursor++;
      if (slots[index] && !changed(slots[index].dependencies, dependencies)) return;
      const previous = slots[index];
      const slot: Slot = { dependencies }; slots[index] = slot;
      effects.push(() => { previous?.cleanup?.(); const cleanup = create(); if (cleanup) slot.cleanup = cleanup; });
    },
    begin() { cursor = 0; dirty = false; },
    commit() { const pending = effects; effects = []; pending.forEach(effect => effect()); },
    isDirty: () => dirty,
    reset() { slots.forEach(slot => slot.cleanup?.()); slots.length = 0; cursor = 0; dirty = true; effects = []; },
  };
});

vi.mock('react', () => ({
  useState: hooks.state,
  useMemo: hooks.memo,
  useCallback: (callback: unknown, dependencies: unknown[]) => hooks.memo(() => callback, dependencies),
  useEffect: hooks.effect,
  useRef: (value: unknown) => hooks.memo(() => ({ current: value }), []),
}));
vi.mock('../src/live/notice-search', () => ({ fetchStartedNotices: vi.fn() }));

import { fetchStartedNotices } from '../src/live/notice-search';
import { ApiError } from '../src/live/client';
import { NOTICE_CACHE_FRESH_MS, NOTICE_CACHE_MAX_AGE_MS, writeNoticeCache } from '../src/live/notice-cache';
import { useLiveNotices } from '../src/live/useLiveNotices';

const query = { type: '공사·용역' as const, from: '2026-10-09', to: '2026-10-15', keyword: '철거' };
const now = Date.parse('2026-10-15T02:00:00Z');
const page = (age = 0): G2bNoticePage => ({ items: [], totalCount: 0, page: 1, pageSize: 0, hasMore: false, fetchedAt: new Date(Date.now() - age).toISOString(), source: '나라장터' });
const fetcher = vi.mocked(fetchStartedNotices);

function mount() {
  let current: ReturnType<typeof useLiveNotices>;
  const render = () => { hooks.begin(); current = useLiveNotices(true); hooks.commit(); };
  render();
  return {
    get current() { return current; },
    async settle() {
      for (let i = 0; i < 12; i++) { if (hooks.isDirty()) render(); await Promise.resolve(); }
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); hooks.reset(); fetcher.mockReset();
  const values = new Map<string, string>();
  vi.stubGlobal('window', { setTimeout, clearTimeout, localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  fetcher.mockImplementation(async () => page());
});
afterEach(() => { hooks.reset(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('ordinary search and explicit refresh cache policy', () => {
  it('reuses a fresh complete cache for the same normalized search without forcing provider calls', async () => {
    writeNoticeCache(query, page());
    const view = mount(); await view.settle();
    const version = view.current.queryVersion;
    expect(fetcher).not.toHaveBeenCalled();
    view.current.search({ ...query, keyword: '  철거  ' }); await view.settle();
    expect(fetcher).not.toHaveBeenCalled();
    expect(view.current.queryVersion).toBe(version);
    expect(view.current.meta?.fetchedAt).toBe(new Date(now).toISOString());
  });

  it('reevaluates a repeated search once its cache expires, using a normal request', async () => {
    writeNoticeCache(query, page());
    const view = mount(); await view.settle();
    vi.advanceTimersByTime(NOTICE_CACHE_FRESH_MS + 1);
    view.current.search({ ...query }); await view.settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][3]).toEqual({ force: false });
    expect(view.current.meta?.fetchedAt).toBe(new Date(Date.now()).toISOString());
  });

  it('forces only explicit refresh and returns to cache reuse on the next ordinary search', async () => {
    writeNoticeCache(query, page());
    const view = mount(); await view.settle();
    const version = view.current.queryVersion;
    view.current.refresh(); await view.settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][3]).toEqual({ force: true });
    expect(view.current.queryVersion).not.toBe(version);
    view.current.search(query); await view.settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses a normal request for a changed condition and aborts the previous request', async () => {
    writeNoticeCache(query, page());
    const view = mount(); await view.settle();
    fetcher.mockImplementation(() => new Promise(() => {}));
    view.current.refresh(); await view.settle();
    const pendingSignal = fetcher.mock.calls[0][1];
    view.current.search({ ...query, keyword: '해체' }); await view.settle();
    expect(pendingSignal.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0].keyword).toBe('해체');
    expect(fetcher.mock.calls[1][3]).toEqual({ force: false });
  });

  it('keeps an unexpired complete snapshot after a normal search failure', async () => {
    writeNoticeCache(query, page());
    const view = mount(); await view.settle();
    vi.advanceTimersByTime(NOTICE_CACHE_FRESH_MS + 1);
    fetcher.mockRejectedValueOnce(new Error('일시 오류'));
    view.current.search(query); await view.settle();
    expect(view.current.meta?.fetchedAt).toBe(new Date(now).toISOString());
    expect(view.current.error).toContain('이전 조회 결과를 표시합니다.');
    vi.advanceTimersByTime(NOTICE_CACHE_MAX_AGE_MS - NOTICE_CACHE_FRESH_MS);
    await view.settle();
    expect(view.current.meta).toBeNull();
  });

  it('still honors a rate-limit cooldown without automatically retrying the provider', async () => {
    writeNoticeCache(query, page());
    const view = mount(); await view.settle();
    vi.advanceTimersByTime(NOTICE_CACHE_FRESH_MS + 1);
    fetcher.mockRejectedValueOnce(new ApiError('호출 한도', 'G2B_QUOTA_EXCEEDED', 429, 30));
    view.current.search(query); await view.settle();
    expect(view.current.retryAt).toBe(Date.now() + 30_000);
    view.current.refresh(); await view.settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001); await view.settle();
    expect(view.current.retryAt).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    view.current.refresh(); await view.settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][3]).toEqual({ force: true });
  });
});
