import type { BidNotice, Category, CompanyProfile, SearchFilters } from './types';

export const DEMO_TODAY = '2026-10-12';

export const PROVINCES: string[] = [
  '서울특별시', '부산광역시', '대구광역시', '인천광역시', '광주광역시', '대전광역시',
  '울산광역시', '세종특별자치시', '경기도', '강원특별자치도', '충청북도', '충청남도',
  '전북특별자치도', '전라남도', '경상북도', '경상남도', '제주특별자치도',
];

export const DISTRICTS: Record<string, string[]> = {
  서울특별시: ['종로구', '중구', '용산구', '성동구', '광진구', '동대문구', '중랑구', '성북구', '강북구', '도봉구', '노원구', '은평구', '서대문구', '마포구', '양천구', '강서구', '구로구', '금천구', '영등포구', '동작구', '관악구', '서초구', '강남구', '송파구', '강동구'],
  부산광역시: ['중구', '서구', '동구', '영도구', '부산진구', '동래구', '남구', '북구', '해운대구', '사하구', '금정구', '강서구', '연제구', '수영구', '사상구', '기장군'],
  대구광역시: ['중구', '동구', '서구', '남구', '북구', '수성구', '달서구', '달성군', '군위군'],
  // 2026-07 행정체제 개편 반영: https://www.incheon.go.kr/IC01070101
  인천광역시: ['제물포구', '영종구', '미추홀구', '연수구', '남동구', '부평구', '계양구', '서해구', '검단구', '강화군', '옹진군'],
  광주광역시: ['동구', '서구', '남구', '북구', '광산구'],
  대전광역시: ['동구', '중구', '서구', '유성구', '대덕구'],
  울산광역시: ['중구', '남구', '동구', '북구', '울주군'],
  세종특별자치시: ['세종시'],
  경기도: ['수원시', '성남시', '의정부시', '안양시', '부천시', '광명시', '평택시', '동두천시', '안산시', '고양시', '과천시', '구리시', '남양주시', '오산시', '시흥시', '군포시', '의왕시', '하남시', '용인시', '파주시', '이천시', '안성시', '김포시', '화성시', '광주시', '양주시', '포천시', '여주시', '연천군', '가평군', '양평군'],
  강원특별자치도: ['춘천시', '원주시', '강릉시', '동해시', '태백시', '속초시', '삼척시', '홍천군', '횡성군', '영월군', '평창군', '정선군', '철원군', '화천군', '양구군', '인제군', '고성군', '양양군'],
  충청북도: ['청주시', '충주시', '제천시', '보은군', '옥천군', '영동군', '증평군', '진천군', '괴산군', '음성군', '단양군'],
  충청남도: ['천안시', '공주시', '보령시', '아산시', '서산시', '논산시', '계룡시', '당진시', '금산군', '부여군', '서천군', '청양군', '홍성군', '예산군', '태안군'],
  전북특별자치도: ['전주시', '군산시', '익산시', '정읍시', '남원시', '김제시', '완주군', '진안군', '무주군', '장수군', '임실군', '순창군', '고창군', '부안군'],
  전라남도: ['목포시', '여수시', '순천시', '나주시', '광양시', '담양군', '곡성군', '구례군', '고흥군', '보성군', '화순군', '장흥군', '강진군', '해남군', '영암군', '무안군', '함평군', '영광군', '장성군', '완도군', '진도군', '신안군'],
  경상북도: ['포항시', '경주시', '김천시', '안동시', '구미시', '영주시', '영천시', '상주시', '문경시', '경산시', '의성군', '청송군', '영양군', '영덕군', '청도군', '고령군', '성주군', '칠곡군', '예천군', '봉화군', '울진군', '울릉군'],
  경상남도: ['창원시', '진주시', '통영시', '사천시', '김해시', '밀양시', '거제시', '양산시', '의령군', '함안군', '창녕군', '고성군', '남해군', '하동군', '산청군', '함양군', '거창군', '합천군'],
  제주특별자치도: ['제주시', '서귀포시'],
};

export const LICENSES: string[] = [
  '구조물해체·비계공사업', '석면해체·제거업', '건축공사업', '실내건축공사업',
  '토목공사업', '도장·습식·방수·석공사업', '전기공사업', '정보통신공사업',
  '전문소방시설공사업', '기계설비·가스공사업', '조경식재·시설물공사업',
  '건설폐기물 수집·운반업', '건설폐기물 중간처리업', '엔지니어링사업', '건축사사무소',
];

export const DEMO_PROFILES: CompanyProfile[] = [
  {
    id: 'demo-seoul', companyName: '예시철거', province: '서울특별시', district: '마포구',
    address: '서울특별시 마포구 월드컵로 00, 예시빌딩 2층',
    licenses: ['구조물해체·비계공사업', '석면해체·제거업'],
    contactName: '김예시', email: 'seoul@example.com',
  },
  {
    id: 'demo-gyeonggi', companyName: '경기해체', province: '경기도', district: '고양시',
    address: '경기도 고양시 중앙로 00, 예시타워 3층',
    licenses: ['구조물해체·비계공사업', '건설폐기물 수집·운반업'],
    contactName: '이예시', email: 'gyeonggi@example.com',
  },
  {
    id: 'demo-busan', companyName: '부산환경', province: '부산광역시', district: '해운대구',
    address: '부산광역시 해운대구 해운대로 00, 예시센터 1층',
    licenses: ['석면해체·제거업', '건설폐기물 중간처리업'],
    contactName: '박예시', email: 'busan@example.com',
  },
];

export const DEFAULT_FILTERS: SearchFilters = {
  keyword: '', excludeKeyword: '', category: '철거·해체', type: '전체', siteProvince: '전체',
  license: '전체', minAmount: '', maxAmount: '', status: '진행중', contractMethod: '전체',
  deadlineFrom: '', deadlineTo: '', regionView: 'all', autoRegion: false, sort: 'deadline',
};

const categoryLicenses: Record<Category, string[]> = {
  '기타': [],
  '철거·해체': ['구조물해체·비계공사업'], '석면': ['석면해체·제거업'],
  '건축·리모델링': ['건축공사업', '실내건축공사업'], '토목': ['토목공사업'],
  '보수·유지관리': ['도장·습식·방수·석공사업'],
  '전기·통신·소방': ['전기공사업', '전문소방시설공사업'],
  '기계·설비': ['기계설비·가스공사업'], '조경': ['조경식재·시설물공사업'],
  '폐기물': ['건설폐기물 수집·운반업', '건설폐기물 중간처리업'],
  '조사·설계·감리': ['엔지니어링사업', '건축사사무소'],
};

type ExampleInput = Pick<BidNotice, 'title' | 'agency' | 'province' | 'district' | 'allowedRegions' | 'estimatedPrice' | 'deadline'> & Partial<BidNotice>;

function example(index: number, input: ExampleInput): BidNotice {
  const category = input.category ?? '철거·해체';
  const day = input.deadline.slice(0, 10);
  const deadline = input.deadline.length === 16 ? `${input.deadline}:00+09:00` : input.deadline;
  const previousDay = new Date(`${day}T00:00:00Z`);
  previousDay.setUTCDate(previousDay.getUTCDate() - 1);
  const registrationDay = previousDay.toISOString().slice(0, 10);
  const licenses = input.licenses ?? categoryLicenses[category];
  return {
    id: `demo-bid-${String(index).padStart(3, '0')}`,
    number: `D202610${String(index).padStart(6, '0')}`, revision: input.revised ? '01' : '00',
    type: category === '폐기물' || category === '조사·설계·감리' ? '용역' : '공사', category,
    contractMethod: '제한경쟁', status: '접수중', postedAt: `2026-10-${String(12 - ((index - 1) % 6)).padStart(2, '0')}T09:00:00+09:00`,
    openingAt: `${day}T16:00:00+09:00`, registrationDeadline: `${registrationDay}T18:00:00+09:00`,
    licenses: [...licenses], duration: '착공일로부터 45일',
    description: `디자인 테스트를 위한 가상 공고입니다. ${input.title}에 필요한 작업 범위, 현장 안전계획 및 일정 조율을 확인하는 예시이며 실제 공공입찰 자료가 아닙니다.`,
    requirements: [
      '등록된 본점 소재지가 참가 가능 지역에 해당하는지 공고 원문 기준으로 확인해야 합니다.',
      `요구 업종·면허 예시: ${licenses.join(', ')}. 실제 면허 조합과 시공능력 요건은 별도 확인이 필요합니다.`,
      '지역 일치는 참가자격 전체를 뜻하지 않습니다. 납세, 실적, 공동수급 등 다른 조건을 확인해 주세요.',
    ],
    documents: [
      { name: '예시_공고안내.txt', size: '2 KB' },
      { name: '예시_참가조건.txt', size: '2 KB' },
      { name: '예시_현장설명.txt', size: '1 KB' },
    ],
    revised: false, ...input, deadline,
  };
}

// 공고명·발주기관·번호·주소·금액은 모두 화면 테스트용 가상 자료입니다.
export const NOTICES: BidNotice[] = [
  example(1, { title: '공공청사 별관 철거공사', agency: '○○시청', province: '경기도', district: '고양시', allowedRegions: ['서울', '경기'], estimatedPrice: 109_090_909, deadline: '2026-10-20T14:00', revised: true }),
  example(2, { title: '노후 공동주택 지장물 철거공사', agency: '○○공사', province: '서울특별시', district: '마포구', allowedRegions: ['서울'], estimatedPrice: 260_000_000, deadline: '2026-10-21T10:00', duration: '착공일로부터 60일' }),
  example(3, { title: '유휴시설 구조물 해체공사', agency: '○○시설관리공단', province: '경기도', district: '성남시', allowedRegions: ['전국'], estimatedPrice: 85_454_545, deadline: '2026-10-22T10:00', contractMethod: '일반경쟁' }),
  example(4, { title: '공공시설 내부 철거공사', agency: '○○구청', province: '서울특별시', district: '강서구', allowedRegions: ['서울'], estimatedPrice: 59_090_909, deadline: '2026-10-23T14:00', contractMethod: '수의계약', duration: '착공일로부터 20일' }),
  example(5, { title: '정비구역 지장물 철거공사', agency: '○○지역본부', province: '서울특별시', district: '은평구', allowedRegions: null, estimatedPrice: null, deadline: '2026-10-26T10:00', contractMethod: '일반경쟁', description: '지역조건과 추정가격이 미제공된 가상 공고입니다. 참가 지역과 금액을 전국 또는 0원으로 간주하지 않고 예시 참가조건을 확인해야 합니다.' }),
  example(6, { title: '구립 체육센터 유휴동 철거공사', agency: '○○체육시설사업소', province: '서울특별시', district: '강서구', allowedRegions: ['서울특별시 강서구'], estimatedPrice: 72_500_000, deadline: '2026-10-27T10:00', contractMethod: '수의계약' }),
  example(7, { title: '수도권 공공창고 해체공사', agency: '○○물류관리단', province: '경기도', district: '파주시', allowedRegions: ['서울특별시', '경기도'], estimatedPrice: 312_700_000, deadline: '2026-10-27T14:00', duration: '착공일로부터 75일' }),
  example(8, { title: '항만 유휴창고 철거공사', agency: '○○항만공사', province: '부산광역시', district: '영도구', allowedRegions: ['부산'], estimatedPrice: 180_000_000, deadline: '2026-10-28T10:00' }),
  example(9, { title: '옛 주민센터 정비 철거공사', agency: '○○마을정비과', province: '서울특별시', district: '마포구', allowedRegions: ['서울특별시 마포구'], estimatedPrice: 76_800_000, deadline: '2026-10-28T14:00' }),
  example(10, { title: '공영주차장 지장물 해체공사', agency: '○○도시관리공단', province: '서울특별시', district: '용산구', allowedRegions: ['서울'], estimatedPrice: 145_600_000, deadline: '2026-10-29T10:00', revised: true }),
  example(11, { title: '폐교 시설 철거공사', agency: '○○교육지원청', province: '경기도', district: '양평군', allowedRegions: ['경기'], estimatedPrice: 208_900_000, deadline: '2026-10-29T14:00' }),
  example(12, { title: '도시재생 블록 노후건물 철거공사', agency: '○○도시재생센터', province: '인천광역시', district: '미추홀구', allowedRegions: ['전국'], estimatedPrice: 392_450_000, deadline: '2026-10-30T10:00', contractMethod: '일반경쟁' }),
  example(13, { title: '하천변 무허가 건축물 철거공사', agency: '○○하천관리과', province: '서울특별시', district: '강동구', allowedRegions: ['서울특별시'], estimatedPrice: 66_300_000, deadline: '2026-10-30T14:00', duration: '착공일로부터 25일' }),
  example(14, { title: '공공연구시설 별동 철거공사', agency: '○○공공연구원', province: '경기도', district: '수원시', allowedRegions: ['서울', '경기'], estimatedPrice: 950_000_000, deadline: '2026-11-02T10:00', duration: '착공일로부터 120일' }),
  example(15, { title: '빈집 정비 해체공사', agency: '○○주거정비과', province: '강원특별자치도', district: '춘천시', allowedRegions: ['강원'], estimatedPrice: 43_700_000, deadline: '2026-11-02T14:00', contractMethod: '수의계약' }),
  example(16, { title: '생활SOC 부지 기존시설 철거공사', agency: '○○시설사업단', province: '서울특별시', district: '금천구', allowedRegions: null, estimatedPrice: 118_400_000, deadline: '2026-11-03T10:00' }),
  example(17, { title: '노후 정수장 구조물 해체공사', agency: '○○상수도사업본부', province: '경기도', district: '화성시', allowedRegions: ['전국'], estimatedPrice: 740_600_000, deadline: '2026-11-03T14:00', contractMethod: '일반경쟁', specialRegionCondition: true, requirements: ['지역업체와 공동수급하는 경우의 참가조건은 원문 확인이 필요합니다.', '대표사 소재지와 구성원 참여비율 조건을 별도로 확인해야 합니다.', '구조물해체·비계공사업 등록 및 현장 안전관리계획 제출 여부를 확인해 주세요.'] }),
  example(18, { title: '주민쉼터 부속시설 철거공사', agency: '○○공원관리사업소', province: '서울특별시', district: '성동구', allowedRegions: [], estimatedPrice: null, deadline: '2026-11-04T10:00', contractMethod: '수의계약' }),
  example(19, { title: '정비사업 현장 안전 해체공사', agency: '○○정비사업지원단', province: '서울특별시', district: '영등포구', allowedRegions: ['서울'], estimatedPrice: 220_000_000, deadline: '2026-11-09T10:00', status: '접수예정', postedAt: '2026-10-12T09:00:00+09:00' }),
  example(20, { title: '유휴 공공시설 철거공사', agency: '○○시설지원청', province: '대전광역시', district: '유성구', allowedRegions: ['대전광역시'], estimatedPrice: 158_000_000, deadline: '2026-10-30T10:00', status: '접수예정', postedAt: '2026-10-11T09:00:00+09:00' }),
  example(21, { title: '공공시설 담장 해체공사', agency: '○○시설운영과', province: '서울특별시', district: '서대문구', allowedRegions: ['서울'], estimatedPrice: 36_900_000, deadline: '2026-10-08T14:00', status: '마감', postedAt: '2026-09-29T09:00:00+09:00', contractMethod: '수의계약' }),
  example(22, { title: '노후 창고 철거공사', agency: '○○재산관리과', province: '서울특별시', district: '중랑구', allowedRegions: ['서울'], estimatedPrice: 97_200_000, deadline: '2026-10-27T10:00', status: '취소', revised: true, description: '사업 일정 조정으로 취소된 가상 공고입니다. 실제 접수나 투찰은 제공하지 않습니다.' }),
  example(23, { title: '학교 석면 천장재 해체·제거공사', agency: '○○교육시설관리단', category: '석면', province: '서울특별시', district: '노원구', allowedRegions: ['서울'], estimatedPrice: 132_700_000, deadline: '2026-10-21T14:00' }),
  example(24, { title: '공공건물 석면 해체 감리용역', agency: '○○안전환경센터', category: '석면', type: '용역', province: '부산광역시', district: '해운대구', allowedRegions: ['부산광역시'], estimatedPrice: 48_900_000, deadline: '2026-10-25T10:00', licenses: ['엔지니어링사업'], contractMethod: '수의계약' }),
  example(25, { title: '주민복지센터 내부 리모델링공사', agency: '○○복지시설과', category: '건축·리모델링', province: '서울특별시', district: '양천구', allowedRegions: ['서울', '경기'], estimatedPrice: 680_000_000, deadline: '2026-10-26T14:00' }),
  example(26, { title: '공공도서관 열람실 환경개선공사', agency: '○○도서관사업소', category: '건축·리모델링', province: '경기도', district: '고양시', allowedRegions: ['경기도 고양시'], estimatedPrice: 195_500_000, deadline: '2026-11-05T10:00', status: '접수예정', postedAt: '2026-10-12T09:00:00+09:00' }),
  example(27, { title: '도시계획도로 배수로 정비공사', agency: '○○도로관리사업소', category: '토목', province: '인천광역시', district: '연수구', allowedRegions: ['인천'], estimatedPrice: 420_300_000, deadline: '2026-10-23T10:00' }),
  example(28, { title: '공공부지 우수관 정비공사', agency: '○○건설사업본부', category: '토목', province: '경기도', district: '김포시', allowedRegions: ['전국'], estimatedPrice: 1_180_000_000, deadline: '2026-10-29T10:00', contractMethod: '일반경쟁' }),
  example(29, { title: '청사 외벽 방수 및 도장공사', agency: '○○청사관리과', category: '보수·유지관리', province: '서울특별시', district: '종로구', allowedRegions: ['서울'], estimatedPrice: 91_700_000, deadline: '2026-10-22T14:00', contractMethod: '수의계약' }),
  example(30, { title: '체육시설 관람석 보수공사', agency: '○○스포츠시설공단', category: '보수·유지관리', province: '충청남도', district: '천안시', allowedRegions: ['충남'], estimatedPrice: null, deadline: '2026-10-09T10:00', status: '마감', postedAt: '2026-10-01T09:00:00+09:00' }),
  example(31, { title: '공공청사 조명 교체 전기공사', agency: '○○청사시설팀', category: '전기·통신·소방', province: '서울특별시', district: '중구', allowedRegions: ['서울'], estimatedPrice: 164_900_000, deadline: '2026-10-28T10:00', licenses: ['전기공사업'] }),
  example(32, { title: '통합관제센터 통신·소방시설 개선공사', agency: '○○안전관제센터', category: '전기·통신·소방', province: '대구광역시', district: '수성구', allowedRegions: ['대구'], estimatedPrice: 278_000_000, deadline: '2026-10-30T10:00', licenses: ['정보통신공사업', '전문소방시설공사업'], specialRegionCondition: true }),
  example(33, { title: '복지관 냉난방 설비 교체공사', agency: '○○사회시설관리단', category: '기계·설비', province: '경기도', district: '성남시', allowedRegions: ['서울', '경기'], estimatedPrice: 352_400_000, deadline: '2026-10-27T10:00' }),
  example(34, { title: '공공병원 환기설비 보수공사', agency: '○○공공의료원', category: '기계·설비', province: '부산광역시', district: '부산진구', allowedRegions: ['부산'], estimatedPrice: 187_000_000, deadline: '2026-10-28T14:00', status: '취소', revised: true }),
  example(35, { title: '생활권 공원 수목 정비공사', agency: '○○녹지관리과', category: '조경', province: '서울특별시', district: '마포구', allowedRegions: ['서울특별시 마포구'], estimatedPrice: 64_600_000, deadline: '2026-10-26T10:00', contractMethod: '수의계약' }),
  example(36, { title: '하천 산책로 조경시설 설치공사', agency: '○○공원사업본부', category: '조경', province: '광주광역시', district: '북구', allowedRegions: ['광주광역시'], estimatedPrice: 242_100_000, deadline: '2026-11-06T10:00', status: '접수예정', postedAt: '2026-10-11T09:00:00+09:00' }),
  example(37, { title: '청사 철거 건설폐기물 처리용역', agency: '○○환경관리사업소', category: '폐기물', province: '서울특별시', district: '강서구', allowedRegions: ['전국'], estimatedPrice: 88_400_000, deadline: '2026-10-20T10:00', contractMethod: '일반경쟁' }),
  example(38, { title: '정비구역 폐기물 수집·운반용역', agency: '○○환경지원센터', category: '폐기물', province: '부산광역시', district: '해운대구', allowedRegions: ['부산', '울산'], estimatedPrice: 124_500_000, deadline: '2026-10-29T14:00', licenses: ['건설폐기물 수집·운반업'] }),
  example(39, { title: '노후 공공건축물 해체계획 수립용역', agency: '○○도시안전연구소', category: '조사·설계·감리', province: '서울특별시', district: '성북구', allowedRegions: ['전국'], estimatedPrice: 57_700_000, deadline: '2026-10-23T10:00', contractMethod: '일반경쟁' }),
  example(40, { title: '공공시설 리모델링 설계 및 감리용역', agency: '○○시설계획과', category: '조사·설계·감리', province: '제주특별자치도', district: '제주시', allowedRegions: null, estimatedPrice: 156_000_000, deadline: '2026-10-07T10:00', status: '마감', postedAt: '2026-09-28T09:00:00+09:00' }),
];
