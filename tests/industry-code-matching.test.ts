import { describe, expect, it } from 'vitest';
import { filterNotices } from '../src/domain';
import { alertNoticeKey, matchAlertNotice, meaningfulChanges, noticeContentKey } from '../src/alerts/domain';
import { planAlertChanges } from '../server/alert-planner';
import { noticeIndustryCodes, resolveIndustrySelection } from '../src/industry-codes';
import { DEFAULT_ALERT_SETTINGS, type AlertNotice } from '../src/alerts/types';
import { DEFAULT_FILTERS, DEMO_PROFILES, NOTICES } from '../src/data';

const now = Date.parse('2026-10-16T12:00:00+09:00');
const notice = (patch: Partial<AlertNotice> & { licenseCodes?: string[] } = {}): AlertNotice => ({
  ...NOTICES[0], source: 'live', status: '접수중', deadline: '2026-10-20T10:00:00+09:00',
  openingAt: '2026-10-20T11:00:00+09:00', sourceUpdatedAt: '2026-10-16T10:00:00+09:00',
  regionComplete: true, licenseComplete: true, licenses: ['표시용 업종명'], licenseCodes: undefined, ...patch,
});
const rule = (licenses: string[], includeUnknown = false) => ({
  ...structuredClone(DEFAULT_ALERT_SETTINGS), enabled: true,
  filter: { ...structuredClone(DEFAULT_ALERT_SETTINGS.filter), keywords: [], licenses, includeUnknown },
});
const search = (items: AlertNotice[], license: string) => filterNotices(items,
  { ...DEFAULT_FILTERS, category: '전체', status: '전체', license }, DEMO_PROFILES[0], now);

describe('official industry-code matching across search and automatic lookup', () => {
  it('matches the exact code even if the display name differs', () => {
    const item = notice({ licenseCodes: ['0042'], licenses: ['다른 표시명'] });
    expect(search([item], '원하는 업종 (0042)')).toEqual([item]);
    expect(matchAlertNotice(item, rule(['0042']), null, now)).toMatchObject({ matched: true, needsReview: false });
  });
  it('does not let identical display names override different official codes', () => {
    const item = notice({ licenseCodes: ['0043'], licenses: ['표시용 업종명 (0042)'] });
    expect(search([item], '표시용 업종명 (0042)')).toEqual([]);
    expect(matchAlertNotice(item, rule(['표시용 업종명 (0042)']), null, now).matched).toBe(false);
  });
  it('preserves leading zeroes and accepts any one of several exact codes', () => {
    const item = notice({ licenseCodes: ['0042', '1234'] });
    expect(search([item], '0042')).toEqual([item]);
    expect(matchAlertNotice(item, rule(['0041', '1234']), null, now).matched).toBe(true);
    expect(matchAlertNotice(item, rule(['42']), null, now).matched).toBe(false);
  });
  it('keeps name-only legacy facts unknown and follows the include-unknown setting', () => {
    const item = notice({ licenses: ['표시용 업종명'], licenseCodes: undefined });
    expect(search([item], '표시용 업종명 (0042)')).toEqual([]);
    expect(matchAlertNotice(item, rule(['0042']), null, now).matched).toBe(false);
    expect(matchAlertNotice(item, rule(['0042'], true), null, now)).toMatchObject({ matched: true, needsReview: true });
  });
  it('reads exact provider code suffixes without deriving a code from a name', () => {
    const item = notice({ licenses: ['공식 표시명/0042'], licenseCodes: undefined });
    expect(search([item], '0042')).toEqual([item]);
    expect(matchAlertNotice(item, rule(['업체 표시명 (0042) · 등록']), null, now)).toMatchObject({ matched: true, needsReview: false });
  });
  it('uses company official codes rather than company and notice name equality', () => {
    const settings = rule([]); settings.filter.useCompanyLicenses = true;
    const profile = { ...DEMO_PROFILES[0], licenses: ['회사 표기'], licenseCodes: ['0042'] };
    expect(matchAlertNotice(notice({ licenses: ['다른 표기'], licenseCodes: ['0042'] }), settings, profile, now)).toMatchObject({ matched: true, needsReview: false });
    expect(matchAlertNotice(notice({ licenses: ['회사 표기'], licenseCodes: ['0043'] }), settings, profile, now).matched).toBe(false);
  });
  it('reports changes to known official codes while ignoring first-time code backfill', () => {
    const before = notice({ licenseCodes: ['0042'] });
    expect(meaningfulChanges(before, notice({ licenseCodes: ['0043'] }))).toContain('요구 업종코드');
    expect(meaningfulChanges(notice({ licenseCodes: undefined }), before)).not.toContain('요구 업종코드');
    expect(noticeContentKey(before)).not.toBe(noticeContentKey(notice({ licenseCodes: ['0043'] })));
  });
  it('preserves the saved observation fingerprint and sends no change for first-time code enrichment', () => {
    const legacy=notice({ licenseCodes: undefined }), key=alertNoticeKey(legacy), settings=rule([]);
    const result=planAlertChanges([notice({ licenseCodes:['0042'] })],
      [{key,notice:legacy,fingerprint:'saved-fingerprint',version:3}],
      [{userId:'user',key,lastVersion:3}],[{userId:'user',settings,profile:null}],now);
    expect(result.events).toEqual([]);
    expect(result.observations[0]).toMatchObject({fingerprint:'saved-fingerprint',version:3});
  });
  it('normalizes verified exact names but never maps a partial or broad industry heading', () => {
    expect(resolveIndustrySelection('구조물해체ㆍ비계공사업')).toBe('4995');
    expect(resolveIndustrySelection('석면해체.제거업')).toBe('5652');
    expect(resolveIndustrySelection('건설폐기물수집·운반업')).toBe('6728');
    expect(resolveIndustrySelection('구조물해체')).toBeNull();
    expect(resolveIndustrySelection('엔지니어링사업')).toBeNull();
  });
  it('treats explicit empty or malformed code facts as unknown instead of falling back to a name suffix', () => {
    for (const licenseCodes of [[], null, '0042', [42]]) {
      const item=notice({ licenses:['업종명/0042'], licenseCodes:licenseCodes as unknown as string[] });
      expect(noticeIndustryCodes(item)).toEqual([]);
      expect(matchAlertNotice(item,rule(['0042'],true),null,now)).toMatchObject({matched:true,needsReview:true});
    }
  });
});
