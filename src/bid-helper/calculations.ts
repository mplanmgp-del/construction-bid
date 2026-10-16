export type BidHelperInput = {
  baseAmount: number;
  aValue: number;
  lowerRate: number;
  plannedPrice: number;
  bidAmount: number;
};

export type ScenarioInput = {
  baseAmount: number;
  aValue: number;
  lowerRate: number;
  noticeRate: number;
  targetRate: number;
  rangeMin: number;
  rangeMax: number;
};

export type AnalysisResult = {
  simpleBidRate: number;
  adjustedBidRate: number;
  noticeRate: number;
  companyRate: number;
  rateDifference: number;
  lowerPrice: number;
  minimumBidAmount: number;
  meetsLowerRate: boolean;
  withinPlannedPrice: boolean;
};

export type ScenarioResult = AnalysisResult & {
  plannedPrice: number;
  rawBidAmount: number;
  bidAmount: number;
  rawLowerPrice: number;
  lowerSimpleBidRate: number;
  withinRange: boolean;
};

// UI rates use percent units: 89.745 means 89.745%, and differences use %p.
export const WORKBOOK_EXAMPLE = {
  analysis: {
    baseAmount: 134_541_000, aValue: 7_054_014, lowerRate: 89.745,
    plannedPrice: 134_323_075, bidAmount: 121_290_200,
  } satisfies BidHelperInput,
  scenario: {
    baseAmount: 134_541_000, aValue: 7_054_014, lowerRate: 89.745,
    noticeRate: 100, targetRate: 89.745, rangeMin: -3, rangeMax: 3,
  } satisfies ScenarioInput,
};

type Fraction = { numerator: bigint; denominator: bigint };
const ONE: Fraction = { numerator: 1n, denominator: 1n };
const HUNDRED: Fraction = { numerator: 100n, denominator: 1n };
const MAX_WON = BigInt(Number.MAX_SAFE_INTEGER);

function fraction(numerator: bigint, denominator = 1n): Fraction {
  if (denominator === 0n) throw new Error('계산 기준 금액과 비율을 확인하세요.');
  if (denominator < 0n) { numerator = -numerator; denominator = -denominator; }
  let a = numerator < 0n ? -numerator : numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return { numerator: numerator / a, denominator: denominator / a };
}

// Convert the entered decimal itself, before any binary floating-point arithmetic.
function decimal(value: number): Fraction {
  const [mantissa, exponentText = '0'] = value.toString().toLowerCase().split('e');
  const negative = mantissa.startsWith('-');
  const [whole, tail = ''] = mantissa.replace('-', '').split('.');
  const exponent = Number(exponentText) - tail.length;
  const digits = BigInt(whole + tail) * (negative ? -1n : 1n);
  return exponent >= 0
    ? fraction(digits * 10n ** BigInt(exponent))
    : fraction(digits, 10n ** BigInt(-exponent));
}

const add = (a: Fraction, b: Fraction) => fraction(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
const subtract = (a: Fraction, b: Fraction) => fraction(a.numerator * b.denominator - b.numerator * a.denominator, a.denominator * b.denominator);
const multiply = (a: Fraction, b: Fraction) => fraction(a.numerator * b.numerator, a.denominator * b.denominator);
const divide = (a: Fraction, b: Fraction) => fraction(a.numerator * b.denominator, a.denominator * b.numerator);
const compare = (a: Fraction, b: Fraction) => {
  const difference = a.numerator * b.denominator - b.numerator * a.denominator;
  return difference === 0n ? 0 : difference > 0n ? 1 : -1;
};

function asNumber(value: Fraction): number {
  let result = Number(value.numerator) / Number(value.denominator);
  if (!Number.isFinite(result)) {
    const numerator = (value.numerator < 0n ? -value.numerator : value.numerator).toString();
    const denominator = value.denominator.toString();
    const numeratorHead = numerator.slice(0, 16);
    const denominatorHead = denominator.slice(0, 16);
    result = Number(numeratorHead) / Number(denominatorHead)
      * 10 ** (numerator.length - numeratorHead.length - denominator.length + denominatorHead.length)
      * (value.numerator < 0n ? -1 : 1);
  }
  if (!Number.isFinite(result)) throw new Error('계산 결과가 너무 큽니다. 금액과 비율을 확인하세요.');
  return result;
}

function ceilWon(value: Fraction): number {
  const won = value.numerator / value.denominator + (value.numerator % value.denominator > 0n ? 1n : 0n);
  if (won < 0n || won > MAX_WON) throw new Error('계산 금액이 원 단위로 처리할 수 있는 범위를 벗어났습니다.');
  return Number(won);
}

function requireWon(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}은 0 이상의 정확한 원 단위 숫자로 입력하세요.`);
}

function requireRate(value: number, label: string, allowZero = false): void {
  if (!Number.isFinite(value) || value > 100 || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${label}은 ${allowZero ? '0% 이상' : '0% 초과'} 100% 이하로 입력하세요.`);
  }
}

function validateBase(baseAmount: number, aValue: number, lowerRate: number): void {
  requireWon(baseAmount, '기초금액');
  requireWon(aValue, 'A값');
  if (baseAmount <= 0) throw new Error('기초금액은 0원보다 커야 합니다.');
  if (aValue >= baseAmount) throw new Error('A값은 기초금액보다 작아야 합니다.');
  requireRate(lowerRate, '낙찰하한율');
}

function analyze(baseAmount: number, aValue: number, plannedPrice: Fraction, bidAmount: number, lowerRate: number): AnalysisResult {
  const base = decimal(baseAmount);
  const a = decimal(aValue);
  const bid = decimal(bidAmount);
  const lower = divide(decimal(lowerRate), HUNDRED);
  const adjustedPrice = subtract(plannedPrice, a);
  if (compare(adjustedPrice, fraction(0n)) <= 0) throw new Error('예정가격은 A값보다 커야 합니다.');
  const rawLowerPrice = add(multiply(adjustedPrice, lower), a);
  const noticeRate = divide(plannedPrice, base);
  const companyRate = divide(add(divide(subtract(bid, a), lower), a), base);
  const lowerPrice = ceilWon(rawLowerPrice);
  return {
    simpleBidRate: asNumber(multiply(divide(bid, plannedPrice), HUNDRED)),
    adjustedBidRate: asNumber(multiply(divide(subtract(bid, a), adjustedPrice), HUNDRED)),
    noticeRate: asNumber(multiply(noticeRate, HUNDRED)),
    companyRate: asNumber(multiply(companyRate, HUNDRED)),
    rateDifference: asNumber(multiply(subtract(companyRate, noticeRate), HUNDRED)),
    lowerPrice,
    minimumBidAmount: lowerPrice,
    meetsLowerRate: compare(bid, rawLowerPrice) >= 0,
    withinPlannedPrice: compare(bid, plannedPrice) <= 0,
  };
}

export function calculateAnalysis(input: BidHelperInput): AnalysisResult {
  validateBase(input.baseAmount, input.aValue, input.lowerRate);
  requireWon(input.plannedPrice, '예정가격');
  requireWon(input.bidAmount, '투찰금액');
  return analyze(input.baseAmount, input.aValue, decimal(input.plannedPrice), input.bidAmount, input.lowerRate);
}

export function calculateScenario(input: ScenarioInput): ScenarioResult {
  validateBase(input.baseAmount, input.aValue, input.lowerRate);
  requireRate(input.targetRate, '투찰률(A)', true);
  if (!Number.isFinite(input.rangeMin) || !Number.isFinite(input.rangeMax) || input.rangeMin <= -100 || input.rangeMax < input.rangeMin) {
    throw new Error('예가 변동 하한은 -100%보다 크고, 상한은 하한 이상이어야 합니다.');
  }
  if (!Number.isFinite(input.noticeRate) || input.noticeRate <= 0) throw new Error('공고 사정률 설정은 0%보다 큰 숫자로 입력하세요.');
  const notice = divide(decimal(input.noticeRate), HUNDRED);
  const rangeMin = add(ONE, divide(decimal(input.rangeMin), HUNDRED));
  const rangeMax = add(ONE, divide(decimal(input.rangeMax), HUNDRED));
  const withinRange = compare(notice, rangeMin) >= 0 && compare(notice, rangeMax) <= 0;
  if (!withinRange) throw new Error('공고 사정률 설정이 예가 변동 범위를 벗어났습니다.');
  const plannedPrice = multiply(decimal(input.baseAmount), notice);
  if (compare(plannedPrice, fraction(MAX_WON)) > 0) throw new Error('가정 예정가격이 정확한 원 단위 계산 범위를 벗어났습니다.');
  const a = decimal(input.aValue);
  const adjustedPrice = subtract(plannedPrice, a);
  if (compare(adjustedPrice, fraction(0n)) <= 0) throw new Error('가정 예정가격은 A값보다 커야 합니다.');
  const rawLowerPrice = add(multiply(adjustedPrice, divide(decimal(input.lowerRate), HUNDRED)), a);
  const rawBidAmount = add(multiply(adjustedPrice, divide(decimal(input.targetRate), HUNDRED)), a);
  const bidAmount = ceilWon(rawBidAmount);
  const result = analyze(input.baseAmount, input.aValue, plannedPrice, bidAmount, input.lowerRate);
  return {
    ...result,
    plannedPrice: asNumber(plannedPrice),
    rawBidAmount: asNumber(rawBidAmount),
    bidAmount,
    rawLowerPrice: asNumber(rawLowerPrice),
    lowerSimpleBidRate: asNumber(multiply(divide(decimal(result.lowerPrice), plannedPrice), HUNDRED)),
    withinRange,
  };
}

/** Spread twelve distinct assumptions across the range while retaining all three anchors. */
export function buildComparisonRates(input: Pick<ScenarioInput, 'rangeMin' | 'rangeMax' | 'noticeRate'>): number[] {
  if (!Number.isFinite(input.rangeMin) || !Number.isFinite(input.rangeMax) || input.rangeMin <= -100 || input.rangeMax < input.rangeMin) {
    throw new Error('예가 변동 범위를 확인하세요.');
  }
  if (!Number.isFinite(input.noticeRate) || input.noticeRate <= 0) throw new Error('공고 사정률을 확인하세요.');
  const lower = add(HUNDRED, decimal(input.rangeMin));
  const upper = add(HUNDRED, decimal(input.rangeMax));
  const current = decimal(input.noticeRate);
  if (compare(current, lower) < 0 || compare(current, upper) > 0) throw new Error('공고 사정률이 예가 변동 범위를 벗어났습니다.');
  const rates = new Set([asNumber(lower), input.noticeRate, asNumber(upper)]);
  while (rates.size < 12) {
    const sorted = [...rates].sort((left, right) => left - right);
    const gaps = sorted.slice(1).map((right, index) => ({ left: sorted[index], right }));
    gaps.sort((left, right) => (right.right - right.left) - (left.right - left.left));
    let added = false;
    for (const gap of gaps) {
      const midpoint = divide(add(decimal(gap.left), decimal(gap.right)), fraction(2n));
      for (const digits of [6, 8]) {
        const scale = 10n ** BigInt(digits);
        const scaled = multiply(midpoint, fraction(scale));
        const rounded = (2n * scaled.numerator + scaled.denominator) / (2n * scaled.denominator);
        const candidate = asNumber(fraction(rounded, scale));
        if (candidate > gap.left && candidate < gap.right && !rates.has(candidate)) {
          rates.add(candidate); added = true; break;
        }
      }
      if (added) break;
    }
    // An equal or very narrow range cannot provide twelve different rates at input precision.
    if (!added) break;
  }
  return [...rates].sort((left, right) => left - right);
}
