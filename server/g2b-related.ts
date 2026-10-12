import type { G2bBusinessType, G2bDetailField, G2bRelatedDetail, G2bRelatedGroup, G2bRelatedRecord } from '../src/g2b-types.ts';

type Row = Record<string, unknown>;
type ProviderPage = { items: Row[]; totalCount: number };
export type RelatedRequest = (base: string, operation: string, params: Record<string, string>, timeoutMs?: number) => Promise<ProviderPage>;
const BID_BASE = 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService/';
const PROCESS_BASE = 'https://apis.data.go.kr/1230000/ao/CntrctProcssIntgOpenService/';
const CONTRACT_BASE = 'https://apis.data.go.kr/1230000/ao/CntrctInfoService/';
const USER_BASE = 'https://apis.data.go.kr/1230000/ao/UsrInfoService02/';
const text = (value: unknown): string | null => (typeof value === 'string' || typeof value === 'number') && String(value).trim() ? String(value).trim() : null;
const field = (key: string, label: string, value: unknown, note?: string): G2bDetailField => ({ key, label, value: text(value), ...(note ? { note } : {}) });
const money = (value: unknown) => {
  const raw = text(value)?.replaceAll(',', '');
  if (!raw || !/^\d+(?:\.0+)?$/.test(raw) || !Number.isSafeInteger(Number(raw))) return null;
  return `${Number(raw).toLocaleString('ko-KR')} 원`;
};
const rate = (value: unknown) => { const raw = text(value); return raw && /^\d+(?:\.\d+)?$/.test(raw) ? `${raw}%` : null; };
const flag = (value: unknown) => value === 'Y' ? '예' : value === 'N' ? '아니오' : text(value);
function officialUrl(value: unknown): string | undefined {
  try { const url = new URL(text(value) || ''); return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && (url.hostname === 'g2b.go.kr' || url.hostname.endsWith('.g2b.go.kr')) ? url.href : undefined; }
  catch { return; }
}
const exactNotice = (row: Row, number: string, revision: string, type: G2bBusinessType) => text(row.bidNtceNo) === number && /^\d{1,3}$/.test(text(row.bidNtceOrd) || '') && String(row.bidNtceOrd).trim().padStart(3, '0') === revision && (!text(row.bsnsDivNm) || text(row.bsnsDivNm) === type);

/** The official lists use [cell^cell] records, not JSON. Never shift malformed cells into money/company columns. */
export function readOfficialList(value: unknown, columns = 8): { rows: string[][]; malformed: boolean } {
  const raw = text(value);
  if (!raw) return { rows: [], malformed: false };
  const matches = [...raw.matchAll(/\[([^\[\]]*)\]/g)];
  const rest = raw.replace(/\[[^\[\]]*\]/g, '').replace(/[\s,]/g, '');
  const parts = matches.map(match => match[1].split('^').map(cell => cell.trim()));
  return { rows: parts.filter(cells => cells.length === columns && /^\d+$/.test(cells[0])), malformed: Boolean(rest) || parts.length === 0 || parts.some(cells => cells.length !== columns || !/^\d+$/.test(cells[0])) };
}

/** New notices use three-digit revisions; legacy responses may append two digits or omit them entirely. */
export function contractMatches(row: Row, number: string, revision: string, exactLinkedContracts: Set<string>): boolean {
  const raw = text(row.ntceNo);
  const forms = new Set([`${number}${revision}`, `${number}-${revision}`]);
  if (/^\d{11}$/.test(number) && Number(revision) <= 99) { forms.add(`${number}${String(Number(revision)).padStart(2, '0')}`); forms.add(`${number}-${String(Number(revision)).padStart(2, '0')}`); }
  if (raw && forms.has(raw)) return true;
  // Bare/missing notice numbers are only sufficient when the exact revision's process response links this contract.
  return (!raw || raw === number) && Boolean(text(row.dcsnCntrctNo)) && exactLinkedContracts.has(String(row.dcsnCntrctNo).trim());
}

function processRecord(row: Row, index: number, sourceUrl: string): G2bRelatedRecord {
  return { id: `process-${index}`, title: text(row.bidNtceNm) || '공고의 조달 진행 과정', sourceUrl, fields: [
    field('orderPlanNo', '발주계획번호', row.orderPlanNo), field('orderPlanUntyNo', '발주계획 통합번호', row.orderPlanUntyNo),
    field('orderBizNm', '발주 사업명', row.orderBizNm), field('orderInsttNm', '발주 기관', row.orderInsttNm), field('orderYm', '발주 년월', row.orderYm),
    field('prcrmntMethdNm', '조달 방식', row.prcrmntMethdNm), field('cntrctCnclsMthdNm', '계약 방법', row.cntrctCnclsMthdNm),
    field('bfSpecRgstNo', '사전규격 등록번호', row.bfSpecRgstNo), field('bfSpecBizNm', '사전규격 사업명', row.bfSpecBizNm),
    field('bfSpecDminsttNm', '사전규격 수요 기관', row.bfSpecDminsttNm), field('bfSpecNtceInsttNm', '사전규격 공고 기관', row.bfSpecNtceInsttNm),
    field('opninRgstClseDt', '의견 등록 마감', row.opninRgstClseDt), field('prcrmntReqNo', '조달요청번호', row.prcrmntReqNo),
    field('bidNtceNo', '입찰공고번호', row.bidNtceNo), field('bidNtceOrd', '입찰공고차수', row.bidNtceOrd),
    field('bidDminsttNm', '입찰 수요 기관', row.bidDminsttNm), field('bidMthdNm', '입찰 방법', row.bidMthdNm), field('bidNtceDt', '공고 일시', row.bidNtceDt),
  ] };
}
function contractRecord(row: Row, index: number): G2bRelatedRecord {
  const companies = readOfficialList(row.corpList, 10);
  const institutions = readOfficialList(row.dminsttList, 7);
  return { id: `contract-${text(row.untyCntrctNo) || index}`, title: text(row.cnstwkNm) || text(row.cntrctNm) || text(row.servcNm) || '관련 계약',
    sourceUrl: officialUrl(row.cntrctDtlInfoUrl) || officialUrl(row.cntrctInfoUrl), fields: [
      field('untyCntrctNo', '통합계약번호', row.untyCntrctNo), field('dcsnCntrctNo', '확정계약번호', row.dcsnCntrctNo),
      field('cntrctRefNo', '계약 참조번호', row.cntrctRefNo), field('ntceNo', '연결 공고번호', row.ntceNo), field('reqNo', '요청번호', row.reqNo),
      field('cntrctCnclsDate', '계약 체결일', row.cntrctCnclsDate), field('cntrctPrd', '계약 기간', row.cntrctPrd),
      field('totCntrctAmt', '총계약금액', money(row.totCntrctAmt)), field('thtmCntrctAmt', '금차 계약금액', money(row.thtmCntrctAmt)),
      field('cntrctInsttNm', '계약 기관', row.cntrctInsttNm), field('cntrctInsttChrgDeptNm', '계약 담당 부서', row.cntrctInsttChrgDeptNm),
      field('cntrctCnclsMthdNm', '계약 체결방법', row.cntrctCnclsMthdNm), field('lngtrmCtnuDivNm', '장기계속 구분', row.lngtrmCtnuDivNm),
      field('cmmnCntrctYn', '공동계약 여부', flag(row.cmmnCntrctYn)), field('baseLawNm', '근거 법률', row.baseLawNm),
      field('payDivNm', '지급 구분', row.payDivNm), field('grntymnyRate', '보증금률', rate(row.grntymnyRate)),
      field('cbgnDate', '착공일', row.cbgnDate), field('thtmCcmpltDate', '금차 준공일', row.thtmCcmpltDate), field('ttalCcmpltDate', '총 준공일', row.ttalCcmpltDate),
      ...(row.bsnsDivNm === '용역' || 'wbgnDate' in row ? [field('wbgnDate', '용역 착수일', row.wbgnDate), field('thtmScmpltDate', '금차 완수일', row.thtmScmpltDate), field('ttalScmpltDate', '총 완수일', row.ttalScmpltDate)] : []),
      field('chgDt', '변경 일시', row.chgDt),
      ...companies.rows.flatMap((cells, companyIndex) => [
        field(`company-${companyIndex}-name`, `계약업체 ${companyIndex + 1}`, cells[3]), field(`company-${companyIndex}-role`, `업체 ${companyIndex + 1} 역할`, cells[1]),
        field(`company-${companyIndex}-joint`, `업체 ${companyIndex + 1} 공동도급 방식`, cells[2]), field(`company-${companyIndex}-share`, `업체 ${companyIndex + 1} 지분율`, rate(cells[6])),
        field(`company-${companyIndex}-businessNumber`, `업체 ${companyIndex + 1} 사업자번호`, cells[9]),
      ]),
      ...institutions.rows.flatMap((cells, institutionIndex) => [
        field(`demand-${institutionIndex}-code`, `수요기관 ${institutionIndex + 1} 코드`, cells[1]), field(`demand-${institutionIndex}-name`, `수요기관 ${institutionIndex + 1}`, cells[2]),
        field(`demand-${institutionIndex}-jurisdiction`, `수요기관 ${institutionIndex + 1} 소관`, cells[3]), field(`demand-${institutionIndex}-department`, `수요기관 ${institutionIndex + 1} 부서`, cells[4]),
      ]),
      ...(companies.malformed || institutions.malformed ? [field('partyListStatus', '계약 관계자 목록', '일부 형식 확인 필요', '형식이 다른 항목은 임의로 연결하지 않았습니다. 계약 원문에서 확인해 주세요.')] : []),
    ] };
}
function agencyRecord(row: Row, roles: string[], index: number): G2bRelatedRecord {
  return { id: `agency-${text(row.dminsttCd)}-${index}`, title: text(row.dminsttNm) || '기관 등록정보', fields: [
    field('role', '공고와의 관계', roles.join(' · ')), field('dminsttCd', '기관 코드', row.dminsttCd), field('dminsttNm', '기관명', row.dminsttNm),
    field('jrsdctnDivNm', '소관 구분', row.jrsdctnDivNm), field('insttTyCdLrgclsfcNm', '기관 유형', row.insttTyCdLrgclsfcNm),
    field('rgnNm', '기관 소재 지역', row.rgnNm), field('zip', '우편번호', row.zip),
    field('adrs', '기관 주소', [text(row.adrs), text(row.dtlAdrs)].filter(Boolean).join(' ') || null),
    field('telNo', '기관 대표 전화', row.telNo, '개별 공고 담당자의 직통번호와 다를 수 있습니다.'), field('faxNo', '기관 팩스', row.faxNo),
    field('toplvlInsttNm', '최상위 기관', row.toplvlInsttNm), field('hmpgAdrs', '기관 홈페이지', row.hmpgAdrs),
    field('vldPrdBgnDt', '등록 유효기간 시작', row.vldPrdBgnDt), field('vldPrdEndDt', '등록 유효기간 종료', row.vldPrdEndDt),
    field('dltYn', '기관 등록 삭제 여부', flag(row.dltYn)), field('rgstDt', '기관 등록 일시', row.rgstDt), field('chgDt', '기관 변경 일시', row.chgDt),
  ] };
}

export function createRelatedLoader(request: RelatedRequest, now: () => number = Date.now) {
  return async (number: string, revision: string, type: G2bBusinessType): Promise<G2bRelatedDetail> => {
    const finishBy = now() + 30_000;
    const warnings: string[] = [];
    const sourceUrl = `https://www.g2b.go.kr/link/PNPE027_01/?${new URLSearchParams({ bidPbancNo: number, bidPbancOrd: revision })}`;
    const get = (base: string, operation: string, params: Record<string, string>) => {
      const remaining = finishBy - now();
      if (remaining <= 0) return Promise.reject(new Error('Related lookup time limit'));
      return request(base, operation, params, Math.min(12_000, remaining));
    };
    const [general, process, contracts] = await Promise.allSettled([
      get(BID_BASE, type === '공사' ? 'getBidPblancListInfoCnstwk' : 'getBidPblancListInfoServc', { inqryDiv: '2', bidNtceNo: number, bidNtceOrd: revision, pageNo: '1', numOfRows: '999' }),
      get(PROCESS_BASE, type === '공사' ? 'getCntrctProcssIntgOpenCnstwk' : 'getCntrctProcssIntgOpenServc', { inqryDiv: '1', bidNtceNo: number, bidNtceOrd: revision, pageNo: '1', numOfRows: '100' }),
      get(CONTRACT_BASE, type === '공사' ? 'getCntrctInfoListCnstwkPPSSrch' : 'getCntrctInfoListServcPPSSrch', { inqryDiv: '4', ntceNo: number, pageNo: '1', numOfRows: '100' }),
    ]);
    const groups: G2bRelatedGroup[] = [];
    const processRows = process.status === 'fulfilled' ? process.value.items.filter(row => exactNotice(row, number, revision, type)) : [];
    const processUnavailable = process.status === 'rejected' || (process.status === 'fulfilled' && process.value.totalCount > 0 && processRows.length === 0);
    groups.push({ id: 'process', label: '발주·사전규격·조달 과정', status: processRows.length ? 'ok' : processUnavailable ? 'unavailable' : 'empty', records: processRows.map((row, index) => processRecord(row, index, sourceUrl)),
      ...(!processRows.length ? { message: processUnavailable ? '해당 공고·차수의 조달 과정을 확인하지 못했습니다. 서비스 승인 상태 또는 나라장터 원문을 확인해 주세요.' : '공개된 연관 과정이 없습니다. 발주계획·사전규격이 생략되는 공고도 있습니다.' } : {}) });
    if (processUnavailable) warnings.push('조달 과정 정보를 확인하지 못했습니다.');
    if (process.status === 'fulfilled' && process.value.totalCount > process.value.items.length) warnings.push('조달 과정 조회 결과가 많아 첫 100건 중 정확히 일치하는 공고만 표시했습니다.');
    const awardLists = processRows.map(row => readOfficialList(row.bidwinrInfoList));
    const contractLists = processRows.map(row => readOfficialList(row.cntrctInfoList));
    const malformedAwards = awardLists.some(list => list.malformed), malformedContracts = contractLists.some(list => list.malformed);
    const awards = awardLists.flatMap(list => list.rows);
    const linkedContracts = contractLists.flatMap(list => list.rows);
    if (malformedAwards || malformedContracts) warnings.push('일부 통합 공개 목록의 형식을 확인하지 못해 해당 행을 표시하지 않았습니다.');
    groups.push({ id: 'awards', label: '공개 낙찰 정보', status: awards.length ? 'ok' : processUnavailable || malformedAwards ? 'unavailable' : 'empty',
      message: '공개 낙찰 자료이며 회원의 실제 투찰 접수 또는 제출완료 증명이 아닙니다.',
      records: awards.map((cells, index) => ({ id: `award-${index}`, title: cells[1] || '낙찰 업체', sourceUrl, fields: [
        field('company', '낙찰 업체', cells[1]), field('businessNumber', '사업자등록번호', cells[2]), field('amount', '낙찰금액', money(cells[4])),
        field('rate', '낙찰률', rate(cells[5])), field('participants', '참가 업체 수', /^\d+$/.test(cells[6]) ? `${Number(cells[6]).toLocaleString('ko-KR')}개` : null), field('openedAt', '개찰 일시', cells[7]),
      ] })),
    });
    const linkedIds = new Set(linkedContracts.map(cells => cells[1]).filter(Boolean));
    const contractRows = contracts.status === 'fulfilled' ? contracts.value.items.filter(row => (!text(row.bsnsDivNm) || text(row.bsnsDivNm) === type) && contractMatches(row, number, revision, linkedIds)) : [];
    const records = contractRows.map(contractRecord);
    const directIds = new Set(contractRows.map(row => text(row.dcsnCntrctNo)));
    linkedContracts.filter(cells => !directIds.has(cells[1])).forEach((cells, index) => records.push({ id: `process-contract-${index}`, title: cells[2] || '통합 공개 관련 계약', sourceUrl, fields: [
      field('source', '자료 출처', '계약과정통합공개서비스'), field('contractNumber', '계약번호', cells[1]), field('contractAgency', '계약 기관', cells[3]),
      field('demandAgency', '수요 기관', cells[4]), field('contractMethod', '계약 방법', cells[5]), field('contractAmount', '계약금액', money(cells[6])), field('contractDate', '계약일', cells[7]),
    ] }));
    const contractsUnavailable = contracts.status === 'rejected' || malformedContracts || (contracts.status === 'fulfilled' && contracts.value.totalCount > 0 && !contractRows.length && !linkedContracts.length);
    groups.push({ id: 'contracts', label: '관련 계약', status: records.length ? 'ok' : contractsUnavailable ? 'unavailable' : 'empty', records,
      ...(!records.length ? { message: contractsUnavailable ? '해당 공고·차수와 정확히 연결된 계약을 확인하지 못했습니다. 차수가 없는 계약은 임의로 연결하지 않습니다.' : '현재 조회된 공개 계약 내역이 없습니다. 계약 진행 여부는 나라장터 원문을 확인해 주세요.' } : {}) });
    if (contractsUnavailable) warnings.push('계약 상세 조회가 완전하지 않습니다. 표시된 통합 공개 자료와 원문을 함께 확인해 주세요.');
    if (contracts.status === 'fulfilled' && contracts.value.totalCount > contracts.value.items.length) warnings.push('계약 조회 결과가 많아 첫 100건 중 확인된 연관 계약만 표시했습니다.');

    const contractIds = [...new Set(contractRows.map(row => text(row.untyCntrctNo)).filter((id): id is string => Boolean(id) && /^[a-zA-Z0-9_-]{1,60}$/.test(id!)))];
    const historyTasks = contractIds.slice(0, 3).flatMap(id => (['change', 'delete'] as const).map(kind => ({ id, kind })));
    const historyPromise = Promise.allSettled(historyTasks.map(async task => {
      const operation = `getCntrctInfoList${type === '공사' ? 'Cnstwk' : 'Servc'}${task.kind === 'change' ? 'ChgHstry' : 'DltHstry'}`;
      const result = await get(CONTRACT_BASE, operation, { inqryDiv: '2', untyCntrctNo: task.id, pageNo: '1', numOfRows: '100' });
      return { ...task, result };
    }));

    const generalRows = general.status === 'fulfilled' && general.value.items.length >= general.value.totalCount ? general.value.items.filter(row => exactNotice(row, number, revision, type)) : [];
    const notice = generalRows.length === 1 ? generalRows[0] : undefined;
    const agencyCodes = new Map<string, string[]>();
    for (const [key, role] of [['ntceInsttCd', '공고 기관'], ['dminsttCd', '수요 기관']]) {
      const code = text(notice?.[key]);
      if (code && /^[a-zA-Z0-9]{1,20}$/.test(code)) agencyCodes.set(code, [...(agencyCodes.get(code) || []), role]);
    }
    const koreaDay = new Date(now() + 9 * 3600_000).toISOString().slice(0, 10);
    const agencyResults = await Promise.allSettled([...agencyCodes].map(async ([code, roles]) => {
      let end = Date.parse(`${koreaDay}T00:00:00Z`);
      let last: { result: ProviderPage; rows: Row[]; period: string } | undefined;
      // The provider rejects multi-year ranges. Search at most three non-overlapping
      // 365-calendar-day change windows, stopping at the shared request deadline.
      for (let window = 0; window < 3; window++) {
        const begin = end - 364 * 86_400_000;
        const beginDay = new Date(begin).toISOString().slice(0, 10), endDay = new Date(end).toISOString().slice(0, 10);
        const result = await get(USER_BASE, 'getDminsttInfo02', { inqryDiv: '2', inqryBgnDt: beginDay.replaceAll('-', '') + '0000', inqryEndDt: endDay.replaceAll('-', '') + '2359', dminsttCd: code, pageNo: '1', numOfRows: '100' });
        last = { result, rows: result.items.filter(row => text(row.dminsttCd) === code), period: `${beginDay} ~ ${endDay} (변경일 기준)` };
        if (last.rows.length || result.totalCount > result.items.length) break;
        end = begin - 86_400_000;
      }
      return { code, roles, ...last! };
    }));
    const agencyRecords: G2bRelatedRecord[] = [];
    let agencyUncertain = agencyCodes.size === 0;
    for (const result of agencyResults) {
      if (result.status === 'rejected') { agencyUncertain = true; continue; }
      if (!result.value.rows.length || result.value.result.items.length < result.value.result.totalCount) agencyUncertain = true;
      result.value.rows.forEach((row, index) => {
        const record = agencyRecord(row, result.value.roles, index);
        agencyRecords.push({ ...record, fields: [...record.fields, field('lookupPeriod', '기관 조회 기간', result.value.period)] });
      });
    }
    groups.push({ id: 'agencies', label: '공고·수요 기관 등록정보', status: agencyRecords.length ? 'ok' : 'unavailable', records: agencyRecords,
      message: agencyUncertain ? '최근 3개 연간 구간의 변경일 기준으로 일부 기관 정보를 확인하지 못했습니다. 기관 미등록을 뜻하지 않습니다.' : '기관 변경일 기준으로 조회했습니다. 각 카드의 조회 기간과 등록 유효기간을 함께 확인해 주세요.' });
    if (agencyUncertain) warnings.push('기관 코드 또는 기관 등록정보를 모두 확인하지 못했습니다.');
    const historyResults = await historyPromise;
    const historyRecords: G2bRelatedRecord[] = [];
    let historyUncertain = contractIds.length > 3 || (!historyTasks.length && records.length > 0) || contractsUnavailable;
    const knownContractIds = new Set([...linkedIds, ...contractRows.map(row => text(row.dcsnCntrctNo)).filter((id): id is string => Boolean(id))]);
    for (const result of historyResults) {
      if (result.status === 'rejected') { historyUncertain = true; continue; }
      const { id, kind, result: page } = result.value;
      const items = page.items.filter(row => text(row.untyCntrctNo) === id && (!text(row.bsnsDivNm) || text(row.bsnsDivNm) === type)
        && (!text(row.ntceNo) || text(row.ntceNo) === number || contractMatches(row, number, revision, knownContractIds)));
      if (page.totalCount > page.items.length || (page.totalCount > 0 && !items.length)) historyUncertain = true;
      items.forEach((row, index) => {
        const entry = kind === 'change' ? contractRecord(row, index) : {
          id: '', title: '계약 삭제 이력', fields: [
            field('untyCntrctNo', '통합계약번호', row.untyCntrctNo), field('dcsnCntrctNo', '확정계약번호', row.dcsnCntrctNo),
            field('cntrctRefNo', '계약 참조번호', row.cntrctRefNo), field('dltDt', '삭제 일시', row.dltDt), field('chgDivNm', '변경 구분', row.chgDivNm),
            field('rgstDt', '등록 일시', row.rgstDt), field('chgDt', '변경 일시', row.chgDt),
          ],
        };
        historyRecords.push({ ...entry, id: `history-${id}-${kind}-${index}`, title: kind === 'change' ? `${entry.title} · 변경 이력` : `계약 ${id} · 삭제 이력`, fields: [field('historyKind', '이력 종류', kind === 'change' ? '변경' : '삭제'), ...entry.fields] });
      });
    }
    const historyStatus = historyRecords.length ? 'ok' : historyUncertain ? 'unavailable' : 'empty';
    groups.push({ id: 'contractHistory', label: '계약 변경·삭제 이력', status: historyStatus, records: historyRecords,
      message: historyUncertain ? '연결된 통합계약번호 최대 3건의 변경·삭제 이력을 조회합니다. 일부 이력은 조회 한도 또는 응답 상태로 확인하지 못했습니다.' : historyRecords.length ? '계약 이력 자료입니다. 현재 계약 내용과 변경·삭제 시점을 구분해서 확인해 주세요.' : historyTasks.length ? '조회된 공개 변경·삭제 이력이 없습니다.' : '이력을 조회할 연결 계약이 현재 제공되지 않았습니다.' });
    if (historyUncertain) warnings.push('계약 변경·삭제 이력을 모두 확인하지 못했습니다.');
    return { number, revision, type, fetchedAt: new Date(now()).toISOString(), groups, warnings };
  };
}
