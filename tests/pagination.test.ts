import { describe, expect, it } from 'vitest';
import { pageGroup } from '../src/pagination';

describe('ten-page groups', () => {
  it('keeps pages 1 through 10 in the first group', () => {
    for (const current of [1, 5, 10]) {
      expect(pageGroup(current, 38)).toEqual({ items: [1,2,3,4,5,6,7,8,9,10], previous: null, next: 11 });
    }
  });
  it('moves arrows between the first pages of adjacent groups', () => {
    expect(pageGroup(11, 38)).toEqual({ items: [11,12,13,14,15,16,17,18,19,20], previous: 1, next: 21 });
    expect(pageGroup(20, 38).next).toBe(21);
    expect(pageGroup(21, 38).previous).toBe(11);
  });
  it('does not offer nonexistent pages at the end', () => {
    expect(pageGroup(38, 38)).toEqual({ items: [31,32,33,34,35,36,37,38], previous: 21, next: null });
    expect(pageGroup(10, 10).next).toBeNull();
    expect(pageGroup(1, 1)).toEqual({ items: [1], previous: null, next: null });
    expect(pageGroup(11, 13)).toEqual({ items: [11,12,13], previous: 1, next: null });
  });
});
