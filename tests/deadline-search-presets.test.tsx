import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
vi.mock('react', () => ({ useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, vi.fn()], useRef: (initial: unknown) => ({ current: initial }), useEffect: () => {} }));
import { LiveSearch } from '../src/live/LiveSearch';
function findPreset(element: unknown, label: string): ReactElement<{ onClick: () => void }> | null {
  if (Array.isArray(element)) return element.map(item => findPreset(item, label)).find(Boolean) ?? null;
  if (!element || typeof element !== 'object' || !('props' in element)) return null;
  const node = element as ReactElement<{ children?: unknown; onClick: () => void }>;
  if (node.type === 'button' && Array.isArray(node.props.children) && node.props.children.join('') === label) return node;
  return findPreset(node.props.children, label);
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-10-15T03:00:00Z')); });
afterEach(() => vi.useRealTimers());
it('a general one-month preset immediately searches both sides of today with the existing keyword', () => {
  const onSearch = vi.fn();
  const tree = LiveSearch({ query: { type: '공사', from: '2026-04-15', to: '2027-04-15', keyword: '철거' }, loading: false, onSearch, onRefresh: () => {} });
  findPreset(tree, '전후 1개월')!.props.onClick();
  expect(onSearch).toHaveBeenCalledWith({ type: '공사', from: '2026-09-15', to: '2026-11-15', keyword: '철거' });
});
