import { useId, useState, type FormEvent } from 'react';
import { Cloud, LogIn, ShieldCheck, UserRound } from 'lucide-react';
import type { MemberWorkspaceAccess } from './useMemberWorkspace';
import { PREPARATION_STAGES, type BidPreparationRecord } from './workspace';
import type { BidNotice } from '../types';

export function MemberAccess({ member }: { member: MemberWorkspaceAccess }) {
  const id = useId();
  const [mode, setMode] = useState<'login' | 'signup' | 'reset'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const success = member.recoveryMode ? await member.updatePassword(password)
      : mode === 'login' ? await member.signIn(email, password)
      : mode === 'signup' ? await member.signUp(email, password)
      : await member.requestPasswordReset(email);
    if (success) setPassword('');
  }
  const form = <form className="member-auth-form" onSubmit={submit}>
    <div className="member-auth-heading"><ShieldCheck size={20} /><div><strong>{member.recoveryMode ? '새 비밀번호 설정' : mode === 'signup' ? '회원가입' : mode === 'reset' ? '비밀번호 재설정' : '회원 로그인'}</strong><p>내 업체 정보와 관심공고를 계정에 저장합니다.</p></div></div>
    {!member.recoveryMode && <label htmlFor={`${id}-email`}>이메일<input id={`${id}-email`} type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} required disabled={member.loading} /></label>}
    {(mode !== 'reset' || member.recoveryMode) && <label htmlFor={`${id}-password`}>{member.recoveryMode ? '새 비밀번호' : '비밀번호'}<input id={`${id}-password`} type="password" autoComplete={mode === 'signup' || member.recoveryMode ? 'new-password' : 'current-password'} minLength={mode === 'signup' || member.recoveryMode ? 8 : undefined} value={password} onChange={event => setPassword(event.target.value)} required disabled={member.loading} />{(mode === 'signup' || member.recoveryMode) && <small>8자 이상으로 입력해 주세요.</small>}</label>}
    <button className="button button-primary" disabled={member.loading}>{member.loading ? '처리 중…' : member.recoveryMode ? '비밀번호 변경' : mode === 'signup' ? '가입하기' : mode === 'reset' ? '재설정 메일 받기' : '로그인'}</button>
    {!member.recoveryMode && <div className="member-auth-links">{(['login', 'signup', 'reset'] as const).filter(value => value !== mode).map(value => <button type="button" key={value} onClick={() => { setMode(value); setPassword(''); }}>{value === 'login' ? '로그인' : value === 'signup' ? '회원가입' : '비밀번호 찾기'}</button>)}</div>}
  </form>;

  return <section className="member-access" aria-label="회원 계정">
    {!member.configured ? <div className="member-summary"><Cloud size={18} /><div><strong>회원 저장 기능 연결 준비 중</strong><p>공고를 먼저 검색해 보세요. 회원 서비스 연결 후 업체 정보와 관심공고를 계정에 저장할 수 있습니다.</p></div></div>
      : member.recoveryMode ? form
      : member.user ? <div className="member-summary"><UserRound size={19} /><div><strong>{member.workspace?.profile.companyName || '업체 정보를 등록해 주세요'}</strong><p>{member.user.email} · {member.saveStatus === 'saving' ? '저장 중…' : member.saveStatus === 'loading' ? '정보 불러오는 중…' : member.saveStatus === 'saved' ? '계정에 저장됨' : '미저장 변경 확인 필요'}</p></div><button className="button button-secondary" onClick={() => void member.signOut()} disabled={member.loading || member.saveStatus === 'saving'}>로그아웃</button></div>
      : <details className="member-login-details"><summary><LogIn size={18} /><strong>로그인하고 내 업체로 입찰 관리</strong><span>로그인 · 회원가입</span></summary>{form}</details>}
    {member.error && <div className="member-feedback member-error" role="alert"><p>{member.error}</p>{member.user && <div className="member-error-actions">{member.ready ? <button className="button button-secondary" disabled={member.saveStatus === 'saving'} onClick={() => void member.retrySave()}>다시 저장</button> : member.workspace ? <button className="button button-secondary" onClick={() => void member.downloadDraftAndReload()}>임시저장 다운로드 후 서버 정보 불러오기</button> : <button className="button button-secondary" onClick={() => void member.retryLoad()}>다시 불러오기</button>}</div>}</div>}
    {member.authMessage && <p className="member-feedback" role="status">{member.authMessage}</p>}
  </section>;
}

export function BidPreparation({ bidId, bid, member }: { bidId: string; bid?: BidNotice; member: MemberWorkspaceAccess }) {
  const id = useId();
  const record = member.workspace?.preparations[bidId];
  function update(patch: Partial<BidPreparationRecord>) {
    member.updateWorkspace(current => ({ ...current,
      ...(bid ? { bookmarks: [...new Set([...current.bookmarks, bidId])], noticeSnapshots: { ...current.noticeSnapshots, [bidId]: bid } } : {}),
      preparations: { ...current.preparations,
      [bidId]: { ...(current.preparations[bidId] ?? { stage: '검토중', note: '' }), ...patch, updatedAt: new Date().toISOString() },
    } }));
  }
  return <section className="member-preparation" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`}>우리 업체의 투찰 준비</h3>
    <p>진행 상태와 메모는 내 계정에만 저장됩니다. 제출완료는 나라장터 접수 확인 후 직접 표시해 주세요.</p>
    {bid && <p>준비 기록을 입력하면 관심공고에도 저장됩니다.</p>}
    {!member.user ? <p className="member-login-hint">로그인 후 준비 상태와 메모를 저장할 수 있습니다.</p> : <>
      <label htmlFor={`${id}-stage`}>준비 상태<select id={`${id}-stage`} value={record?.stage ?? '검토중'} onChange={event => update({ stage: event.target.value as BidPreparationRecord['stage'] })} disabled={!member.ready}>{PREPARATION_STAGES.map(stage => <option key={stage}>{stage}</option>)}</select></label>
      <label htmlFor={`${id}-note`}>담당자 메모<textarea id={`${id}-note`} rows={4} maxLength={10000} placeholder="준비할 서류, 담당자, 확인할 사항을 기록하세요." value={record?.note ?? ''} onChange={event => update({ note: event.target.value })} disabled={!member.ready} /></label>
      <small role="status">{member.saveStatus === 'saving' ? '저장 중…' : member.saveStatus === 'saved' ? '변경 내용이 자동으로 저장됩니다.' : '저장 상태를 계정 안내에서 확인해 주세요.'}</small>
    </>}
  </section>;
}
