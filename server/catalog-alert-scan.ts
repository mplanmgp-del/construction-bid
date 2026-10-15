import { matchAlertNotice } from '../src/alerts/domain.ts';
import type { AlertNotice, WorkerRule } from '../src/alerts/types.ts';
import type { ActiveCatalogPage, ActiveCatalogPageQuery, ActiveCatalogStatus } from '../src/live/active-catalog-types.ts';
import type { AlertProvider } from './alert-collector.ts';

interface CatalogReader {
  page(query: ActiveCatalogPageQuery): Promise<ActiveCatalogPage>;
  enrich?: (notice: AlertNotice) => Promise<unknown>;
}
export async function scanCatalogForAlerts(catalog: CatalogReader, provider: AlertProvider, rules: WorkerRule[],
  initialCursor: string | null, commit: (notices: AlertNotice[]) => Promise<void>, deadline: number, now = Date.now(), maxRequests = 30,
  scope: Pick<ActiveCatalogPageQuery, 'changedSince' | 'changedThrough'> = {}) {
  let cursor = initialCursor, requests = 0, processed = 0, status: ActiveCatalogStatus | null = null;
  const result = (complete: boolean, error?: string) => ({ cursor, complete, processed, requests, status, ...(error ? { error } : {}) });
  const seen = new Set<string>();
  while (Date.now() < deadline - 15_000) {
    const page = await catalog.page({ ...scope, cursor, limit: 100, includeInactive: true }); status = page.status;
    if (!Array.isArray(page.groups) || page.nextCursor && seen.has(page.nextCursor)) throw new Error('전체 공고 비교 위치를 확인하지 못했습니다.');
    const pending: AlertNotice[] = []; let last = cursor, stop = false, error = '';
    for (const group of page.groups) {
      if (Date.now() > deadline - 15_000) { stop = true; break; }
      const latest = group.latest;
      let region = false, license = false;
      for (const rule of rules) {
        const relaxed = { ...rule.settings, filter: { ...rule.settings.filter, includeUnknown: true } };
        if (!matchAlertNotice(latest, relaxed, rule.profile, now).matched) continue;
        const filter = rule.settings.filter, basis = filter.regionBasis ?? 'auto';
        region ||= !latest.regionComplete && (filter.useCompanyRegion || filter.regions.length > 0
          && (basis === 'participation' || basis === 'either' || basis === 'both' || basis === 'auto' && latest.type === '용역'));
        license ||= !latest.licenseComplete && (filter.licenses.length > 0 || filter.useCompanyLicenses === true);
      }
      const needed = Number(region) + Number(license);
      if (requests + needed > maxRequests) { stop = true; break; }
      let notice = latest;
      try {
        if (needed) {
          const exact = { inqryDiv: '2', bidNtceNo: latest.number, bidNtceOrd: latest.revision };
          const load = async (operation: string) => {
            requests++; const rows = await provider(operation, exact);
            if (rows.some(row => !/^\d{1,3}$/.test(String(row.bidNtceOrd ?? '').trim()) || String(row.bidNtceNo ?? '').trim() !== latest.number
              || String(row.bidNtceOrd ?? '').trim().padStart(3, '0') !== latest.revision
              || row.bsnsDivNm && String(row.bsnsDivNm).trim() !== latest.type)) throw new Error('공고 참가조건의 번호·차수를 확인하지 못했습니다.');
            return rows;
          };
          const [regions, licenses] = await Promise.all([region ? load('getBidPblancListInfoPrtcptPsblRgn') : null, license ? load('getBidPblancListInfoLicenseLimit') : null]);
          const values = (rows: Record<string, unknown>[], key: string) => {
            const names = rows.map(row => String(row[key] ?? '').trim());
            if (names.some(name => !name)) throw new Error('공고 참가조건이 불완전하여 다음 확인 때 다시 시도합니다.');
            return [...new Set(names)];
          };
          notice = { ...latest, ...(regions ? { allowedRegions: values(regions, 'prtcptPsblRgnNm'), regionComplete: true } : {}),
            ...(licenses ? { licenses: values(licenses, 'lcnsLmtNm'), licenseComplete: true } : {}) };
          const stored = await catalog.enrich?.(notice);
          if (stored && typeof stored === 'object' && 'ok' in stored && stored.ok === false) throw new Error('공고 참가조건 저장을 확인하지 못했습니다. 다음 확인 때 다시 시도합니다.');
        }
      } catch (cause) { stop = true; error = cause instanceof Error ? cause.message : '공고 참가조건 확인을 다음 확인 때 이어갑니다.'; break; }
      pending.push(...group.versions.map(item => item.revision === notice.revision ? notice : item));
      last = group.key; processed++;
    }
    if (pending.length) { await commit(pending); cursor = last; }
    if (stop) return result(false, error || undefined);
    if (!page.nextCursor) { cursor = null; return result(true); }
    cursor = page.nextCursor; seen.add(cursor);
  }
  return result(false);
}
