import { describe, expect, it } from 'vitest';
import {
  calculateAnalysis, calculateScenario, WORKBOOK_EXAMPLE,
  type BidHelperInput, type ScenarioInput,
} from '../src/bid-helper/calculations';

const analysis: BidHelperInput = {
  baseAmount: 134_541_000, aValue: 7_054_014, plannedPrice: 134_323_075,
  bidAmount: 121_290_200, lowerRate: 89.745,
};
const scenario: ScenarioInput = {
  baseAmount: 134_541_000, aValue: 7_054_014, lowerRate: 89.745,
  noticeRate: 100, targetRate: 89.745, rangeMin: -3, rangeMax: 3,
};

describe('bid helper opening analysis', () => {
  it('reproduces active workbook cells using the A-adjusted inversion', () => {
    const result = calculateAnalysis(analysis);
    expect(result.lowerPrice).toBe(121_271_633);
    expect(result.minimumBidAmount).toBe(121_271_633);
    expect(result.simpleBidRate).toBeCloseTo(90.29736700116492, 10);
    expect(result.adjustedBidRate).toBeCloseTo(89.75958893890166, 10);
    expect(result.noticeRate).toBeCloseTo(99.83802335347589, 10);
    expect(result.companyRate).toBeCloseTo(99.85340070817678, 10);
    expect(result.rateDifference).toBeCloseTo(0.0153773547008881, 12);
    expect(result.meetsLowerRate).toBe(true);
    expect(result.withinPlannedPrice).toBe(true);
  });

  it('does not add a won when a decimal lower rate gives an exact integer', () => {
    const result = calculateAnalysis({ baseAmount: 100_000_000, aValue: 0, plannedPrice: 100_000_000, bidAmount: 90_000_000, lowerRate: 90 });
    expect(result.lowerPrice).toBe(90_000_000);
    expect(result.meetsLowerRate).toBe(true);
    expect(result.companyRate).toBe(100);
  });

  it('keeps below-lower and above-planned conditions separate', () => {
    expect(calculateAnalysis({ ...analysis, bidAmount: 121_271_632 }).meetsLowerRate).toBe(false);
    const above = calculateAnalysis({ ...analysis, bidAmount: 134_323_076 });
    expect(above.meetsLowerRate).toBe(true);
    expect(above.withinPlannedPrice).toBe(false);
    expect(calculateAnalysis({ ...analysis, bidAmount: 0 }).meetsLowerRate).toBe(false);
  });

  it.each([
    { baseAmount: 0 }, { baseAmount: -1 }, { baseAmount: 1.1 }, { baseAmount: Number.MAX_SAFE_INTEGER + 1 },
    { baseAmount: Number.NaN }, { aValue: -1 }, { aValue: 134_541_000 },
    { plannedPrice: 7_054_014 }, { plannedPrice: 0 }, { plannedPrice: Number.POSITIVE_INFINITY },
    { plannedPrice: 134_323_075.5 }, { bidAmount: -1 }, { bidAmount: 1.5 },
    { lowerRate: 0 }, { lowerRate: 100.001 }, { lowerRate: Number.NaN },
  ])('rejects invalid opening inputs %j', patch => {
    expect(() => calculateAnalysis({ ...analysis, ...patch })).toThrow();
  });
});

describe('bid helper assumed-price scenario', () => {
  it('reproduces the workbook example with one multiplication by the target rate', () => {
    const result = calculateScenario(scenario);
    expect(result.plannedPrice).toBe(134_541_000);
    expect(result.rawBidAmount).toBeCloseTo(121_467_209.5857, 5);
    expect(result.rawLowerPrice).toBeCloseTo(121_467_209.5857, 5);
    expect(result.bidAmount).toBe(121_467_210);
    expect(result.lowerPrice).toBe(121_467_210);
    expect(result.simpleBidRate).toBeCloseTo(90.28267219657948, 10);
    expect(result.adjustedBidRate).toBeCloseTo(89.74500032497434, 10);
    expect(result.companyRate).toBeCloseTo(100.00000034312315, 10);
    expect(result.lowerSimpleBidRate).toBeCloseTo(90.28267219657948, 10);
    expect(result.rateDifference).toBeCloseTo(0.0000003431231498688263, 12);
    expect(result.withinRange).toBe(true);
  });

  it('calculates both configured range endpoints', () => {
    expect(calculateScenario({ ...scenario, noticeRate: 97 }).plannedPrice).toBe(130_504_770);
    expect(calculateScenario({ ...scenario, noticeRate: 97 }).bidAmount).toBe(117_844_895);
    expect(calculateScenario({ ...scenario, noticeRate: 103 }).plannedPrice).toBe(138_577_230);
    expect(calculateScenario({ ...scenario, noticeRate: 103 }).bidAmount).toBe(125_089_525);
  });

  it('retains fractional assumed prices until final won rounding', () => {
    const result = calculateScenario({ baseAmount: 101, aValue: 0, lowerRate: 90, noticeRate: 99.5, targetRate: 100, rangeMin: -3, rangeMax: 3 });
    expect(result.plannedPrice).toBe(100.495);
    expect(result.rawBidAmount).toBe(100.495);
    expect(result.bidAmount).toBe(101);
    expect(result.lowerPrice).toBe(91);
    expect(result.withinPlannedPrice).toBe(false);
  });

  it('avoids a binary arithmetic extra won at an exact decimal boundary', () => {
    const result = calculateScenario({ baseAmount: 100_000_000, aValue: 0, lowerRate: 89.745, noticeRate: 100, targetRate: 89.745, rangeMin: -3, rangeMax: 3 });
    expect(result.bidAmount).toBe(89_745_000);
    expect(result.lowerPrice).toBe(89_745_000);
  });

  it('judges the rounded amount instead of the entered target rate', () => {
    const result = calculateScenario({ baseAmount: 101, aValue: 0, lowerRate: 90, noticeRate: 100, targetRate: 89.9, rangeMin: -3, rangeMax: 3 });
    expect(result.bidAmount).toBe(91);
    expect(result.meetsLowerRate).toBe(true);
  });

  it('preserves an explicit zero target without replacing it with the lower rate', () => {
    const result = calculateScenario({ ...scenario, targetRate: 0 });
    expect(result.bidAmount).toBe(7_054_014);
    expect(result.adjustedBidRate).toBe(0);
    expect(result.meetsLowerRate).toBe(false);
  });

  it.each([
    { targetRate: -1 }, { targetRate: 100.001 }, { targetRate: Number.NaN },
    { lowerRate: 0 }, { rangeMin: -100 }, { rangeMin: 4, rangeMax: 3 },
    { rangeMax: Number.POSITIVE_INFINITY }, { noticeRate: 96.999 }, { noticeRate: 103.001 },
    { noticeRate: 0 }, { baseAmount: 100, aValue: 99, noticeRate: 97 },
    { baseAmount: Number.MAX_SAFE_INTEGER, noticeRate: 103 },
  ])('rejects invalid scenario inputs %j', patch => {
    expect(() => calculateScenario({ ...scenario, ...patch })).toThrow();
  });

  it('exports the current merged-anchor examples rather than stale merged cells', () => {
    expect(calculateAnalysis(WORKBOOK_EXAMPLE.analysis).lowerPrice).toBe(121_271_633);
    expect(calculateScenario(WORKBOOK_EXAMPLE.scenario).bidAmount).toBe(121_467_210);
  });
});
