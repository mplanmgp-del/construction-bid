import { useEffect, useState } from 'react';
import { Check, LockKeyhole, ShieldCheck, UnlockKeyhole } from 'lucide-react';
import { APP_MENUS, DEFAULT_MAINTENANCE_MESSAGE, type MenuKey, type MenuSetting } from './types';
import type { useMenuAccess } from './useMenuAccess';
import './admin.css';

type Access = ReturnType<typeof useMenuAccess>;
export function AdminPage({ access, onLogin }: { access: Access; onLogin: () => void }) {
  if (!access.ready) return <section className="admin-state" aria-live="polite"><ShieldCheck size={30} /><h1>관리자 확인</h1>
    <p>{access.error || '메뉴 설정과 관리자 권한을 확인하고 있습니다.'}</p>{access.error && <button onClick={() => void access.refresh()}>다시 확인</button>}</section>;
  if (!access.isAdmin) return <section className="admin-state"><LockKeyhole size={30} /><h1>관리자 전용 페이지</h1>
    <p>관리자로 등록된 계정으로 로그인해 주세요.</p><button onClick={onLogin}>로그인</button></section>;
  return <div className="admin-page">
    <header className="admin-page-header"><div className="admin-page-emblem"><ShieldCheck size={26} /></div><div><p className="admin-eyebrow">사이트 관리</p><h1>메뉴 이용 설정</h1><p>메뉴별 이용 여부와 점검 안내를 설정할 수 있습니다.</p></div></header>
    <div className="admin-preview-note"><ShieldCheck size={18} /><span>관리자 계정은 잠긴 메뉴도 확인할 수 있습니다. 일반 사용자에게는 점검 안내가 표시됩니다.</span></div>
    {access.error && <div className="admin-error" role="alert">{access.error}</div>}
    <div className="admin-menu-grid">{APP_MENUS.map(menu => <MenuCard key={menu.key} menu={menu}
      setting={access.settings.find(row => row.menu_key === menu.key)!} saving={access.saving} update={access.update} />)}</div>
  </div>;
}

function MenuCard({ menu, setting, saving, update }: {
  menu: typeof APP_MENUS[number]; setting: MenuSetting; saving: MenuKey | null; update: Access['update'];
}) {
  const [locked, setLocked] = useState(setting.locked);
  const [message, setMessage] = useState(setting.message);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setLocked(setting.locked); setMessage(setting.message); }, [setting.locked, setting.message]);
  const dirty = locked !== setting.locked || message.trim() !== setting.message;
  async function save() { setSaved(false); if (await update(menu.key, locked, message)) setSaved(true); }
  return <section className={`admin-menu-card${setting.locked ? ' is-locked' : ''}`} aria-labelledby={`admin-menu-${menu.key}`}>
    <div className="admin-menu-card-heading"><div><h2 id={`admin-menu-${menu.key}`}>{menu.label}</h2><p>{menu.description}</p></div>
      <span className={`admin-menu-status ${setting.locked ? 'locked' : 'open'}`}>{setting.locked ? <LockKeyhole size={14} /> : <UnlockKeyhole size={14} />}{setting.locked ? '잠금' : '이용 가능'}</span></div>
    <label className="admin-lock-control"><span><strong>메뉴 잠금</strong><small>켜면 일반 사용자의 이용을 제한합니다.</small></span>
      <input className="admin-toggle-input" type="checkbox" role="switch" aria-label={`${menu.label} 메뉴 잠금`} checked={locked} disabled={Boolean(saving)} onChange={event => { setLocked(event.target.checked); setSaved(false); }} /><span className="admin-toggle" aria-hidden="true" /></label>
    <label className="admin-message-label" htmlFor={`admin-message-${menu.key}`}>점검 안내 문구</label>
    <textarea id={`admin-message-${menu.key}`} maxLength={300} rows={3} value={message} disabled={Boolean(saving)} placeholder={DEFAULT_MAINTENANCE_MESSAGE}
      onChange={event => { setMessage(event.target.value); setSaved(false); }} />
    <div className="admin-menu-card-footer"><span className="admin-save-state" role="status">{saved ? <><Check size={15} />저장했습니다</> : dirty ? '저장 전 변경사항' : setting.updated_at ? `최근 변경 ${new Date(setting.updated_at).toLocaleDateString('ko-KR')}` : ''}</span>
      <button className="admin-save-button" disabled={Boolean(saving) || !dirty} onClick={() => void save()} aria-label={`${menu.label} 설정 저장`}>{saving === menu.key ? '저장 중…' : '저장'}</button></div>
  </section>;
}

export function LockedMenu({ menu, setting, loading = false, onLogin, onRetry }: {
  menu: MenuKey; setting?: MenuSetting; loading?: boolean; onLogin: () => void; onRetry: () => void;
}) {
  const label = APP_MENUS.find(item => item.key === menu)?.label || '메뉴';
  return <section className="admin-state locked-menu" aria-live="polite"><div className="locked-menu-icon"><LockKeyhole size={30} /></div>
    <p className="admin-eyebrow">{label}</p><h1>{loading ? '이용 상태를 확인하고 있습니다' : '서비스 점검 중입니다'}</h1>
    <p>{loading ? '잠시만 기다려 주세요.' : setting?.message.trim() || DEFAULT_MAINTENANCE_MESSAGE}</p>
    {!loading && <div className="locked-menu-actions"><button onClick={onRetry}>다시 확인</button><button className="admin-secondary" onClick={onLogin}>관리자 로그인</button></div>}</section>;
}
