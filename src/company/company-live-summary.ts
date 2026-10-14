import type { CompanyHistory, CompanyParticipation, CompanyGroupSummary, PublicCompany } from '../company-types';
import type { CompanyParticipationPage, CompanyParticipationQuery } from '../company-live-types';
import { normalizeAwardDay } from './company-awards';

export function participationPageRestartReason(previous: CompanyParticipationPage[], result: CompanyParticipationPage): string | null {
  if (previous.length && previous[0].totalCount !== result.totalCount) return '조회 도중 제공기관의 전체 건수가 바뀌었습니다. 해당 날짜를 처음부터 다시 확인해야 합니다.';
  if (result.sourceCount > 0 && result.pageFingerprint && previous.some(page => page.page !== result.page && page.pageFingerprint === result.pageFingerprint)) return '제공기관이 같은 페이지를 반복해 반환했습니다. 해당 날짜를 처음부터 다시 확인해야 합니다.';
  return null;
}

export function companyParticipationTasks(businessNumber: string, from: string, to: string): CompanyParticipationQuery[] {
  const start = normalizeAwardDay(from), end = normalizeAwardDay(to);
  if (!start || !end || start > end) throw new Error('조회 시작일과 종료일을 확인해 주세요.');
  const tasks: CompanyParticipationQuery[] = [];
  for (let value = Date.parse(`${end}T00:00:00Z`); value >= Date.parse(`${start}T00:00:00Z`); value -= 86_400_000) {
    const day = new Date(value).toISOString().slice(0, 10);
    for (const type of ['공사', '용역'] as const) tasks.push({ businessNumber, day, type, page: 1 });
  }
  return tasks;
}

export function liveCompanyHistory(company: PublicCompany, records: CompanyParticipation[], options: {
  page: number; outcome: 'all' | 'won'; from: string; to: string; complete: boolean; fetchedAt: string;
}): CompanyHistory {
  const rows = [...new Map(records.map(row => [row.id, row])).values()].sort((a, b) => b.openingAt.localeCompare(a.openingAt) || b.number.localeCompare(a.number));
  const won = rows.filter(row => row.awarded === true);
  const sumMoney = (values: Array<number | null>) => values.some(value => value !== null) ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  const group = (key: (row: CompanyParticipation) => string): CompanyGroupSummary[] => {
    const groups = new Map<string, CompanyParticipation[]>();
    for (const row of rows) { const name = key(row) || '-', entries = groups.get(name); if (entries) entries.push(row); else groups.set(name, [row]); }
    return [...groups.entries()].map(([name, items]) => ({ name, participationCount: items.length, winCount: items.filter(row => row.awarded === true).length, winningAmount: sumMoney(items.filter(row => row.awarded === true).map(row => row.winningAmount)) })).sort((a, b) => b.participationCount - a.participationCount || a.name.localeCompare(b.name));
  };
  const rates = rows.map(row => row.bidRate).filter((value): value is number => value !== null);
  const filtered = options.outcome === 'won' ? won : rows;
  const page = Math.min(Math.max(1, options.page), Math.max(1, Math.ceil(filtered.length / 30)));
  return {
    company, items: filtered.slice((page - 1) * 30, page * 30), page, pageSize: 30, totalCount: filtered.length,
    summary: { participationCount: rows.length, winCount: won.length, pendingCount: rows.filter(row => row.awarded === null).length, winningAmount: sumMoney(won.map(row => row.winningAmount)), bidAmount: sumMoney(rows.map(row => row.bidAmount)), averageBidRate: rates.length ? rates.reduce((sum, value) => sum + value, 0) / rates.length : null },
    monthly: group(row => normalizeAwardDay(row.openingAt)?.slice(0, 7) || '').filter(row => row.name !== '-').map(row => ({ month: row.name, participationCount: row.participationCount, winCount: row.winCount, winningAmount: row.winningAmount })).sort((a, b) => a.month.localeCompare(b.month)),
    agencies: group(row => row.agency), businessTypes: group(row => row.type), methods: group(row => row.method), competitors: [],
    coverage: { status: options.complete ? 'ready' : 'collecting', from: options.from, to: options.to, updatedAt: options.fetchedAt || null, message: options.complete ? '선택한 개찰 기간의 공식 참여 자료 조회를 마쳤습니다.' : '공식 API에서 현재 받은 참여 이력입니다. 아직 조회되지 않은 날짜와 페이지는 포함되지 않았습니다.' },
  };
}
