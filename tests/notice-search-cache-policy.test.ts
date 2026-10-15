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
vi.mock('../src/live/client', async original => ({ ...await original<typeof import('../src/live/client')>(), fetchApi: vi.fn() }));

import { fetchApi } from '../src/live/client';
import { NOTICE_CACHE_KEY } from '../src/live/notice-cache';
import { useLiveNotices } from '../src/live/useLiveNotices';

const now = Date.parse('2026-10-15T02:00:00Z');
const page = (): G2bNoticePage => ({ items: [], totalCount: 0, page: 1, pageSize: 100, hasMore: false, fetchedAt: new Date(Date.now()).toISOString(), source: '나라장터' });
const fetcher = vi.mocked(fetchApi);
function mount(enabled = true) {
  let current: ReturnType<typeof useLiveNotices>;
  const render = () => { hooks.begin(); current = useLiveNotices(enabled); hooks.commit(); };
  render();
  return { get current() { return current; }, async settle() {
    for (let i = 0; i < 60; i++) { if (hooks.isDirty()) render(); await Promise.resolve(); }
  } };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); hooks.reset(); fetcher.mockReset();
  const values = new Map<string,string>();
  // Old start-date responses must not seed the new deadline query or result list.
  values.set('construction-bid:public-start-notices:v1', JSON.stringify([{ key: JSON.stringify(['공사','2020-01-01','2020-01-07','철거']), savedAt: now, page: page() }]));
  vi.stubGlobal('window', { setTimeout, clearTimeout, localStorage: { getItem: (key:string) => values.get(key) ?? null, setItem: (key:string,value:string) => values.set(key,value), removeItem: (key:string) => values.delete(key) } });
  fetcher.mockImplementation(async () => page());
});
afterEach(() => { hooks.reset(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('indexed deadline search lifecycle', () => {
  it('defaults to today before and after six calendar months and accepts an empty keyword', async () => {
    const view = mount(); await view.settle();
    expect(view.current.query).toEqual({ type: '공사·용역', from: '2026-04-15', to: '2027-04-15', keyword: '' });
    expect(view.current.requiresKeyword).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [path] of fetcher.mock.calls) {
      const url = new URL(path, 'https://test.local');
      expect(url.pathname).toBe('/api/notices'); expect(url.searchParams.get('mode')).toBe('deadline');
      expect(url.searchParams.get('from')).toBe('2026-04-15'); expect(url.searchParams.get('to')).toBe('2027-04-15');
    }
    expect(NOTICE_CACHE_KEY).toContain('deadline'); expect(view.current.meta?.hasMore).toBe(false);
  });
  it('does no general search while disabled, including when displaying saved interests', async () => {
    const view = mount(false); await view.settle(); expect(fetcher).not.toHaveBeenCalled(); expect(view.current.items).toEqual([]);
  });
  it('aborts a previous index request when the keyword or date interval changes', async () => {
    fetcher.mockImplementation(() => new Promise(() => {}));
    const view = mount(); await view.settle(); const signal = fetcher.mock.calls[0][1]!;
    view.current.search({ type: '공사', from: '2026-09-15', to: '2026-11-15', keyword: '철거' }); await view.settle();
    expect(signal.aborted).toBe(true);
    const url = new URL(fetcher.mock.calls.at(-1)![0], 'https://test.local');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ mode: 'deadline', from: '2026-09-15', to: '2026-11-15', keyword: '철거', type: '공사' });
  });
  it('exposes an index failure without inventing a completed empty search', async () => {
    fetcher.mockRejectedValue(new Error('색인 연결 실패'));
    const view = mount(); await view.settle(); expect(view.current.error).toContain('색인 연결 실패');
    expect(view.current.hasMore).toBe(true); expect(view.current.loading).toBe(false); expect(view.current.meta).toBeNull();
  });
  it('queries a repeated user search afresh instead of restoring old start-date cache data', async () => {
    const view = mount(); await view.settle(); expect(fetcher).toHaveBeenCalledTimes(2);
    view.current.search({ ...view.current.query }); await view.settle(); expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.every(([path]) => !path.includes('notices-start'))).toBe(true);
  });
});
