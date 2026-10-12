import type { G2bBusinessType, G2bDetailField, G2bDetailSection } from '../src/g2b-types.ts';

type Row = Record<string, unknown>;
const text = (value: unknown): string | null => (typeof value === 'string' || typeof value === 'number') && String(value).trim() !== '' ? String(value).trim() : null;
const join = (values: unknown[]) => [...new Set(values.map(text).filter((value): value is string => value !== null))].join(' · ') || null;
function amount(value: unknown): string | null {
  const clean = text(value)?.replaceAll(',', '');
  if (!clean || !/^\d+(?:\.0+)?$/.test(clean)) return null;
  const number = Number(clean);
  return Number.isSafeInteger(number) && number >= 0 ? `${number.toLocaleString('ko-KR')} 원` : null;
}
function rate(value: unknown): string | null {
  const raw = text(value);
  return raw && /^[+-]?\d+(?:\.\d+)?$/.test(raw) ? `${raw}%` : null;
}
function flag(value: unknown, yes = '예', no = '아니오'): string | null {
  const raw = text(value);
  return raw === 'Y' ? yes : raw === 'N' ? no : raw;
}
function date(value: unknown): string | null {
  const raw = text(value);
  return raw ? raw.replace('T', ' ').replace(/(?:\+09:00|Z)$/, '') : null;
}
const field = (key: string, label: string, value: string | null, options: Pick<G2bDetailField, 'note' | 'wide'> = {}): G2bDetailField => ({ key, label, value, ...options });
const unavailable = (key: string, label: string) => field(key, label, null, { note: '연동 API 미제공 항목입니다. 나라장터 원문을 확인해 주세요.' });

/** Explicit public notice allowlist. Blank values remain unknown; never import prototype data. */
export function mapDetailSections(input: {
  row?: Row; type: G2bBusinessType; regionRows?: Row[]; licenseRows?: Row[]; baseRows?: Row[];
}): G2bDetailSection[] {
  const row = input.row || {};
  const s = (key: string, label: string, wide = false) => field(key, label, text(row[key]), wide ? { wide } : {});
  const y = (key: string, label: string, yes?: string, no?: string) => field(key, label, flag(row[key], yes, no));
  const m = (key: string, label: string) => field(key, label, amount(row[key]));
  const d = (key: string, label: string) => field(key, label, date(row[key]));
  const p = (key: string, label: string) => field(key, label, rate(row[key]));
  const sections: G2bDetailSection[] = [
    { id: 'general', label: '공고 일반', fields: [
      s('ntceKindNm', '공고 종류'), d('bidNtceDt', '게시 일시'),
      field('noticeNumber', '입찰공고번호', text(row.bidNtceNo) && text(row.bidNtceOrd) ? `${text(row.bidNtceNo)}-${String(row.bidNtceOrd).padStart(3, '0')}` : null),
      s('refNo', '참조번호'), s('bidNtceNm', '공고명', true), s('ntceInsttNm', '공고 기관'), s('dminsttNm', '수요 기관'),
      s('rgstTyNm', '등록 유형'), s('bidMethdNm', '입찰 방식'), s('cntrctCnclsMthdNm', '계약 방법'),
      unavailable('contractType', '계약 구분'), y('intrbidYn', '국제 입찰', '국제', '국내'), unavailable('internationalReason', '국제 입찰 구분 사유'),
      s('sucsfbidMthdNm', '낙찰 방법', true), s('sucsfbidMthdAppStd', '낙찰 방법 적용 기준', true),
      y('reNtceYn', '재공고 여부'), s('untyNtceNo', '통합 공고번호'), s('chgNtceRsn', '변경 공고 사유', true), d('chgDt', '변경 일시'),
      unavailable('bidItemProgram', '입찰내역 작성 프로그램'), unavailable('quantityStatement', '물량내역서'),
      unavailable('reviewGuideline', '세부 심사요령'), unavailable('surveyStatement', '조사내역서 (관급 포함)'),
    ] },
    { id: 'schedule', label: '입찰 진행 정보', fields: [
      s('exctvNm', '집행관'), d('bidQlfctRgstDt', '입찰참가자격 등록 마감'),
      d('bidBeginDt', '입찰 개시'), d('bidClseDt', '입찰 마감'), d('opengDt', '개찰 일시'), s('opengPlce', '개찰 장소'),
      y('rbidPermsnYn', '재입찰 허용', '허용', '불허'), d('rbidOpengDt', '재입찰 개찰 일시'),
      s('cmmnSpldmdAgrmntRcptdocMethd', '공동수급협정서 제출 방법'), d('cmmnSpldmdAgrmntClseDt', '공동수급협정서 마감'),
      s('pqApplDocRcptMthdNm', 'PQ 신청서 접수 방법'), d('pqApplDocRcptDt', 'PQ 신청서 접수 마감'),
      s('arsltApplDocRcptMthdNm', '실적 신청서 접수 방법'), d('arsltApplDocRcptDt', '실적 신청서 접수 마감'),
      d('dcmtgOprtnDt', '현장설명 일시'), s('dcmtgOprtnPlce', '현장설명 장소'),
      unavailable('samePriceLottery', '동일 가격 입찰 추첨 방식'),
    ] },
    { id: 'eligibility', label: '투찰 제한·공동수급', fields: [
      field('allowedRegions', '참가 가능 지역', join((input.regionRows || []).map(item => item.prtcptPsblRgnNm)), { wide: true }),
      field('licenses', '제한 업종·면허', join((input.licenseRows || []).map(item => item.lcnsLmtNm)), { wide: true }),
      field('permittedIndustries', '허용 업종', join((input.licenseRows || []).map(item => item.permsnIndstrytyList)), { wide: true }),
      field('industryFields', '주력 분야', join((input.licenseRows || []).map(item => item.indstrytyMfrcFldList)), { wide: true }),
      y('indstrytyLmtYn', '업종 제한 여부'), y('brffcBidprcPermsnYn', '지사 투찰 허용'),
      s('rgnLmtBidLocplcJdgmBssNm', '지역 제한 소재지 판단 기준'), y('bidPrtcptLmtYn', '입찰참가 제한 여부'),
      s('cmmnSpldmdMethdNm', '공동수급 방법'), s('cmmnSpldmdCnum', '공동수급 구성업체 수'),
      y('cmmnSpldmdCorpRgnLmtYn', '공동수급 구성원 지역 제한'), y('rgnDutyJntcontrctYn', '지역 의무 공동도급'),
      field('jointRegions', '공동도급 지역', join([row.jntcontrctDutyRgnNm1, row.jntcontrctDutyRgnNm2, row.jntcontrctDutyRgnNm3])),
      p('rgnDutyJntcontrctRt', '지역 의무 공동도급 비율'), y('dtlsBidYn', '내역 입찰'),
      y('dsgntCmptYn', '지명 경쟁'), y('arsltCmptYn', '실적 경쟁'),
      unavailable('bidAmountCeiling', '투찰금액 상한 제한'), unavailable('siteBriefingRestriction', '현장설명 제한'),
      unavailable('gradeRestriction', '등급 제한'), unavailable('mainFieldRestriction', '주력 분야 제한'),
    ] },
    { id: 'tradeShares', label: '공종별 전체 지분율', fields: [
      s('cnsttyAccotShreRateList', '공종별 지분율', true), s('cnstrtnAbltyEvlAmtList', '시공능력평가액', true),
    ] },
    { id: 'construction', label: input.type === '공사' ? '공사 정보' : '사업 정보', fields: [
      y('ciblAplYn', '건설산업기본법 적용'), s('mtltyAdvcPsblYnCnstwkNm', '공사 구분'),
      y('mtltyAdvcPsblYn', '상호시장 진출 허용', '허용', '불허'), unavailable('crossMarketReason', '상호시장 진출 제한 사유'),
      s('cnstrtsiteRgnNm', '공사 현장 지역'), unavailable('constructionPeriod', '공사 기간'),
      unavailable('subcontractAllowed', '하도급지킴이 적용'), unavailable('mutualPayment', '상생결제 여부'),
    ] },
    { id: 'pricing', label: '예정가격·입찰금액', fields: [
      m('presmptPrce', '추정가격'), m('VAT', '부가가치세'), m('bdgtAmt', '공사 예정금액'), m('govsplyAmt', '관급 금액'),
      m('contrctrcnstrtnGovsplyMtrlAmt', '도급자 설치 관급자재'), m('govcnstrtnGovsplyMtrlAmt', '관급자 설치 관급자재'),
      s('prearngPrceDcsnMthdNm', '예정가격 결정 방법'), s('totPrdprcNum', '총 예비가격 수'), s('drwtPrdprcNum', '추첨 예비가격 수'),
      p('sucsfbidLwltRate', '낙찰 하한율'), s('rsrvtnPrceReMkngMthdNm', '재입찰 예정가격 산정', true), unavailable('drawNumberDisclosure', '추첨번호 공개 여부'),
      unavailable('longTermContract', '장기계속계약 여부'), unavailable('pricingNotes', '예정가격·입찰금액 기타 정보'),
    ] },
    { id: 'qualification', label: '심사·주공종', fields: [
      s('aplBssCntnts', '평가 기준'), y('pqEvalYn', 'PQ 심사'), s('mainCnsttyNm', '주공종'), p('indstrytyEvlRt', '업종 평가 비율'),
      m('mainCnsttyCnstwkPrearngAmt', '주공종 공사 예정금액'), m('mainCnsttyPresmptPrce', '주공종 추정가격'),
      y('indstrytyMfrcFldEvlYn', '주력 분야 평가'),
      field('incentiveRegions', '가산 지역', join([row.incntvRgnNm1, row.incntvRgnNm2, row.incntvRgnNm3, row.incntvRgnNm4])),
    ] },
    { id: 'subTrades', label: '부공종', fields: [
      ...Array.from({ length: 9 }, (_, index) => index + 1).flatMap(index => text(row[`subsiCnsttyNm${index}`]) || text(row[`subsiCnsttyIndstrytyEvlRt${index}`]) ? [
        s(`subsiCnsttyNm${index}`, `부공종 ${index}`), p(`subsiCnsttyIndstrytyEvlRt${index}`, `부공종 ${index} 평가 비율`),
      ] : []),
      ...(Array.from({ length: 9 }, (_, index) => index + 1).some(index => text(row[`subsiCnsttyNm${index}`]) || text(row[`subsiCnsttyIndstrytyEvlRt${index}`])) ? [] : [
        field('subTradeInformation', '부공종 정보', null, { note: 'API에 부공종 값이 제공되지 않았습니다. 등록 내역 유무는 나라장터 원문에서 확인해 주세요.', wide: true }),
      ]),
    ] },
    { id: 'fees', label: '수수료·입찰보증금', fields: [
      y('bidPrtcptFeePaymntYn', '입찰참가 수수료 납부'), m('bidPrtcptFee', '입찰참가 수수료'), y('bidGrntymnyPaymntYn', '입찰보증금 납부'),
      s('crdtrNm', '채권자명'), d('bidWgrnteeRcptClseDt', '보증서 접수 마감'),
    ] },
    { id: 'contacts', label: '기관 담당자', fields: [
      s('ntceInsttNm', '공고 기관'), s('ntceInsttOfclNm', '공고 담당자'), s('ntceInsttOfclTelNo', '담당자 전화'),
      s('ntceInsttOfclEmailAdrs', '담당자 이메일'), s('dminsttNm', '수요 기관'), s('dminsttOfclEmailAdrs', '수요 기관 담당자 이메일'),
      unavailable('demandDepartment', '수요 기관 담당 부서'),
      unavailable('demandContactName', '수요 기관 담당자'), unavailable('demandContactPhone', '수요 기관 담당자 전화'), unavailable('demandContactFax', '수요 기관 팩스'),
    ] },
    { id: 'related', label: '연관 정보', fields: [
      unavailable('relatedNotice', '관련 공고'), s('befBidBbancNo', '이전 입찰공고번호'), s('orderPlanUntyNo', '발주계획 통합번호'),
      s('bfSpecRgstNo', '사전규격 등록번호'), d('rgstDt', '등록 일시'),
      unavailable('priorSpecificationPrivateReason', '사전규격 미공개 사유'),
    ] },
  ];
  const baseRows = input.baseRows || [];
  if (baseRows.length > 1) sections.push({ id: 'baseAmount', label: '기초금액 공개', fields: [
    field('baseAmountCount', '공개 내역', `${baseRows.length}건`, { note: '복수 공개 내역은 공고분류와 공개 시점을 각각 확인해 주세요. 서로 다른 내역의 금액을 합산하지 않습니다.', wide: true }),
  ] });
  (baseRows.length ? baseRows : [{}]).forEach((base, index) => {
    const insurances = [
      ['npnInsrprm', '국민연금보험료'], ['mrfnHealthInsrprm', '국민건강보험료'], ['rtrfundNon', '퇴직공제부금비'],
      ['odsnLngtrmrcprInsrprm', '노인장기요양보험료'], ['sftyMngcst', '산업안전보건관리비'], ['sftyChckMngcst', '안전관리비'], ['qltyMngcst', '품질관리비'],
    ];
    const allAmounts = insurances.map(([key]) => amount(base[key]));
    const sum = allAmounts.every(value => value !== null) ? insurances.reduce((total, [key]) => total + Number(String(base[key]).replaceAll(',', '')), 0) : null;
    sections.push({ id: baseRows.length > 1 ? `baseAmount-${index + 1}` : 'baseAmount', label: baseRows.length > 1 ? `기초금액 공개 ${index + 1}` : '기초금액 공개', fields: [
      field('bidClsfcNo', '공고 분류번호', text(base.bidClsfcNo)), field('bssamtOpenDt', '기초금액 공개 일시', date(base.bssamtOpenDt)),
      field('bssamt', '기초금액', amount(base.bssamt)), field('bssAmtPurcnstcst', '순공사원가', amount(base.bssAmtPurcnstcst)),
      field('rsrvtnPrceRngBgnRate', '예가 변동폭 하한', rate(base.rsrvtnPrceRngBgnRate)), field('rsrvtnPrceRngEndRate', '예가 변동폭 상한', rate(base.rsrvtnPrceRngEndRate)),
      field('bidPrceCalclAYn', '입찰가격 A값 적용', flag(base.bidPrceCalclAYn)),
      field('insuranceManagementSum', '보험료·관리비 합계 (계산값)', sum === null ? null : amount(sum), { note: '아래 7개 항목의 단순 합계입니다. 적용 A값과 제외 항목은 공고 원문에서 확인해 주세요.' }),
      ...insurances.map(([key, label]) => field(key, label, amount(base[key]))),
      field('qltyMngcstAObjYn', '품질관리비 A값 적용 대상', flag(base.qltyMngcstAObjYn)),
      field('evlBssAmt', '평가 기준금액', amount(base.evlBssAmt)), field('envCnsrvcst', '환경보전비', amount(base.envCnsrvcst)),
      field('scontrctPayprcePayGrntyFee', '하도급대금 지급보증 수수료', amount(base.scontrctPayprcePayGrntyFee)),
      field('dfcltydgrCfcnt', '난이도 계수', text(base.dfcltydgrCfcnt)),
      ...[['etcGnrlexpnsBssRate', '기타경비 기준율'], ['gnrlMngcstBssRate', '일반관리비 기준율'], ['prftBssRate', '이윤 기준율'], ['lbrcstBssRate', '노무비 기준율']].map(([key, label]) => field(key, label, rate(base[key]))),
      field('rmrk1', '비고 1', text(base.rmrk1), { wide: true }), field('rmrk2', '비고 2', text(base.rmrk2), { wide: true }),
    ] });
  });
  return sections;
}
