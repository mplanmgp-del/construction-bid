import { describe, expect, it } from 'vitest';
import { buildDrawRates, drawScenario, WORKBOOK_EXAMPLE } from '../src/bid-helper/calculations';

describe('ten thousand candidate rate draw', () => {
  it('creates exactly ten thousand distinct ascending rates including both limits', () => {
    const rates = buildDrawRates({ rangeMin: -2, rangeMax: 2 });
    expect(rates).toHaveLength(10_000);
    expect(new Set(rates).size).toBe(10_000);
    expect(rates[0]).toBe(98);
    expect(rates[1]).toBe(98.00040004);
    expect(rates.at(-1)).toBe(102);
    expect(rates.every((rate, index) => index === 0 || rate > rates[index - 1])).toBe(true);
    expect(rates.every(rate => rate >= 98 && rate <= 102)).toBe(true);
  });

  it('supports the narrowest range with ten thousand distinct eight-decimal rates', () => {
    const rates = buildDrawRates({ rangeMin: 0, rangeMax: 0.00009999 });
    expect(new Set(rates).size).toBe(10_000);
    expect(rates[0]).toBe(100);
    expect(rates[1]).toBe(100.00000001);
    expect(rates.at(-1)).toBe(100.00009999);
  });

  it('does not lose an exact lower limit through decimal cancellation', () => {
    const rates = buildDrawRates({ rangeMin: -99.9, rangeMax: -99.7 });
    expect(rates[0]).toBe(0.1);
    expect(rates.at(-1)).toBe(0.3);
    expect(new Set(rates).size).toBe(10_000);
  });

  it.each([
    { rangeMin: 0, rangeMax: 0 }, { rangeMin: 0, rangeMax: 0.00009998 },
    { rangeMin: 2, rangeMax: -2 }, { rangeMin: -100, rangeMax: 3 },
    { rangeMin: Number.NaN, rangeMax: 3 }, { rangeMin: -3, rangeMax: Number.POSITIVE_INFINITY },
    { rangeMin: 0, rangeMax: 0.001000001 },
    { rangeMin: 1e16, rangeMax: 1e16 + 2 },
  ])('rejects a range that cannot represent ten thousand supported distinct rates: %j', input => {
    expect(() => buildDrawRates(input)).toThrow(/예가|10,000|소수/);
  });

  it('selects the first candidate and calculates its exact A-adjusted bid', () => {
    const draw = drawScenario(WORKBOOK_EXAMPLE.scenario, () => 0);
    expect(draw.candidateIndex).toBe(0);
    expect(draw.noticeRate).toBe(97);
    expect(draw.result.plannedPrice).toBe(130_504_770);
    expect(draw.result.bidAmount).toBe(117_844_895);
  });

  it('rejects the biased uint32 remainder then can select the last candidate', () => {
    const words = [4_294_967_295, 4_294_960_000, 4_294_959_999];
    let consumed = 0;
    const draw = drawScenario(WORKBOOK_EXAMPLE.scenario, () => words[consumed++]);
    expect(consumed).toBe(3);
    expect(draw.candidateIndex).toBe(9_999);
    expect(draw.noticeRate).toBe(103);
    expect(draw.result.bidAmount).toBe(125_089_525);
  });

  it('draws from the new range independently of a previous assumption', () => {
    const draw = drawScenario({ ...WORKBOOK_EXAMPLE.scenario, rangeMin: 1, rangeMax: 2 }, () => 5_000);
    expect(draw.candidateIndex).toBe(5_000);
    expect(draw.noticeRate).toBe(101.50005001);
    expect(draw.result.withinRange).toBe(true);
  });

  it('allows the same candidate on successive independent draws', () => {
    expect(drawScenario(WORKBOOK_EXAMPLE.scenario, () => 12_345).noticeRate)
      .toBe(drawScenario(WORKBOOK_EXAMPLE.scenario, () => 12_345).noticeRate);
  });

  it('rejects unusable input before consuming randomness', () => {
    let consumed = false;
    expect(() => drawScenario({ ...WORKBOOK_EXAMPLE.scenario, aValue: 132_000_000 }, () => { consumed = true; return 0; })).toThrow(/A값/);
    expect(consumed).toBe(false);
  });

  it.each([-1, 4_294_967_296, 0.5, Number.NaN])('rejects an invalid random source word %s', word => {
    expect(() => drawScenario(WORKBOOK_EXAMPLE.scenario, () => word)).toThrow(/무작위/);
  });
});
