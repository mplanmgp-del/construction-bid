import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { noticeContentKey, noticeOmittedContentKey } from '../src/alerts/domain';
import { mapNotice } from '../server/g2b';
import type { AlertNotice } from '../src/alerts/types';

// Public attachment facts from the two production heads rejected as stale when
// a Windows ko-KR worker compared its digest with the Linux en-US source index.
const bor = '보령시 성주면 성주지구 농촌공간정비사업 석면철거공사';
const fixtures = [
  { number: 'R26BK01756562', basis: '행자부', special: true,
    files: ['R26DC00245183_공사입찰설명서_지방_3050_전기_전기공사손해보험.hwpx',
      'R26DC00245183_공사입찰설명서_지방_3050_전기_전기공사손해보험.pdf', '긴급입찰사유서_(가칭)시흥특수 전기공사.pdf'],
    productionDigest: '43f932682ab698af71aaf8c574f7c490418818768e2412dfc58103126db673d1' },
  { number: 'R26BK01767486', basis: '조달청', special: false,
    files: [`A값_${bor}.pdf`, `입찰공고문(재공고)_${bor}.hwpx`, `3.시방서(${bor}).hwp`, `입찰공고문(재공고)_${bor}.pdf`],
    productionDigest: '193af52b81177c95c68997c67b38c89d236fa69ce2995ab510ef6cd6bcbc0c24' },
];

function withDefaultLocale<T>(locale: string, operation: () => T): T {
  const original = String.prototype.localeCompare;
  const mocked = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (this: string, ...args) {
    return original.call(this, args[0], args[1] ?? locale, args[2]);
  });
  try { return operation(); } finally { mocked.mockRestore(); }
}

describe('portable source content fingerprints', () => {
  it.each(fixtures)('preserves the production digest for $number across host locales and attachment order', fixture => {
    const fields = Object.fromEntries(fixture.files.flatMap((name, index) => [
      [`ntceSpecFileNm${index + 1}`, name],
      [`ntceSpecDocUrl${index + 1}`, `https://www.g2b.go.kr/pn/pnp/pnpe/UntyAtchFile/downloadFile.do?bidPbancNo=${fixture.number}&bidPbancOrd=000&fileType=&fileSeq=${index + 1}&prcmBsneSeCd=07`],
    ]));
    const mapped = mapNotice({ bidNtceNo: fixture.number, bidNtceOrd: '000', bidNtceNm: '공사', aplBssCntnts: fixture.basis,
      rgnDutyJntcontrctYn: fixture.special ? 'Y' : 'N', ...fields }, '공사');
    const notice: AlertNotice = { ...mapped, sourceUpdatedAt: '', regionComplete: false, licenseComplete: false };
    const productionContent = withDefaultLocale('en-US', () => noticeContentKey(notice));
    for (const locale of ['ko-KR', 'en-US']) {
      for (const documents of [notice.documents, [...notice.documents].reverse(), [...notice.documents.slice(1), notice.documents[0]]]) {
        const value = { ...notice, documents };
        const digest = withDefaultLocale(locale, () => createHash('sha256').update(noticeOmittedContentKey(value)).digest('hex'));
        expect(digest, `${fixture.number}: ${locale}`).toBe(fixture.productionDigest);
        expect(withDefaultLocale(locale, () => noticeContentKey(value))).toBe(productionContent);
      }
    }
  });
});
