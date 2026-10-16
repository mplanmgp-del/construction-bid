import { describe, expect, it } from 'vitest';
import { assessRegion, assessSearchRegion, assessSearchRegions, buildBidCsv, daysUntil, filterNotices, formatAmountInput, formatDateTime, getPriceRangeError } from '../src/domain';
import type { BidNotice, CompanyProfile, SearchFilters } from '../src/types';

const company: CompanyProfile = {
  id: 'seoul', companyName: '예시철거', province: '서울특별시', district: '마포구',
  address: '서울특별시 마포구 월드컵로 00', licenses: ['구조물해체·비계공사업'],
  contactName: '예시 담당자', email: 'demo@example.com',
};

const notice = (patch: Partial<BidNotice> = {}): BidNotice => ({
  id: 'base', number: 'D202610120001', revision: '00', title: '별관 철거공사',
  agency: '예시시청', type: '공사', category: '철거·해체', province: '경기도',
  district: '고양시', allowedRegions: ['서울'], estimatedPrice: 100_000_000,
  contractMethod: '제한경쟁', status: '접수중', postedAt: '2026-10-08T09:00:00+09:00',
  deadline: '2026-10-20T14:00:00+09:00', openingAt: '2026-10-20T15:00:00+09:00',
  registrationDeadline: '2026-10-19T18:00:00+09:00', licenses: ['구조물해체·비계공사업'],
  duration: '착공일로부터 30일', description: '예시 자료', requirements: [],
  documents: [], revised: false, ...patch,
});

const filters = (patch: Partial<SearchFilters> = {}): SearchFilters => ({
  keyword: '', excludeKeyword: '', category: '전체', type: '전체', siteProvince: '전체',
  license: '전체', minAmount: '', maxAmount: '', status: '전체', contractMethod: '전체',
  deadlineFrom: '', deadlineTo: '', regionView: 'all', autoRegion: false,
  sort: 'deadline', ...patch,
});

const ids = (items: BidNotice[]) => items.map(item => item.id);

describe('참가 가능 지역 판정', () => {
  it('시도 약칭을 정규화하고 복수 지역 중 하나만 일치해도 판정한다', () => {
    expect(assessRegion(notice({ allowedRegions: ['경기', '서울'] }), company).status).toBe('matched');
    expect(assessRegion(notice({ allowedRegions: ['경기도', '부산광역시'] }), company).status).toBe('excluded');
  });

  it('시군구 제한은 정확한 명칭으로 비교한다', () => {
    expect(assessRegion(notice({ allowedRegions: ['서울특별시 마포구'] }), company).status).toBe('matched');
    expect(assessRegion(notice({ allowedRegions: ['서울 강서구'] }), company).status).toBe('excluded');
    expect(assessRegion(notice({ allowedRegions: ['서울특별시 포구'] }), company).status).toBe('review');
  });

  it('같은 이름의 다른 시도 시군구를 참가 가능으로 판단하지 않는다', () => {
    const busan = { ...company, province: '부산광역시', district: '강서구' };
    expect(assessRegion(notice({ allowedRegions: ['서울특별시 강서구'] }), busan).status).toBe('excluded');
  });

  it.each([{ allowedRegions: null }, { allowedRegions: [] }, { allowedRegions: [''] }])('누락 또는 빈 지역조건 %j는 확인 필요로 남긴다', ({ allowedRegions }) => {
    expect(assessRegion(notice({ allowedRegions }), company).status).toBe('review');
  });

  it('업체 소재지가 없으면 전국 공고도 확인 필요로 남긴다', () => {
    expect(assessRegion(notice({ allowedRegions: ['전국'] }), { ...company, province: '', district: '' }).status).toBe('review');
    expect(assessRegion(notice(), { ...company, district: '' }).status).toBe('review');
  });

  it.each([
    { province: '서울특별시', district: '고양시' },
    { province: '경기도', district: '마포구' },
  ])('업체 시도·시군구 조합이 잘못된 경우 %j는 전국 공고도 확인 필요로 남긴다', location => {
    expect(assessRegion(notice({ allowedRegions: ['전국'] }), { ...company, ...location }).status).toBe('review');
  });

  it('명시적 전국 조건은 일치하지만 공동수급 등 별도조건은 원문 확인을 요구한다', () => {
    expect(assessRegion(notice({ allowedRegions: ['전국'] }), company).status).toBe('matched');
    const assessment = assessRegion(notice({ allowedRegions: ['전국'], specialRegionCondition: true }), company);
    expect(assessment.status).toBe('matched');
    expect(assessment.reason).toContain('별도 참가조건');
  });

  it.each([
    ['서울특별시', '인천광역시', '경기도'],
    ['인천광역시', '서울특별시', '경기도'],
    ['인천광역시', '경기도', '서울특별시'],
  ])('복수 지역 %j 중 서울이 명시되면 별도 참가조건이 있어도 지역은 일치한다', (...allowedRegions) => {
    const bid = notice({ allowedRegions, specialRegionCondition: true });
    const assessment = assessRegion(bid, company);
    expect(assessment.status).toBe('matched');
    expect(assessment.reason).toContain('본점 서울특별시 마포구');
    expect(assessment.reason).toContain('별도 참가조건');
    expect(ids(filterNotices([bid], filters({ autoRegion: true }), company))).toEqual(['base']);
  });

  it('명시된 지역이 일치하지 않으면 별도 참가조건은 확인 필요로 남긴다', () => {
    const bid = notice({ allowedRegions: ['인천광역시', '경기도'], specialRegionCondition: true });
    expect(assessRegion(bid, company).status).toBe('review');
    expect(filterNotices([bid], filters({ autoRegion: true }), company)).toHaveLength(0);
    expect(assessRegion({ ...bid, specialRegionCondition: false }, company).status).toBe('excluded');
  });

  it('모호한 조건에 시도 이름이 포함돼도 부분문자열로 일치시키지 않는다', () => {
    expect(assessRegion(notice({ allowedRegions: ['서울특별시 외 지역'] }), company).status).toBe('review');
    expect(assessRegion(notice({ allowedRegions: ['부산', '공동수급 협정 조건'] }), company).status).toBe('review');
  });

  it.each([
    { allowedRegions: ['서울', '공동수급 협정 조건'] },
    { allowedRegions: ['전국', '제주 지역 분담비율 별도'] },
  ])('일치하는 지역과 불명확한 조건이 함께 있는 경우 %j는 확인 필요로 남긴다', ({ allowedRegions }) => {
    expect(assessRegion(notice({ allowedRegions }), company).status).toBe('review');
  });
});

describe('지역 검색과 검색조건', () => {
  const regions = [
    notice({ id: 'match' }),
    notice({ id: 'exclude', allowedRegions: ['부산'] }),
    notice({ id: 'review', province: '', district: '', allowedRegions: null }),
    notice({ id: 'national', allowedRegions: ['전국'] }),
  ];

  it('자동 지역필터는 지역 일치와 전국 공고만 표시한다', () => {
    expect(ids(filterNotices(regions, filters({ autoRegion: true }), company))).toEqual(['match', 'national']);
  });

  it('제외공고 보기에서는 자동 지역필터가 켜져 있어도 제외공고를 보여준다', () => {
    expect(ids(filterNotices(regions, filters({ autoRegion: true, regionView: 'excluded' }), company))).toEqual(['exclude']);
  });

  it('자동 지역필터를 해제하면 모든 판정의 공고를 볼 수 있다', () => {
    expect(ids(filterNotices(regions, filters(), company))).toEqual(['match', 'exclude', 'review', 'national']);
    expect(ids(filterNotices(regions, filters({ regionView: 'review' }), company))).toEqual(['review']);
    expect(ids(filterNotices(regions, filters({ autoRegion: true, regionView: 'review' }), company))).toEqual(['review']);
  });

  it('현장 위치와 참가 가능 지역 모두 지역 키워드로 검색한다', () => {
    expect(ids(filterNotices(regions, filters({ siteProvince: '경기', autoRegion: true }), company))).toEqual(['match', 'national']);
    expect(ids(filterNotices(regions, filters({ siteProvince: '서울특별시' }), company))).toEqual(['match', 'review', 'national']);
  });

  it('현장 위치가 없는 서울 참가 대상 용역과 취소 차수도 지역 검색에 포함한다', () => {
    const bids = [
      notice({ id: 'service', type: '용역', province: '', allowedRegions: ['서울특별시'] }),
      notice({ id: 'cancelled', type: '용역', province: '', revision: '001', status: '취소', allowedRegions: ['서울특별시'] }),
      notice({ id: 'busan', type: '용역', province: '', allowedRegions: ['부산광역시'] }),
    ];
    expect(ids(filterNotices(bids, filters({ siteProvince: '서울특별시' }), company))).toEqual(['service', 'cancelled']);
  });

  it('용역도 기관명과 현장 위치 및 참가 가능 지역을 모두 검색한다', () => {
    const bid = notice({ type: '용역', agency: '서울시청', province: '서울특별시', allowedRegions: ['경기도'] });
    expect(filterNotices([bid], filters({ siteProvince: '서울특별시' }), company)).toHaveLength(1);
    expect(filterNotices([bid], filters({ siteProvince: '경기도' }), company)).toHaveLength(1);
  });

  it('명시적인 전국 및 선택 시도 산하 지역의 용역을 포함한다', () => {
    const bids = [
      notice({ id: 'national', type: '용역', province: '', allowedRegions: ['전국'] }),
      notice({ id: 'district', type: '용역', province: '', allowedRegions: ['서울 강서구'] }),
    ];
    expect(ids(filterNotices(bids, filters({ siteProvince: '서울' }), company))).toEqual(['national', 'district']);
  });

  it.each([{ allowedRegions: null }, { allowedRegions: [] }])('지역명 근거가 없는 용역 %j는 미확인 옵션에 따라 검색한다', ({ allowedRegions }) => {
    const bid = notice({ type: '용역', province: '', district: '', allowedRegions });
    expect(filterNotices([bid], filters({ siteProvince: '서울특별시' }), company)).toHaveLength(1);
    expect(assessSearchRegion(bid, '서울특별시').status).toBe('review');
    expect(filterNotices([bid], filters({ siteProvince: '서울특별시', autoRegion: true }), company)).toHaveLength(0);
  });

  it('검색어는 공고명·번호·기관을 검색하며 제외어를 우선 적용한다', () => {
    const bids = [
      notice({ id: 'title', title: '학교 철거 공사' }),
      notice({ id: 'number', number: 'SCHOOL-2026', title: '별관 해체공사' }),
      notice({ id: 'agency', agency: 'School 공단', title: '석면 철거공사' }),
    ];
    expect(ids(filterNotices(bids, filters({ keyword: ' school ', excludeKeyword: '석면' }), company))).toEqual(['number']);
    expect(ids(filterNotices(bids, filters({ keyword: '학교 철거' }), company))).toEqual(['title']);
  });

  it('쉼표로 구분한 제외어 중 하나라도 공고명·번호·기관에 포함되면 제외한다', () => {
    const bids = [
      notice({ id: 'keep', title: '학교 철거 공사' }),
      notice({ id: 'title', title: '학교 해체 설계 용역' }),
      notice({ id: 'number', number: '감리-2026-001' }),
      notice({ id: 'agency', agency: '공공 설계지원센터' }),
    ];
    expect(ids(filterNotices(bids, filters({ excludeKeyword: '  설계, , 감리,  ' }), company))).toEqual(['keep']);
  });

  it('공백 또는 빈 제외어만 입력하면 공고를 제외하지 않는다', () => {
    expect(ids(filterNotices([notice()], filters({ excludeKeyword: ' , ,  ' }), company))).toEqual(['base']);
    expect(ids(filterNotices([notice()], filters({ excludeKeyword: '   ' }), company))).toEqual(['base']);
  });

  it('카테고리·공고 구분·면허·상태·계약방법 조건을 함께 적용한다', () => {
    const bids = [
      notice({ id: 'wanted', category: '석면', type: '용역', licenses: ['석면해체·제거업'], licenseCodes: ['5652'], contractMethod: '일반경쟁' }),
      notice({ id: 'closed', category: '석면', type: '용역', licenses: ['석면해체·제거업'], licenseCodes: ['5652'], contractMethod: '일반경쟁', status: '마감', deadline: '2026-10-10T14:00:00+09:00', openingAt: '2026-10-10T15:00:00+09:00' }),
      notice({ id: 'different' }),
    ];
    expect(ids(filterNotices(bids, filters({ category: '석면', type: '용역', license: '석면해체·제거업', status: '진행중', contractMethod: '일반경쟁' }), company, Date.parse('2026-10-13T10:00:00+09:00')))).toEqual(['wanted']);
  });

  it('마감일 범위의 양 끝 날짜를 포함한다', () => {
    const bids = [
      notice({ id: 'earlier', deadline: '2026-10-19T23:59:00+09:00' }),
      notice({ id: 'start', deadline: '2026-10-20T00:01:00+09:00' }),
      notice({ id: 'end', deadline: '2026-10-21T18:00:00+09:00' }),
      notice({ id: 'later', deadline: '2026-10-22T00:00:00+09:00' }),
    ];
    expect(ids(filterNotices(bids, filters({ deadlineFrom: '2026-10-20', deadlineTo: '2026-10-21' }), company))).toEqual(['start', 'end']);
  });
});

describe('복수 상태와 하위 지역의 조합 검색', () => {
  const now = Date.parse('2026-10-13T10:00:00+09:00');
  const seoul = { province: '서울특별시' };
  const gyeonggi = { province: '경기도' };
  const gangseo = { ...seoul, district: '강서구' };

  it('상태와 지역 안에서는 OR, 두 항목 사이에서는 AND로 적용한다', () => {
    const bids = [
      notice({ id: 'active-seoul', province: '서울', district: '강서구' }),
      notice({ id: 'urgent-gyeonggi', province: '경기도', deadline: '2026-10-13T18:00:00+09:00' }),
      notice({ id: 'active-busan', province: '부산', district: '강서구', allowedRegions: ['부산'] }),
      notice({ id: 'scheduled-seoul', province: '서울', biddingStartAt: '2026-10-15T10:00:00+09:00' }),
      notice({ id: 'opened-gyeonggi', openingAt: '2026-10-12T10:00:00+09:00' }),
    ];
    const result = filterNotices(bids, filters({ statuses: ['진행중', '마감 임박'], regions: [seoul, gyeonggi] }), company, now);
    expect(ids(result)).toEqual(['urgent-gyeonggi', 'active-seoul']);
  });

  it('빈 복수 조건은 이전 단일 조건에 영향받지 않고 전체를 뜻한다', () => {
    expect(filterNotices([notice()], filters({ status: '예정', statuses: [], siteProvince: '부산', regions: [] }), company, now)).toHaveLength(1);
  });

  it('같은 이름의 하위 지역은 시도에 관계없이 키워드로 검색한다', () => {
    const bids = [
      notice({ id: 'seoul', province: '서울', district: '강서구 등촌1동' }),
      notice({ id: 'busan', province: '부산', district: '강서구 대저1동' }),
      notice({ id: 'other', province: '서울', district: '강남구 삼성1동' }),
    ];
    expect(ids(filterNotices(bids, filters({ regions: [gangseo] }), company))).toEqual(['seoul', 'busan']);
  });

  it('동 및 시·구 경계를 정확한 토큰으로 비교한다', () => {
    const selected = { province: '경기도', district: '수원시', locality: '장안구 파장동' };
    expect(assessSearchRegions(notice({ province: '경기', district: '수원시 장안구 파장동' }), [selected]).status).toBe('matched');
    expect(assessSearchRegions(notice({ province: '경기', district: '수원시 권선구 권선동' }), [selected]).status).toBe('excluded');
    expect(assessSearchRegions(notice({ province: '서울', district: '강남구 삼성1동' }), [{ province: '서울', district: '강남구', locality: '삼성동' }]).status).toBe('excluded');
  });

  it('다른 지역 정보만 있고 선택한 하위 지역명이 없으면 미확인 옵션과 관계없이 제외한다', () => {
    const bid = notice({ province: '서울', district: '강서구' });
    const regions = [{ ...gangseo, locality: '등촌1동' }];
    expect(assessSearchRegions(bid, regions).status).toBe('excluded');
    expect(filterNotices([bid], filters({ regions }), company)).toHaveLength(0);
    expect(filterNotices([bid], filters({ regions, includeUnknownRegions: true }), company)).toHaveLength(0);
    expect(assessSearchRegions(notice({ province: '서울', district: '' }), [gangseo]).status).toBe('excluded');
  });

  it('알려진 현장 지역이 다른 공고는 미확인 포함 옵션으로 추가하지 않는다', () => {
    expect(filterNotices([notice({ province: '서울', district: '강남구' })], filters({ regions: [gangseo], includeUnknownRegions: true }), company)).toHaveLength(0);
  });

  it('용역도 전국 또는 선택한 마지막 지역명 키워드가 있는 공고를 검색한다', () => {
    const bids = [
      notice({ id: 'nationwide', type: '용역', allowedRegions: ['전국'] }),
      notice({ id: 'province', type: '용역', allowedRegions: ['서울'] }),
      notice({ id: 'child', type: '용역', allowedRegions: ['서울 강서구 등촌1동'] }),
      notice({ id: 'other', type: '용역', allowedRegions: ['서울 강남구'] }),
    ];
    expect(ids(filterNotices(bids, filters({ regions: [gangseo] }), company))).toEqual(['nationwide', 'child']);
    expect(assessSearchRegions(bids[1], [{ ...gangseo, locality: '등촌2동' }]).status).toBe('excluded');
  });

  it('새 지역 검색의 미확인 용역은 기본 제외하고 이전 검색의 포함 정책은 보존한다', () => {
    const bid = notice({ type: '용역', province: '', district: '', allowedRegions: null });
    expect(assessSearchRegions(bid, [seoul]).status).toBe('review');
    expect(filterNotices([bid], filters({ regions: [seoul] }), company)).toHaveLength(0);
    expect(filterNotices([bid], filters({ regions: [seoul], includeUnknownRegions: true }), company)).toHaveLength(1);
    expect(filterNotices([bid], filters({ siteProvince: '서울' }), company)).toHaveLength(1);
  });

  it('공고명과 기관명 및 모호한 참가조건 문구에서도 검색 키워드는 찾되 참가자격을 판정하지 않는다', () => {
    const bid = notice({ title: '서울특별시 강서구 등촌1동 철거', agency: '서울특별시 강서구', type: '용역', province: '서울', district: '강서구 등촌1동', allowedRegions: ['서울 외 지역'] });
    expect(assessSearchRegions(bid, [gangseo]).status).toBe('matched');
    expect(assessSearchRegions({ ...bid, allowedRegions: ['강서구'] }, [gangseo]).status).toBe('matched');
    expect(assessSearchRegions({ ...bid, allowedRegions: ['부산 강서구'] }, [gangseo]).status).toBe('matched');
    expect(assessSearchRegions({ ...bid, type: '공사', province: '부산' }, [gangseo]).status).toBe('matched');
  });

  it('여러 선택지 중 정확히 일치한 지역이 있으면 다른 선택지의 미확인보다 우선한다', () => {
    const bid = notice({ province: '서울', district: '' });
    expect(assessSearchRegions(bid, [gangseo, seoul]).status).toBe('matched');
    expect(filterNotices([bid], filters({ regions: [gangseo, seoul] }), company)).toHaveLength(1);
  });

  it('세종은 합성 시군구 없이 읍면동을 비교하며 기존 세종시 표기도 호환한다', () => {
    const regions = [{ province: '세종특별자치시', locality: '조치원읍' }];
    expect(assessSearchRegions(notice({ province: '세종시', district: '조치원읍' }), regions).status).toBe('matched');
    expect(assessSearchRegions(notice({ province: '세종시', district: '세종시 조치원읍' }), regions).status).toBe('matched');
  });

  it('현행 통합 시도 검색은 이전 공고의 지역 이름을 호환하되 업체 참가자격 판정은 넓히지 않는다', () => {
    const regions = [{ province: '전남광주통합특별시' }];
    expect(assessSearchRegions(notice({ province: '광주광역시', district: '광산구' }), regions).status).toBe('matched');
    expect(assessSearchRegions(notice({ province: '전라남도', district: '목포시' }), regions).status).toBe('matched');
    expect(assessSearchRegions(notice({ type: '용역', allowedRegions: ['전라남도 목포시'] }), regions).status).toBe('matched');
    expect(assessSearchRegions(notice({ province: '경기도', district: '광주시' }), regions).status).toBe('excluded');
    const gwangjuCompany = { ...company, province: '광주광역시', district: '광산구' };
    expect(assessRegion(notice({ allowedRegions: ['전라남도'] }), gwangjuCompany).status).toBe('excluded');
  });
});

describe('추정가격 범위와 정렬', () => {
  const prices = [
    notice({ id: 'missing', estimatedPrice: null }),
    notice({ id: 'high', estimatedPrice: 200_000_000 }),
    notice({ id: 'zero', estimatedPrice: 0 }),
    notice({ id: 'low', estimatedPrice: 100_000_000 }),
  ];

  it('금액 범위에 경계값을 포함하고 미제공 금액을 제외한다', () => {
    expect(ids(filterNotices(prices, filters({ minAmount: '100,000,000', maxAmount: '200000000' }), company))).toEqual(['high', 'low']);
    expect(ids(filterNotices(prices, filters({ maxAmount: '0' }), company))).toEqual(['zero']);
  });

  it.each([
    { minAmount: '-1' }, { maxAmount: '-10' }, { minAmount: 'abc' },
    { minAmount: '200000001', maxAmount: '100000000' },
  ])('유효하지 않은 금액 범위 %j를 무시하고 전체 결과를 보여주지 않는다', invalid => {
    expect(filterNotices(prices, filters(invalid), company)).toHaveLength(0);
  });

  it('미제공 가격은 오름차순과 내림차순 모두 마지막에 표시한다', () => {
    expect(ids(filterNotices(prices, filters({ sort: 'amountAsc' }), company))).toEqual(['zero', 'low', 'high', 'missing']);
    expect(ids(filterNotices(prices, filters({ sort: 'amountDesc' }), company))).toEqual(['high', 'low', 'zero', 'missing']);
  });

  it('마감임박순과 최신공고순은 서로 다른 날짜를 사용하며 원본을 변경하지 않는다', () => {
    const bids = [
      notice({ id: 'later', deadline: '2026-10-22T14:00:00+09:00', postedAt: '2026-10-11T09:00:00+09:00' }),
      notice({ id: 'sooner', deadline: '2026-10-20T14:00:00+09:00', postedAt: '2026-10-08T09:00:00+09:00' }),
    ];
    expect(ids(filterNotices(bids, filters({ sort: 'deadline' }), company))).toEqual(['sooner', 'later']);
    expect(ids(filterNotices(bids, filters({ sort: 'newest' }), company))).toEqual(['later', 'sooner']);
    expect(ids(bids)).toEqual(['later', 'sooner']);
  });

  it('넓은 조회에서도 마감 임박과 투찰 가능한 진행 공고를 개찰 대기와 예정 공고보다 먼저 보여준다', () => {
    const now = Date.parse('2026-10-15T10:00:00+09:00');
    const bids = [
      notice({ id: 'waiting', deadline: '2026-10-15T09:00:00+09:00', openingAt: '2026-10-15T15:00:00+09:00', postedAt: '2026-10-13T09:00:00+09:00' }),
      notice({ id: 'scheduled', deadline: '2026-10-15T16:00:00+09:00', openingAt: '2026-10-15T17:00:00+09:00', biddingStartAt: '2026-10-15T11:00:00+09:00', postedAt: '2026-10-15T09:00:00+09:00' }),
      notice({ id: 'missing', deadline: '', openingAt: '' }),
      notice({ id: 'active', deadline: '2026-10-19T10:00:00+09:00', openingAt: '2026-10-19T11:00:00+09:00', postedAt: '2026-10-12T09:00:00+09:00' }),
      notice({ id: 'urgent', deadline: '2026-10-16T06:00:00+09:00', openingAt: '2026-10-16T07:00:00+09:00', postedAt: '1995-10-01T09:00:00+09:00' }),
    ];
    expect(ids(filterNotices(bids, filters(), company, now))).toEqual(['urgent', 'active', 'waiting', 'scheduled', 'missing']);
    expect(ids(filterNotices(bids, filters({ sort: 'newest' }), company, now))).toEqual(['scheduled', 'waiting', 'active', 'missing', 'urgent']);
    expect(ids(bids)).toEqual(['waiting', 'scheduled', 'missing', 'active', 'urgent']);
  });

  it('같은 상태와 마감시각이면 최신 게시 공고를 먼저 보여주고 게시일 누락은 마지막에 둔다', () => {
    const now = Date.parse('2026-10-15T10:00:00+09:00');
    const bids = [
      notice({ id: 'missing', number: 'A', postedAt: '' }),
      notice({ id: 'old', number: 'A', postedAt: '1995-10-01T09:00:00+09:00' }),
      notice({ id: 'new-service', number: 'B', type: '용역', postedAt: '2026-10-15T09:00:00+09:00' }),
      notice({ id: 'new-construction', number: 'B', postedAt: '2026-10-15T09:00:00+09:00' }),
    ];
    expect(ids(filterNotices(bids, filters(), company, now))).toEqual(['new-construction', 'new-service', 'old', 'missing']);
  });
});

describe('화면과 검색이 공유하는 원 단위 금액 검증', () => {
  it.each([
    { minimum: '', maximum: '' },
    { minimum: '0', maximum: '0' },
    { minimum: '100,000,000', maximum: '200000000' },
    { minimum: '', maximum: '9007199254740991' },
  ])('빈값 또는 유효한 정수 범위 %j에는 오류를 반환하지 않는다', ({ minimum, maximum }) => {
    expect(getPriceRangeError(minimum, maximum)).toBeNull();
  });

  it.each([
    { minimum: '-1', maximum: '' },
    { minimum: '', maximum: '-10' },
    { minimum: '1.5', maximum: '' },
    { minimum: '', maximum: '1e8' },
    { minimum: '9007199254740992', maximum: '' },
    { minimum: '', maximum: '12,34' },
    { minimum: '가격', maximum: '' },
    { minimum: '200000001', maximum: '100000000' },
  ])('유효하지 않은 금액 입력 %j에는 사람이 읽을 오류를 반환한다', ({ minimum, maximum }) => {
    expect(getPriceRangeError(minimum, maximum)).toMatch(/금액/);
  });
});

describe('검색 금액의 천 단위 표시', () => {
  it.each([
    ['', ''], ['0', '0'], ['999', '999'], ['1000', '1,000'],
    ['100000000', '100,000,000'], ['100,000,000', '100,000,000'],
    [' 100,000,000 ', '100,000,000'],
    ['9007199254740992', '9,007,199,254,740,992'],
  ])('입력 %s를 금액 손실 없이 %s로 표시한다', (input, expected) => {
    expect(formatAmountInput(input)).toBe(expected);
  });

  it.each(['-10', '1.5', '1e8', '가격'])('잘못된 입력 %s를 다른 금액으로 바꾸지 않는다', input => {
    expect(formatAmountInput(input)).toBe(input);
    expect(getPriceRangeError(formatAmountInput(input), '')).toMatch(/금액/);
  });
});

describe('CSV 추정가격 표시', () => {
  it('쉼표가 있는 가격을 한 열로 출력하고 미제공·0원·문서 인용을 보존한다', () => {
    const csv = buildBidCsv([
      notice({ number: 'CSV-1', title: '학교, "별관" 철거공사', estimatedPrice: 109_090_909 }),
      notice({ number: 'CSV-2', estimatedPrice: null }),
      notice({ number: 'CSV-3', estimatedPrice: 0 }),
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('\uFEFF"공고번호","공고명","발주기관","공사 위치","참가 가능 지역","계약방법","추정가격(원)","제출 마감"');
    expect(lines[1]).toBe('"CSV-1","학교, ""별관"" 철거공사","예시시청","경기도 고양시","서울","제한경쟁","109,090,909","2026-10-20T14:00:00+09:00"');
    expect(lines[2]).toContain(',"미제공","2026-10-20T14:00:00+09:00"');
    expect(lines[3]).toContain(',"0","2026-10-20T14:00:00+09:00"');
  });
});

describe('예시 기준일의 마감 D-day', () => {
  it('기기 날짜와 시간대에 관계없이 2026-10-12 한국 날짜를 기준으로 계산한다', () => {
    expect(daysUntil('2026-10-20T14:00:00+09:00')).toBe(8);
    expect(daysUntil('2026-10-11T15:30:00Z')).toBe(0);
    expect(daysUntil('2026-10-11T14:30:00Z')).toBe(-1);
  });
});

describe('공고 일정의 연도 표시', () => {
  it('연도를 요청한 일정은 한국시간의 년월일과 시분을 모두 표시한다', () => {
    expect(formatDateTime('2027-03-04T10:00:00+09:00', { includeYear: true })).toBe('2027.03.04 10:00');
    expect(formatDateTime('2026-12-31T15:30:00Z', { includeYear: true })).toBe('2027.01.01 00:30');
    expect(formatDateTime('2027-03-04 11:00:00', { includeYear: true })).toBe('2027.03.04 11:00');
  });

  it('짧은 조회 시각 표시와 미제공 일정의 의미를 유지한다', () => {
    expect(formatDateTime('2026-10-15T15:18:00+09:00')).toBe('10.15 15:18');
    expect(formatDateTime('', { includeYear: true })).toBe('일정 미제공');
  });
});
