import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PublicCompany } from '../src/company-types';
import type { CompanyContract } from '../src/company-contract-types';
import { CompanyContractRecords, CompanyContractsPanel } from '../src/company/CompanyContractsPanel';

const company: PublicCompany = { businessNumber: '8488802470', name: '조회 업체', representative: '', address: '', phone: '',
  registrationDate: '', companyType: '', licenses: [], products: [], updatedAt: '' };

describe('direct contract presentation', () => {
  it('waits for an official registration date without inventing an empty history or start date', () => {
    const markup = renderToStaticMarkup(<CompanyContractsPanel company={company} registrationPending />);
    expect(markup).toContain('수주·계약 이력');
    expect(markup).toContain('공식 업체 등록일을 확인하고 있습니다');
    expect(markup).not.toContain('0건');
    expect(markup).not.toContain('type="date"');
    expect(markup).not.toContain('수집 진행 중');
  });

  it('uses an explicit range even while a profile registration date is being refreshed', () => {
    const markup = renderToStaticMarkup(<CompanyContractsPanel company={company} from="2026-09-01" to="2026-10-14" registrationPending />);
    expect(markup).not.toContain('공식 업체 등록일을 확인하고 있습니다');
    expect(markup).toContain('수의계약');
    expect(markup).not.toContain('수집 진행 중');
  });

  it('presents no-notice direct contracts separately from bid rates and preserves unknown fields', () => {
    const row: CompanyContract = { id: `contract:${'a'.repeat(64)}`, businessNumber: company.businessNumber, companyName: company.name,
      type: '공사', title: '공고 없이 체결된 공사', agency: '', contractDate: '2026-10-07', contractNumber: 'CONTRACT001',
      unifiedContractNumber: '', referenceNumber: '', noticeNumber: '', method: '수의계약', contractAmount: 40640000,
      totalContractAmount: 40640000, shareRate: 100, sourceUrl: '', registeredAt: '', changedAt: '' };
    const markup = renderToStaticMarkup(<CompanyContractRecords rows={[row]} />);
    expect(markup).toContain('공고 없이 체결된 공사');
    expect(markup).toContain('40,640,000원');
    expect(markup).toContain('수의계약');
    expect(markup).toContain('<td>-</td>');
    expect(markup).not.toContain('투찰률');
    expect(markup).not.toContain('낙찰률');
    expect(markup).not.toContain('100%');
    const unknown = renderToStaticMarkup(<CompanyContractRecords rows={[{ ...row, title: '', method: '', contractAmount: null }]} />);
    expect(unknown).not.toContain('미제공');
    expect(unknown).not.toContain('0원');
    expect(unknown).toContain('<strong>-</strong>');
    expect(unknown).toContain('company-contracts-money">-</td>');
  });
});
