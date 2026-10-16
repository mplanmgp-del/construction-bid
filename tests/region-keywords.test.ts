import { describe, expect, it } from 'vitest';
import { assessRegion, assessSearchRegions, filterNotices } from '../src/domain';
import { DEFAULT_FILTERS } from '../src/data';
import { DEFAULT_ALERT_SETTINGS, type AlertNotice } from '../src/alerts/types';
import { matchAlertNotice } from '../src/alerts/domain';
import type { BidNotice, CompanyProfile } from '../src/types';

const now = Date.parse('2026-10-16T10:00:00+09:00');
const company: CompanyProfile = { id: 'test', companyName: '업체', province: '서울특별시', district: '마포구', address: '', licenses: [], contactName: '', email: '' };
const notice = (patch: Partial<BidNotice> = {}): BidNotice => ({
  id: 'notice', number: 'R26BK00000001', revision: '000', title: '건물 철거공사', agency: '관리사무소', type: '공사', category: '철거·해체',
  province: '', district: '', allowedRegions: null, estimatedPrice: null, contractMethod: '일반경쟁', status: '접수중',
  postedAt: '2026-10-16T09:00:00+09:00', deadline: '2026-10-20T10:00:00+09:00', openingAt: '2026-10-20T11:00:00+09:00', registrationDeadline: '',
  licenses: [], duration: '', description: '', requirements: [], documents: [], revised: false, source: 'live', ...patch,
});

describe('공고 전체 정보의 지역명 키워드 검색', () => {
  it.each([
    { title: '서울역 인근 건물 철거' }, { agency: '서울시설공단' }, { demandAgency: '서울교육지원청' },
    { description: '작업 주소: 서울특별시 영등포구' }, { requirements: ['서울 소재 현장 방문'] },
    { documents: [{ name: '서울_현장설명서.pdf', size: '' }] },
  ])('현장·참가 필드가 비어도 다른 공고 정보 %j에서 찾는다', patch => {
    expect(assessSearchRegions(notice(patch), [{ province: '서울특별시' }]).status).toBe('matched');
  });

  it('원본 API 추가 정보와 시도 약칭을 함께 검색한다', () => {
    const bid = notice({ regionSearchText: '추가 현장주소 강원도 춘천시' } as Partial<BidNotice>);
    expect(assessSearchRegions(bid, [{ province: '강원특별자치도' }]).status).toBe('matched');
  });

  it('하위 지역은 부모 시도 표기를 요구하지 않고 마지막 지역명으로 검색한다', () => {
    const bid = notice({ title: '파장동 철거', province: '서울' });
    expect(assessSearchRegions(bid, [{ province: '경기도', district: '수원시', locality: '장안구 파장동' }]).status).toBe('matched');
    expect(assessSearchRegions(notice({ agency: '부산 강서구청' }), [{ province: '서울', district: '강서구' }]).status).toBe('matched');
  });

  it('하위 지역의 자유 입력은 광주도 문자 그대로 찾고 광역시 약칭과 구분한다', () => {
    const bid = notice({ title: '경기도 광주시 철거공사' });
    expect(assessSearchRegions(bid, [{ province: '경기', district: '광주' }]).status).toBe('matched');
    expect(assessSearchRegions(bid, [{ province: '광주광역시' }]).status).toBe('excluded');
  });

  it('전국 참가 공고는 모든 선택지역에 포함하고 지역 근거가 전혀 없으면 미확인으로 남긴다', () => {
    expect(assessSearchRegions(notice({ allowedRegions: ['전국'] }), [{ province: '제주', district: '제주시' }]).status).toBe('matched');
    const unknown = notice();
    expect(assessSearchRegions(unknown, [{ province: '서울' }]).status).toBe('review');
    expect(filterNotices([unknown], { ...DEFAULT_FILTERS, regions: [{ province: '서울' }], includeUnknownRegions: false }, company, now)).toHaveLength(0);
    expect(filterNotices([unknown], { ...DEFAULT_FILTERS, regions: [{ province: '서울' }], includeUnknownRegions: true }, company, now)).toHaveLength(1);
    expect(assessSearchRegions(notice({ agency: '부산시청' }), [{ province: '서울' }]).status).toBe('excluded');
  });

  it('내 업체 지역 필터는 시도 키워드를 사용하고 실제 참가 지역 판정은 유지한다', () => {
    const bid = notice({ agency: '서울교육청', allowedRegions: ['부산'] });
    expect(filterNotices([bid], { ...DEFAULT_FILTERS, autoRegion: true }, company, now)).toHaveLength(1);
    expect(assessRegion(bid, company).status).toBe('excluded');
  });

  it.each(['auto', 'site', 'participation', 'either', 'both'] as const)('자동조회 저장 기준 %s도 모든 정보의 키워드로 검색한다', regionBasis => {
    const settings = structuredClone(DEFAULT_ALERT_SETTINGS);
    settings.enabled = true;
    Object.assign(settings.filter, { keywords: [], regions: ['서울'], regionBasis, includeUnknown: false, useCompanyRegion: true });
    const bid: AlertNotice = { ...notice({ agency: '서울시설공단', allowedRegions: ['부산'] }), sourceUpdatedAt: '', regionComplete: false, licenseComplete: false };
    expect(matchAlertNotice(bid, settings, company, now)).toMatchObject({ matched: true, needsReview: false });
  });
});
