import { describe, expect, it } from 'vitest';
import { buildComparisonRates, calculateScenario, WORKBOOK_EXAMPLE } from '../src/bid-helper/calculations';

describe('twelve bid comparison scenarios', () => {
  it('covers both limits and the current assumption with twelve distinct ascending rates', () => {
    const rates = buildComparisonRates(WORKBOOK_EXAMPLE.scenario);
    expect(rates).toHaveLength(12);
    expect(new Set(rates).size).toBe(12);
    expect(rates).toEqual([...rates].sort((left, right) => left - right));
    expect(rates[0]).toBe(97);
    expect(rates.at(-1)).toBe(103);
    expect(rates).toContain(100);
    const bids = rates.map(noticeRate => calculateScenario({ ...WORKBOOK_EXAMPLE.scenario, noticeRate }).bidAmount);
    expect(bids[0]).toBe(117_844_895);
    expect(bids.at(-1)).toBe(125_089_525);
    expect(bids[rates.indexOf(100)]).toBe(121_467_210);
    expect(bids).toEqual([...bids].sort((left, right) => left - right));
  });

  it.each([97, 103, 99.12345678])('keeps the exact current assumption %s even at a limit', noticeRate => {
    const rates = buildComparisonRates({ ...WORKBOOK_EXAMPLE.scenario, noticeRate });
    expect(rates).toHaveLength(12);
    expect(rates.filter(rate => rate === noticeRate)).toHaveLength(1);
    expect(rates.every(rate => rate >= 97 && rate <= 103)).toBe(true);
  });

  it('derives decimal limits without binary cancellation below the exact lower bound', () => {
    const input = { ...WORKBOOK_EXAMPLE.scenario, aValue: 0, rangeMin: -99.9, rangeMax: -99.7, noticeRate: 0.2 };
    const rates = buildComparisonRates(input);
    expect(rates).toHaveLength(12);
    expect(rates[0]).toBe(0.1);
    expect(rates.at(-1)).toBe(0.3);
    for (const noticeRate of rates) expect(calculateScenario({ ...input, noticeRate }).withinRange).toBe(true);
  });

  it('keeps narrow ranges unique at the supported input precision', () => {
    const rates = buildComparisonRates({ rangeMin: 0, rangeMax: 0.00000011, noticeRate: 100.00000005 });
    expect(rates).toHaveLength(12);
    expect(new Set(rates).size).toBe(12);
    expect(rates.every(rate => rate >= 100 && rate <= 100.00000011)).toBe(true);
    expect(rates).toContain(100.00000005);
  });

  it('does not repeat or fabricate rates when the range contains fewer distinct values', () => {
    expect(buildComparisonRates({ rangeMin: 0, rangeMax: 0, noticeRate: 100 })).toEqual([100]);
    expect(buildComparisonRates({ rangeMin: 0, rangeMax: 0.00000001, noticeRate: 100 })).toEqual([100, 100.00000001]);
  });

  it.each([
    { rangeMin: 1, rangeMax: -1, noticeRate: 100 },
    { rangeMin: -100, rangeMax: 3, noticeRate: 100 },
    { rangeMin: -3, rangeMax: 3, noticeRate: 104 },
    { rangeMin: -3, rangeMax: Number.POSITIVE_INFINITY, noticeRate: 100 },
  ])('rejects invalid comparison settings %j', input => {
    expect(() => buildComparisonRates(input)).toThrow(/예가|사정률/);
  });
});
