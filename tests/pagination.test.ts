import { describe, expect, it } from 'vitest';
import { pageItems } from '../src/pagination';

describe('compact pagination', () => {
  it('shows all pages for a short result', () => {
    expect(pageItems(1, 1)).toEqual([1]);
    expect(pageItems(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it('keeps the first, current and last pages reachable without an unbounded button row', () => {
    for (let current = 1; current <= 38; current++) {
      const items = pageItems(current, 38);
      expect(items.length).toBeLessThanOrEqual(7);
      expect(items).toContain(current);
      expect(items[0]).toBe(1);
      expect(items.at(-1)).toBe(38);
      const numbers = items.filter((item): item is number => typeof item === 'number');
      expect(numbers).toEqual([...new Set(numbers)].sort((a, b) => a - b));
    }
  });
});
