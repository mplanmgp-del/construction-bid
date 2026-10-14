import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PublicCompany } from '../src/company-types';
import { CompanyAwardsPanel } from '../src/company/CompanyAwardsPanel';

const company: PublicCompany = { businessNumber: '8488802470', name: '조회 업체', representative: '', address: '', phone: '',
  registrationDate: '', companyType: '', licenses: [], products: [], updatedAt: '' };

describe('direct confirmed-award presentation', () => {
  it('waits for the official registration date without reporting missing or zero awards', () => {
    const markup = renderToStaticMarkup(<CompanyAwardsPanel company={company} registrationPending />);
    expect(markup).toContain('확정 낙찰 이력');
    expect(markup).toContain('공식 업체 등록일을 확인하고 있습니다');
    expect(markup).not.toContain('0건');
    expect(markup).not.toContain('낙찰 이력이 없습니다');
    expect(markup).not.toContain('type="date"');
    expect(markup).not.toContain('수집 진행 중');
  });

  it('does not hold an explicit date range for a separate profile refresh', () => {
    const markup = renderToStaticMarkup(<CompanyAwardsPanel company={company} from="2026-09-01" to="2026-10-14" registrationPending />);
    expect(markup).not.toContain('공식 업체 등록일을 확인하고 있습니다');
    expect(markup).toContain('사업자등록번호로 조회한 공식 확정 낙찰');
    expect(markup).not.toContain('수집 진행 중');
  });
});
