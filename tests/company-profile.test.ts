import { describe, expect, it } from 'vitest';
import { formatBusinessNumber, isOptionalBusinessNumber, normalizeBusinessNumber } from '../src/company-profile';

describe('optional company business number', () => {
  it('accepts both ten digits and the usual hyphenated form, and displays the same readable value', () => {
    for (const input of ['1234567890', '123-45-67890', ' 123-45-67890 ']) {
      expect(normalizeBusinessNumber(input)).toBe('1234567890');
      expect(formatBusinessNumber(input)).toBe('123-45-67890');
    }
    expect(normalizeBusinessNumber('001-02-00003')).toBe('0010200003');
  });

  it('allows older profiles without a number and an intentionally empty field', () => {
    expect(isOptionalBusinessNumber(undefined)).toBe(true);
    expect(isOptionalBusinessNumber('')).toBe(true);
    expect(normalizeBusinessNumber('   ')).toBe('');
    expect(formatBusinessNumber(undefined)).toBe('');
  });

  it.each([null, 1234567890, {}, '123456789', '12345678901', '123a4567890', '123--45-67890', '123 45 67890'])('rejects malformed or non-string values: %j', (value) => {
    expect(isOptionalBusinessNumber(value)).toBe(false);
  });
});
