import { describe, expect, it } from 'vitest';
import { mapDetailSections } from '../server/g2b-detail';
import type { G2bDetailField, G2bNoticeDetail, G2bRelatedDetail } from '../src/g2b-types';
import { buildNoticePrintDocument } from '../src/print/notice-print-model';
import type { BidNotice } from '../src/types';

const bid: BidNotice = {
  id: '공사-R26BK01764541-000', number: 'R26BK01764541', revision: '000', title: '우수관로 정비공사',
  agency: '화성시 맑은물사업소', type: '공사', category: '토목', province: '경기도', district: '화성시',
  allowedRegions: ['경기도 화성시'], estimatedPrice: 57836364, contractMethod: '수의계약', status: '접수중',
  postedAt: '2026-10-12T15:25:00+09:00', deadline: '2026-10-16T10:00:00+09:00', openingAt: '', registrationDeadline: '',
  licenses: [], duration: '', description: '', requirements: [], revised: false, source: 'live',
  documents: [{ name: '공고.pdf', size: '', url: 'https://www.g2b.go.kr/download?token=omitted' }],
};
const detail = (changes: Partial<G2bNoticeDetail> = {}): G2bNoticeDetail => ({
  number: bid.number, revision: bid.revision, allowedRegions: bid.allowedRegions, licenses: [],
  regionComplete: true, licenseComplete: true, fetchedAt: '2026-10-12T12:00:00+09:00', warnings: [], ...changes,
});
const field = (key: string, value: string | null, note?: string): G2bDetailField => ({ key, label: key, value, ...(note ? { note } : {}) });
const related = (changes: Partial<G2bRelatedDetail> = {}): G2bRelatedDetail => ({
  number: bid.number, revision: bid.revision, type: bid.type, fetchedAt: '', groups: [], warnings: [], ...changes,
});

describe('full notice print projection', () => {
  it('removes exact placeholders and empty sections while preserving zero and explicit negative facts', () => {
    const values = [null, '', ' \n ', '미제공', ' - ', '조회 불가', '공개 내역 없음', '정보  미제공', '0', '0 원', '0%', '없음', '아니오', '미제공 자료는 별도 제출'];
    const result = buildNoticePrintDocument(bid, detail({ sections: [
      { id: 'mixed', label: '제공 자료', fields: values.map((value, index) => field(String(index), value)) },
      { id: 'empty', label: '빈 구역', fields: [field('blank', null)] },
    ] }));
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].fields.map(item => item.value)).toEqual(['0', '0 원', '0%', '없음', '아니오', '미제공 자료는 별도 제출']);
  });

  it('excludes empty histories, lookup guidance, warnings, field notes and attachment URLs', () => {
    const result = buildNoticePrintDocument(bid, detail({ warnings: ['제공자 경고'], sections: [
      { id: 'fees', label: '수수료', fields: [field('fee', '0 원', '일반 주석')] },
    ] }), related({ warnings: ['연관 경고'], groups: [
      { id: 'contractHistory', label: '계약 변경·삭제 이력', status: 'empty', message: '이력을 조회할 연결 계약이 없습니다.', records: [] },
      { id: 'agencies', label: '기관', status: 'ok', message: '기관 조회 안내', records: [{ id: 'one', title: '공공기관', fields: [
        field('telNo', '031-000-0000', '직통번호와 다를 수 있습니다.'), field('lookupPeriod', '2025-10-13 ~ 2026-10-12'),
        field('partyListStatus', '일부 형식 확인 필요'),
      ] }] },
    ] }));
    const text = JSON.stringify(result);
    for (const excluded of ['일반 주석', '경고', '계약 변경·삭제 이력', '조회 안내', '직통번호', '2025-10-13', '일부 형식 확인 필요', 'https://', 'token=']) expect(text).not.toContain(excluded);
    expect(result.documents).toEqual(['공고.pdf']);
    expect(result.sections[1].fields).toEqual([{ label: 'telNo', value: '031-000-0000' }]);
  });

  it('retains public records from a partially unavailable group and drops completely empty records', () => {
    const result = buildNoticePrintDocument(bid, detail(), related({ groups: [{
      id: 'contracts', label: '연결 계약', status: 'unavailable', message: '일부 조회 실패', records: [
        { id: 'valid', title: '정비공사 계약', fields: [field('amount', '0 원')] },
        { id: 'empty', title: '빈 레코드', fields: [field('none', null), field('lookupPeriod', '조회 기간')] },
      ],
    }] }));
    const records = result.sections.filter(section => section.id.startsWith('related-'));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ title: '연결 계약 · 정비공사 계약', fields: [{ label: 'amount', value: '0 원' }] });
    expect(JSON.stringify(result)).not.toContain('일부 조회 실패');
  });

  it.each([
    { number: 'OTHER' }, { revision: '001' },
  ])('rejects mismatched detail identity %j', mismatch => {
    expect(() => buildNoticePrintDocument(bid, detail(mismatch))).toThrow('일치하지 않습니다');
  });

  it.each([
    { number: 'OTHER' }, { revision: '001' }, { type: '용역' as const },
  ])('rejects mismatched refreshed notice or related identity %j', mismatch => {
    expect(() => buildNoticePrintDocument(bid, detail({ notice: { ...bid, ...mismatch } }))).toThrow('일치하지 않습니다');
    expect(() => buildNoticePrintDocument(bid, detail(), related(mismatch))).toThrow('일치하지 않습니다');
  });

  it('preserves the computed sum label and seven-component calculation basis without copying its note', () => {
    const sections = mapDetailSections({ type: '공사', baseRows: [{
      npnInsrprm: '1000', mrfnHealthInsrprm: '2000', rtrfundNon: '0', odsnLngtrmrcprInsrprm: '3000',
      sftyMngcst: '4000', sftyChckMngcst: '5000', qltyMngcst: '0',
    }] });
    const result = buildNoticePrintDocument(bid, detail({ sections }));
    const fields = result.sections.find(section => section.id === 'baseAmount')!.fields;
    expect(fields).toContainEqual({ label: '보험료·관리비 합계 (계산값)', value: '15,000 원' });
    expect(fields).toContainEqual({ label: '합계 산출 근거', value: '국민연금보험료 + 국민건강보험료 + 퇴직공제부금비 + 노인장기요양보험료 + 산업안전보건관리비 + 안전관리비 + 품질관리비' });
    expect(fields).toContainEqual({ label: '품질관리비', value: '0 원' });
    expect(JSON.stringify(result)).not.toContain('공고 원문');
    const incomplete = buildNoticePrintDocument(bid, detail({ sections: mapDetailSections({ type: '공사', baseRows: [{ npnInsrprm: '1000' }] }) }));
    expect(JSON.stringify(incomplete)).not.toContain('합계 산출 근거');
  });

  it('never substitutes base price or contract amount for a missing estimated price', () => {
    const result = buildNoticePrintDocument(bid, detail({ notice: { ...bid, estimatedPrice: null }, sections: [
      { id: 'pricing', label: '입찰금액', fields: [field('presmptPrce', null), field('bssamt', '63,620,000 원')] },
    ] }), related({ groups: [{ id: 'contracts', label: '계약', status: 'ok', records: [{ id: 'one', title: '계약', fields: [field('totCntrctAmt', '70,000,000 원')] }] }] }));
    expect(result.summary.some(item => item.label === '추정가격')).toBe(false);
    expect(result.sections.flatMap(section => section.fields).map(item => item.value)).toEqual(['63,620,000 원', '70,000,000 원']);
  });

  it('uses the latest matching notice, formats fallback dates in Korea time, and avoids fake empty facts', () => {
    const result = buildNoticePrintDocument(bid, detail({ notice: { ...bid, title: '갱신 공고', estimatedPrice: 0, deadline: '2026-10-16T01:00:00Z', documents: [] }, allowedRegions: null }));
    expect(result.title).toBe('갱신 공고');
    expect(result.summary).toContainEqual({ label: '추정가격', value: '0 원' });
    expect(result.summary).toContainEqual({ label: '입찰 마감', value: '2026-10-16 10:00' });
    expect(result.sections.some(section => section.id === 'eligibility')).toBe(false);
    expect(result.documents).toEqual([]);
    expect(result.number).toBe('R26BK01764541-000');
    expect(result.filename).toBe('갱신 공고_R26BK01764541-000.pdf');
  });

  it('keeps all source sections without mutating the data and sanitizes only the download filename', () => {
    const source = detail({ notice: { ...bid, title: '공사: A/B? <자료>' }, sections: [
      { id: 'first', label: '처음', fields: [field('one', '첫 내용')] },
      { id: 'last', label: '마지막', fields: [field('two', '마지막 내용')] },
    ] });
    const before = JSON.stringify(source);
    const result = buildNoticePrintDocument(bid, source);
    expect(result.sections.map(section => section.id)).toEqual(['first', 'last']);
    expect(result.title).toBe('공사: A/B? <자료>');
    expect(result.filename).not.toMatch(/[<>:"/\\|?*]/);
    expect(JSON.stringify(source)).toBe(before);
    result.sections[0].fields[0].value = 'changed';
    expect(JSON.stringify(source)).toBe(before);
  });
});
