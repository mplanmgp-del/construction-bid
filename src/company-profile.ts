/** Accept the usual display format, but persist business numbers as ten digits. */
export function normalizeBusinessNumber(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return /^(?:\d{10}|\d{3}-\d{2}-\d{5})$/.test(trimmed) ? trimmed.replaceAll('-', '') : null;
}

export function isOptionalBusinessNumber(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && normalizeBusinessNumber(value) !== null);
}

export function formatBusinessNumber(value: string | undefined): string {
  if (value === undefined) return '';
  const digits = normalizeBusinessNumber(value);
  return digits ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` : value;
}
