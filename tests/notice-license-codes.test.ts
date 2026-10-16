import { describe, expect, it } from 'vitest';
import { noticeLicenseCodes } from '../server/notice-license-codes';

describe('official license condition code projection', () => {
  it('preserves leading zeroes, row codes, and the official permitted-industry alternative syntax', () => {
    expect(noticeLicenseCodes([
      { lcnsLmtNm: '건축공사업/0002', permsnIndstrytyList: '[토목건축공사업/0003],[구조물해체ㆍ비계공사업/4995]' },
      { lcnsLmtNm: '다른 표기/0002', indstrytyCd: '0037', lcnsLmtCd: '0036' },
    ])).toEqual(['0002', '0003', '4995', '0036', '0037']);
  });
  it('never extracts arbitrary prose digits, malformed code suffixes, or partial permitted lists', () => {
    expect(noticeLicenseCodes([
      { lcnsLmtNm: '공사 4995 면허', title: '4995 공사', indstrytyCd: '495', permsnIndstrytyList: '참고 [구조물해체/4995] 및 확인' },
      { lcnsLmtNm: '건축공사업/2', lcnsLmtCd: '00020' },
      { lcnsLmtNm: '석면해체·제거업', permsnIndstrytyList: '[건축/0002],[잘못된 항목]' },
    ])).toEqual([]);
  });
  it('distinguishes an empty or code-less complete source from an invented name match', () => {
    expect(noticeLicenseCodes([])).toEqual([]);
    expect(noticeLicenseCodes([{ lcnsLmtNm: '구조물해체·비계공사업' }])).toEqual([]);
  });
});
