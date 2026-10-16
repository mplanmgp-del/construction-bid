import { describe, expect, it } from 'vitest';
import { readWon, readRate } from '../src/bid-helper/form';

describe('bid helper form values', () => {
  it('requires an explicit zero A value instead of treating a blank as zero', () => {
    expect(() => readWon('', 'A값')).toThrow('A값');
    expect(readWon('0', 'A값')).toBe(0);
  });
  it('reads whole won without silently repairing negative, fractional or unsafe inputs', () => {
    expect(readWon('134,541,000', '기초금액')).toBe(134541000);
    for (const value of ['-1', '1.5', '1원', 'NaN', '9007199254740992', '1,23']) {
      expect(() => readWon(value, '금액')).toThrow();
    }
  });
  it('preserves signed decimal percentages and rejects missing or non-finite rates', () => {
    expect(readRate('-3', '하한')).toBe(-3);
    expect(readRate('89.745', '낙찰하한율')).toBe(89.745);
    for (const value of ['', 'Infinity', '89.745%', '1e2']) expect(() => readRate(value, '비율')).toThrow();
  });
});
