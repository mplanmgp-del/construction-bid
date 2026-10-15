import { useEffect, useRef, useState } from 'react';
import { Bell, BellOff, LoaderCircle, Send } from 'lucide-react';
import { disableBrowserPush, enableBrowserPush, getBrowserPushState, prepareBrowserPush, testBrowserPush, type BrowserPushState } from './push-client';

export interface BrowserPushControlsProps {
  publicKey: string | null;
  configured?: boolean;
  enabled?: boolean;
  disabled?: boolean;
  onChanged?: () => unknown;
}
export function BrowserPushControls({ publicKey, configured = Boolean(publicKey), enabled = true, disabled = false, onChanged }: BrowserPushControlsProps) {
  const [state, setState] = useState<BrowserPushState | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setReady(false); setError(''); setState(null);
    if (!configured || !publicKey) return () => { active = false; };
    void prepareBrowserPush(publicKey).then(() => getBrowserPushState()).then(next => {
      if (active) { setState(next); setReady(true); }
    }).catch(reason => { if (active) { setError(reason instanceof Error ? reason.message : '브라우저 알림을 준비하지 못했습니다.'); setReady(false); } });
    return () => { active = false; };
  }, [publicKey, configured, retry]);
  function enable() {
    if (!publicKey) return;
    setBusy(true); setError(''); setMessage('');
    // Do not await preparation, auth, or an API call before this invocation.
    const enrollment = enableBrowserPush(publicKey);
    void enrollment.then(async next => { if (mounted.current) { setState(next); setMessage('이 브라우저의 알림을 켰습니다.'); await onChanged?.(); } })
      .catch(reason => { if (mounted.current) setError(reason instanceof Error ? reason.message : '브라우저 알림을 켜지 못했습니다.'); })
      .finally(() => { if (mounted.current) setBusy(false); });
  }
  async function disable() {
    setBusy(true); setError(''); setMessage('');
    try { await disableBrowserPush(); const next = await getBrowserPushState(); if (mounted.current) { setState(next); setMessage('이 브라우저의 알림을 껐습니다.'); await onChanged?.(); } }
    catch (reason) { const next = await getBrowserPushState().catch(() => null); if (mounted.current) { setError(reason instanceof Error ? reason.message : '브라우저 알림을 끄지 못했습니다.'); setState(next); } }
    finally { if (mounted.current) setBusy(false); }
  }
  async function test() {
    setBusy(true); setError(''); setMessage('');
    try { await testBrowserPush(); if (mounted.current) setMessage('테스트 알림을 요청했습니다. 잠시 후 알림이 오지 않으면 브라우저와 운영체제의 알림 허용 상태를 확인해 주세요.'); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : '테스트 알림을 보내지 못했습니다.'); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <section className="alert-push-controls" aria-label="이 브라우저 푸시 알림">
    <div className="alert-push-heading"><Bell size={19} /><div><strong>이 브라우저 알림</strong><p>{state?.subscribed ? '현재 계정의 알림을 이 브라우저에서 받고 있습니다.' : '화면을 닫아도 새 맞춤공고와 변경 사항을 알림으로 받습니다.'}</p></div></div>
    {!configured || !publicKey ? <p className="alert-push-note">브라우저 알림 연결을 준비 중입니다. 맞춤공고는 알림함에서 확인할 수 있습니다.</p> : <>
      <div className="alert-push-actions">
        {state?.subscribed || state?.endpoint ? <button type="button" className="button button-secondary" onClick={() => void disable()} disabled={busy || disabled}><BellOff size={16} />이 브라우저 알림 끄기</button> : <button type="button" className="button button-primary" onClick={enable} disabled={!ready || busy || disabled || !enabled}>{busy || !ready ? <LoaderCircle size={16} className="spin" /> : <Bell size={16} />}이 브라우저 알림 켜기</button>}
        {state?.subscribed && <button type="button" className="button button-secondary" onClick={() => void test()} disabled={busy || disabled || !enabled}><Send size={16} />테스트 알림</button>}
      </div>
      {!enabled && <p className="alert-push-note">맞춤 알림을 켠 뒤 브라우저 알림을 설정해 주세요.</p>}
      {state?.permission === 'denied' && <p className="alert-push-note">사이트 알림이 차단되어 있습니다. 브라우저 사이트 설정에서 알림을 허용해 주세요.</p>}
      <p className="alert-push-note">기기마다 따로 설정합니다. 아이폰·아이패드는 홈 화면에 추가한 앱에서 사용할 수 있습니다.</p>
    </>}
    {message && <p role="status" className="alert-push-message">{message}</p>}
    {error && <p role="alert" className="alert-push-error">{error}</p>}
    {error && !ready && configured && publicKey && <button type="button" className="button button-secondary" onClick={() => setRetry(value => value + 1)} disabled={busy || disabled}>알림 연결 다시 확인</button>}
  </section>;
}
