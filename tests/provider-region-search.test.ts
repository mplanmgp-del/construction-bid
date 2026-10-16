import { describe, expect, it } from 'vitest';
import { createG2bClient, mapNotice } from '../server/g2b';
import { mapPrivateNotice } from '../server/g2b-private';
import { compactCatalogNotice } from '../server/active-catalog-worker';
import { postgresJsonbText } from '../server/notice-region-text';

const identity = { bidNtceNo: 'R26BK01774453', bidNtceOrd: '001' };
const now = Date.parse('2026-10-16T12:00:00+09:00');
const payload = (items: Record<string, unknown>[]) => Response.json({ response: { header: { resultCode: '00' }, body: { items, totalCount: items.length } } });

describe('provider region keyword corpus', () => {
  it('keeps region names in titles, agencies, documents, addresses and nested provider text', () => {
    const notice = mapNotice({ ...identity, bidNtceNm: '수원시 학교 철거', ntceInsttNm: '부산교육청', dminsttNm: '대전시설관리공단',
      cnstrtsiteRgnNm: '서울특별시 강남구', ofclAddr: '경기도 성남시 분당구 야탑동 123',
      ntceSpecFileNm1: '울산 북구 공고문.pdf', extra: { rows: [{ content: '<p>제주특별자치도 서귀포시 현장설명</p>' }] },
    }, '공사', now);
    for (const name of ['수원시', '부산교육청', '대전시설관리공단', '강남구', '분당구', '야탑동', '울산 북구', '서귀포시']) {
      expect(notice.regionSearchText).toContain(name);
    }
    expect(notice.regionSearchText).not.toContain('<p>');
  });

  it('keeps private construction and service detail text before compacting the catalog', () => {
    const notice = mapPrivateNotice({ ...identity, ntceNm: '건물 외벽 철거', ntceInsttNm: '한국자산관리',
      cnstwkDtlList: '[1^경기도 성남시 분당구 야탑동 대덕프라자]', servcDtlList: '인천광역시 남동구 청소 용역',
      sptDscrptPlce: '충청남도 천안시 현장사무소', opengPlce: '전라남도 목포시 관리사무소',
    }, '공사', now);
    const compact = compactCatalogNotice({ ...notice, sourceUpdatedAt: new Date(now).toISOString(), regionComplete: false, licenseComplete: false });
    for (const name of ['성남시', '야탑동', '남동구', '천안시', '목포시']) expect(compact.regionSearchText).toContain(name);
    expect(compact.regionSearchText).toBe(notice.regionSearchText);
    expect(compact.documents).toEqual([]);
    expect(compact.description).toBe('');
  });

  it('excludes credentials, URLs, contacts, scripts and numeric provider metadata', () => {
    const notice = mapNotice({ ...identity, bidNtceNm: '서울 철거', serviceKey: '경기비밀인증값', accessToken: '부산비밀토큰',
      secret: '인천비밀정보', ofclEmail: '울산@example.com', ofclTelNo: '경남전화정보',
      ntceSpecDocUrl1: 'https://www.g2b.go.kr/file?serviceKey=충남비밀', metadata: 123456789,
      aplBssCntnts: '<script>전북스크립트</script><b>대전 현장</b> https://example.com/충북비밀?serviceKey=SECRET',
    }, '공사', now);
    expect(notice.regionSearchText).toContain('대전 현장');
    expect(notice.regionSearchText).not.toMatch(/비밀|전화정보|스크립트|example\.com|serviceKey|123456789|<script>/);
  });

  it('bounds large source text while prioritizing regional addresses and removing duplicates', () => {
    const notice = mapNotice({ ...identity, bidNtceNm: '반복 공고', longContent: '본문내용 '.repeat(10000),
      repeated: '반복 공고', agencyAddress: '강원특별자치도 원주시 단계동',
      nested: Array.from({ length: 200 }, (_, index) => ({ note: `${index}번 기타 내용`.repeat(100) })),
    }, '공사', now);
    expect([...notice.regionSearchText!].length).toBeLessThanOrEqual(3000);
    expect(notice.regionSearchText).toContain('원주시 단계동');
    expect(notice.regionSearchText!.match(/반복 공고/g)).toHaveLength(1);
  });

  it('preserves region names at the end of long provider bodies before truncating generic text', () => {
    const notice = mapNotice({ ...identity, bidNtceNm: '시설 철거',
      largeContent: `${'긴 본문내용 '.repeat(5000)} 현장은 성남시 분당구 파장동이며 서울에서 접수합니다.`,
    }, '공사', now);
    for (const name of ['성남시', '분당구', '파장동', '서울']) expect(notice.regionSearchText).toContain(name);
    expect([...notice.regionSearchText!].length).toBeLessThanOrEqual(3000);
  });

  it('keeps a long Korean projection within the catalog and automatic observation row budgets', () => {
    const mapped = mapNotice({ ...identity, bidNtceNm: '학교 철거공사', bidNtceDt: '2026-10-16 10:00:00',
      largeContent: `${'공고 내용입니다. '.repeat(2000)} 성남시 분당구 파장동`,
    }, '공사', now);
    const notice = compactCatalogNotice({ ...mapped, sourceUpdatedAt: new Date(now).toISOString(), regionComplete: false, licenseComplete: false });
    for (const name of ['성남시', '분당구', '파장동']) expect(notice.regionSearchText).toContain(name);
    expect(Buffer.byteLength(postgresJsonbText(notice), 'utf8')).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(JSON.stringify(notice), 'utf8')).toBeLessThanOrEqual(16384);
  });

  it('bounds legacy projections and preserves complete Unicode codepoints in compact rows', () => {
    const mapped = mapNotice({ ...identity, bidNtceNm: '철거공사' }, '공사', now);
    const notice = compactCatalogNotice({ ...mapped, regionSearchText: '서울시 강남구 😀 \\ " '.repeat(2000),
      sourceUpdatedAt: new Date(now).toISOString(), regionComplete: true, licenseComplete: true });
    expect(Buffer.byteLength(postgresJsonbText(notice), 'utf8')).toBeLessThanOrEqual(4096);
    expect(notice.regionSearchText).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(compactCatalogNotice(notice)).toEqual(notice);
  });

  it('hashes full sanitized source text independently of key order and condition-dependent prefixes', () => {
    const raw = { ...identity, bidNtceNm: '철거공사', largeContent: `${'공고 본문입니다. '.repeat(2000)} 서울특별시 강남구` };
    const first = mapNotice(raw, '공사', now);
    const reversed = mapNotice(Object.fromEntries(Object.entries(raw).reverse()), '공사', now);
    const changed = mapNotice({ ...raw, largeContent: `${raw.largeContent} 원문 말미 변경` }, '공사', now);
    expect(first.regionSearchDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(reversed.regionSearchDigest).toBe(first.regionSearchDigest);
    expect(changed.regionSearchDigest).not.toBe(first.regionSearchDigest);
    const initial = compactCatalogNotice({ ...first, sourceUpdatedAt: new Date(now).toISOString(), regionComplete: false, licenseComplete: false });
    const enriched = compactCatalogNotice({ ...initial, allowedRegions: ['서울특별시 강남구'], licenses: ['구조물해체·비계공사업'], regionComplete: true, licenseComplete: true });
    expect(enriched.regionSearchText!.length).toBeLessThan(initial.regionSearchText!.length);
    expect(enriched.regionSearchDigest).toBe(initial.regionSearchDigest);
    expect(Buffer.byteLength(postgresJsonbText(enriched), 'utf8')).toBeLessThanOrEqual(4096);
  });

  it('adds region-bearing text from exact supplementary detail rows', async () => {
    const api = createG2bClient({ serviceKey: 'test', now: () => now, fetcher: async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('Cnstwk')) return payload([{ ...identity, bidNtceNm: '시설 철거', bidClseDt: '2026-10-21 10:00:00' }]);
      if (url.pathname.endsWith('BsisAmount')) return payload([{ ...identity, fieldNote: '충청북도 청주시 서원구 현장' }]);
      if (url.pathname.endsWith('PrtcptPsblRgn')) return payload([{ ...identity, prtcptPsblRgnNm: '서울특별시', note: '강원도 춘천시 추가 조건' }]);
      return payload([]);
    } });
    const detail = await api.detail(identity.bidNtceNo, identity.bidNtceOrd, '공사');
    expect(detail.notice?.regionSearchText).toContain('청주시 서원구');
    expect(detail.notice?.regionSearchText).toContain('춘천시');
    expect(detail.notice?.allowedRegions).toEqual(['서울특별시']);
  });
});
