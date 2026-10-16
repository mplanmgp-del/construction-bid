type Row = Record<string, unknown>;
const text = (value: unknown) => typeof value === 'string' || typeof value === 'number'
  ? String(value).normalize('NFKC').trim() : '';

/** Official 15129394/15129456 fields: 업종명/코드 and [허용업종명/코드],… . */
export function noticeLicenseCodes(rows: Row[]): string[] {
  const codes = new Set<string>();
  for (const row of rows) {
    // Some source versions provide the code separately. Never infer it from
    // descriptions, notice numbers, dates, or other unstructured text.
    for (const field of ['lcnsLmtCd', 'indstrytyCd']) {
      const code = text(row[field]);
      if (/^\d{4}$/.test(code)) codes.add(code);
    }
    const limited = text(row.lcnsLmtNm).match(/^[^\[\]\r\n]+\/(\d{4})$/);
    if (limited) codes.add(limited[1]);
    const permitted = text(row.permsnIndstrytyList);
    if (permitted && /^\[[^\[\]\r\n]+\/\d{4}\](?:\s*,\s*\[[^\[\]\r\n]+\/\d{4}\])*$/.test(permitted)) {
      for (const match of permitted.matchAll(/\/(\d{4})\]/g)) codes.add(match[1]);
    }
  }
  return [...codes];
}
