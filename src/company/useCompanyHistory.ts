import { useEffect, useRef, useState } from 'react';
import type { CompanyHistory, PublicCompany } from '../company-types';
import { companyHistoryPath, watchCompanyHistory, type CompanyIndexFilter } from './company-index';

export function useCompanyHistory(company: PublicCompany | null, filter: CompanyIndexFilter, refresh: number) {
  const key = company ? companyHistoryPath(company.businessNumber, filter) : '';
  const [snapshot, setSnapshot] = useState<{ key: string; history: CompanyHistory | null; error: string; refreshing: boolean }>({ key: '', history: null, error: '', refreshing: false });
  const current = useRef(snapshot);
  current.current = snapshot;
  useEffect(() => {
    if (!company || !key) return;
    const watcher = watchCompanyHistory({ path: key, businessNumber: company.businessNumber,
      initial: current.current.key === key ? current.current.history : null,
      visible: () => document.visibilityState !== 'hidden',
      onUpdate: update => setSnapshot({ key, ...update }),
    });
    const onVisibility = () => watcher.visibilityChanged();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { watcher.stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [key, refresh]);
  const same = snapshot.key === key;
  const history = same ? snapshot.history : null;
  return { history, error: same ? snapshot.error : '', refreshing: same && snapshot.refreshing,
    loading: Boolean(company) && !history && (!same || snapshot.refreshing) };
}
