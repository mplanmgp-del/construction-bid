export function readWon(value: string, label: string): number {
  const text = value.trim();
  if (!text) throw new Error(`${label}을 입력해 주세요. 적용하지 않는 A값은 0을 입력하세요.`);
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text)) throw new Error(`${label}은 0 이상의 원 단위 정수로 입력해 주세요.`);
  const amount = Number(text.replaceAll(',', ''));
  if (!Number.isSafeInteger(amount)) throw new Error(`${label}이 계산할 수 있는 금액 범위를 벗어났습니다.`);
  return amount;
}

export function readRate(value: string, label: string): number {
  const text = value.trim();
  if (!/^-?\d+(?:\.\d{1,8})?$/.test(text)) throw new Error(`${label}을 숫자로 입력해 주세요. 예: 89.745`);
  const rate = Number(text);
  if (!Number.isFinite(rate)) throw new Error(`${label}을 올바르게 입력해 주세요.`);
  return rate;
}
