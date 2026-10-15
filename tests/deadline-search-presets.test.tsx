import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
const search = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('react', () => ({ useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, vi.fn()], useRef: (initial: unknown) => ({ current: initial }), useEffect: () => {} }));
vi.mock('../src/live/useCustomNotices', () => ({ useCustomNotices: () => ({ items: [], loading: false, error: '', hasMore: false, search, clear: vi.fn(), loadMore: vi.fn() }) }));
import { LiveSearch } from '../src/live/LiveSearch';
import { CustomNoticeSearch } from '../src/live/CustomNoticeSearch';
import { DEFAULT_ALERT_SETTINGS } from '../src/alerts/types';
import { DEMO_PROFILES } from '../src/data';
function findPreset(element: unknown, label: string): ReactElement<{ onClick: () => void }> | null {
  if (Array.isArray(element)) return element.map(item => findPreset(item, label)).find(Boolean) ?? null;
  if (!element || typeof element !== 'object' || !('props' in element)) return null;
  const node = element as ReactElement<{ children?: unknown; onClick: () => void }>;
  if (node.type === 'button' && Array.isArray(node.props.children) && node.props.children.join('') === label) return node;
  return findPreset(node.props.children, label);
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-10-15T03:00:00Z')); search.mockClear(); });
afterEach(() => vi.useRealTimers());
it('a general one-month preset immediately searches both sides of today with the existing keyword', () => {
  const onSearch = vi.fn();
  const tree = LiveSearch({ query: { type: '공사', from: '2026-04-15', to: '2027-04-15', keyword: '철거' }, loading: false, onSearch, onRefresh: () => {} });
  findPreset(tree, '전후 1개월')!.props.onClick();
  expect(onSearch).toHaveBeenCalledWith({ type: '공사', from: '2026-09-15', to: '2026-11-15', keyword: '철거' });
});
it('a custom three-month preset immediately queries the new dates rather than the old state', () => {
  const tree = CustomNoticeSearch({ userId: 'a', settings: structuredClone(DEFAULT_ALERT_SETTINGS), profile: DEMO_PROFILES[0], profileReady: true,
    bookmarks: [], onBookmark: () => {}, onOpen: () => {}, onEditConditions: () => {}, onGeneralSearch: () => {}, onLogin: () => {} });
  findPreset(tree, '전후 3개월')!.props.onClick();
  expect(search).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-07-15', to: '2027-01-15', basis: 'deadline' }));
});
