/**
 * Design-reference data from the supplied screenshots, corrected against the official page.
 * This is not an API response or a live procurement notice.
 * Blank source cells remain “미기재”; values such as 0, 없음 and 비공개 are preserved.
 * The source service's account manager (유찬진1) is excluded because that person is
 * not identified as the procurement officer for this notice.
 */
export type DetailField = {
  label: string;
  value: string;
  note?: string;
  wide?: boolean;
  emphasis?: boolean;
};

export type DetailSectionData = {
  id: string;
  label: string;
  kicker: string;
  fields: DetailField[];
};

const missing = (label: string, wide = false): DetailField => ({
  label,
  value: '미기재',
  note: '참고 화면에 값이 없습니다. 공고 원문을 확인하세요.',
  ...(wide ? { wide: true } : {}),
});

export const detailSections: DetailSectionData[] = [
  {
    id: 'general',
    label: '공고 일반',
    kicker: 'NOTICE OVERVIEW',
    fields: [
      { label: '공고명', value: '향남읍 송곡리 403번지 일원 우수관로 정비공사', wide: true },
      { label: '공고종류', value: '실공고' },
      { label: '게시일시', value: '2026.10.12 15:25' },
      { label: '입찰공고번호', value: 'R26BK01764541-000' },
      { label: '참조번호', value: '화성시맑은물사업소 공고제2026-193호' },
      { label: '발주(공고)기관', value: '경기도 화성시 맑은물사업소' },
      { label: '실수요기관', value: '경기도 화성시 맑은물사업소' },
      { label: '업종', value: '상·하수도설비공사업' },
      missing('주공종'),
      { label: '적용대상', value: '전문공사-유지보수공사' },
      { label: '입찰방식', value: '전자입찰' },
      { label: '계약방법', value: '수의계약' },
      { label: '국제입찰구분', value: '국내' },
      {
        label: '낙찰방법',
        value: '소액수의견적-소액수의견적(2인 이상 견적 제출)-국민연금보험료 등 합산액',
        wide: true,
      },
      { label: '입찰자격', value: '공고서참조', wide: true },
    ],
  },
  {
    id: 'schedule',
    label: '일정 및 진행정보',
    kicker: 'SCHEDULE & PROCESS',
    fields: [
      { label: '집행관', value: '이민숙' },
      { label: '입회관(담당자)', value: '이민숙' },
      missing('PQ심사신청서'),
      missing('PQ심사신청기한'),
      missing('실적심사신청서'),
      missing('실적심사신청서 신청기한'),
      missing('현장설명장소'),
      { label: '현장설명일시', value: '—', note: '참고 화면에 대시(-)로 표시되어 있습니다. 공고 원문을 확인하세요.' },
      {
        label: '입찰참가자격 등록마감',
        value: '2026.10.15 18:00',
        note: '참고 화면 안내: 마감까지 나라장터 경쟁입찰 참가자격 등록 필요. 등록 업무는 평일 09:00~18:00, 토요일 09:00~13:00(본청·서울지방청만), 공휴일 처리 불가.',
        wide: true,
      },
      missing('공동수급협정서 접수여부'),
      missing('공동수급협정서 마감일시'),
      { label: '입찰개시', value: '2026.10.13 10:00' },
      { label: '입찰마감', value: '2026.10.16 10:00', emphasis: true },
      { label: '개찰(입찰)일시', value: '2026.10.16 11:00' },
      { label: '개찰장소', value: '국가종합전자조달시스템(나라장터)' },
      missing('관련공고'),
      { label: '재입찰', value: '허용' },
      missing('현장설명서'),
      { ...missing('공내역서'), note: '진행정보의 공내역서 칸은 미기재입니다. 별도 첨부목록에는 (공)내역서 XLSX가 있습니다.' },
    ],
  },
  {
    id: 'eligibility',
    label: '참가자격 및 투찰제한',
    kicker: 'ELIGIBILITY',
    fields: [
      { label: '참가가능지역', value: '경기도 화성시', emphasis: true },
      missing('지사투찰 허용여부'),
      {
        label: '업종사항제한',
        value: '상·하수도설비공사업 / 4996',
        note: '제한업종에 대해 투찰 가능한 허용업종을 함께 확인하세요.',
        wide: true,
      },
      { label: '제한업종', value: '상·하수도설비공사업' },
      missing('허용업종'),
      missing('공동도급지역'),
      missing('공동도급비율'),
      { label: '내역입찰여부', value: '내역서 첨부안함' },
      { label: '현장설명 제한여부', value: '없음' },
      missing('공동수급체 구성원 지역제한여부'),
      missing('공동수급 구성업체수 제한'),
    ],
  },
  {
    id: 'pricing',
    label: '가격 및 예정금액',
    kicker: 'PRICE & ESTIMATE',
    fields: [
      { label: '추정가격', value: '57,836,364원', emphasis: true, note: '검색·비교의 기준 금액' },
      { label: '기초금액', value: '63,620,000원' },
      { label: '기초금액 A', value: '4,748,790원' },
      { ...missing('순공사원가'), note: '나라장터 API에 값이 제공되지 않았습니다. 0원으로 판단하지 않습니다.' },
      { label: '투찰하한율', value: '89.745%' },
      { label: '예가변동폭', value: '97 ~ 103' },
      { label: '예가방법', value: '복수예가: 4(추첨예가) / 15(총예가)' },
      { label: '추첨번호 공개여부', value: '비공개' },
      { label: '공사예정금액', value: '94,340,000원' },
      { label: '관급금액 · 도급자설치', value: '30,720,000원' },
      { label: '관급금액 · 관급자설치', value: '0원' },
      missing('기초금액 공개 · 비고1'),
      missing('기초금액 공개 · 비고2'),
      missing('기초금액 공개 · 상세보기'),
    ],
  },
  {
    id: 'qualification',
    label: '적격심사',
    kicker: 'QUALIFICATION REVIEW',
    fields: [
      { ...missing('평가기준'), note: '나라장터 공개 원문에 별도 표시가 없습니다.' },
      missing('주공종'),
      { ...missing('공사예정금액'), note: '적격심사 표의 해당 칸은 미기재입니다. 가격정보의 공사예정금액과 별도로 확인하세요.' },
      { ...missing('업종평가비율'), note: '나라장터 원문과 API에 값이 제공되지 않았습니다.' },
      missing('가산지역', true),
    ],
  },
  {
    id: 'fees',
    label: '수수료 및 입찰보증금',
    kicker: 'FEES & BID SECURITY',
    fields: [
      missing('입찰참가수수료 납부'),
      missing('입찰참가수수료 금액'),
      missing('입찰보증금 납부'),
      { label: '채권자명', value: '화성시맑은물사업소' },
    ],
  },
];

export const referenceDocuments: { name: string; extension: 'XLSX' | 'HWPX' | 'PDF'; kind: string }[] = [
  {
    name: '(공)내역서[향남읍 송곡리 403번지 일원 우수관로 정비공사].xlsx',
    extension: 'XLSX',
    kind: '공내역서',
  },
  {
    name: '시방서[향남읍 송곡리 403번지 일원 우수관로 정비공사].hwpx',
    extension: 'HWPX',
    kind: '시방서',
  },
  {
    name: '화성시 맑은물사업소 공고 제2026_193호[향남읍 송곡리 403번지 일원 우수관로 정비공사].hwpx',
    extension: 'HWPX',
    kind: '공고문',
  },
  {
    name: '화성시 맑은물사업소 공고 제2026_193호[향남읍 송곡리 403번지 일원 우수관로 정비공사].pdf',
    extension: 'PDF',
    kind: '공고문',
  },
];
