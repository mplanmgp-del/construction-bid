import { useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { createWorkspaceRepository, getMemberClient } from './client';
import { detachBrowserPushOnLogout } from '../alerts/push-client';
import { MemberWorkspaceController, type DraftStorage, type MemberWorkspace, type WorkspaceSnapshot } from './workspace';

const EMPTY: WorkspaceSnapshot = { data: null, status: 'loading', error: null, ready: false };
function browserStorage(): DraftStorage | undefined { try { return window.localStorage; } catch { return undefined; } }
function authError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'invalid_credentials') return '이메일 또는 비밀번호가 올바르지 않습니다.';
  if (code === 'email_not_confirmed') return '가입한 이메일의 인증 링크를 먼저 확인해 주세요.';
  if (code.includes('rate_limit')) return '요청이 많습니다. 잠시 후 다시 시도해 주세요.';
  if (code === 'weak_password') return '비밀번호가 계정 보안 기준에 맞지 않습니다. 더 길고 다른 비밀번호를 사용해 주세요.';
  if (code === 'user_already_exists') return '이미 가입된 이메일입니다. 로그인해 주세요.';
  return '계정 요청을 처리하지 못했습니다. 입력 내용과 연결 상태를 확인한 뒤 다시 시도해 주세요.';
}

export function useMemberWorkspace() {
  const [client] = useState(getMemberClient);
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(Boolean(client));
  const [authMessage, setAuthMessage] = useState('');
  const [authFailure, setAuthFailure] = useState<string | null>(null);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(EMPTY);
  const controllerRef = useRef<MemberWorkspaceController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (!client) return () => { mounted.current = false; };
    let authEventSeen = false;
    const { data: { subscription } } = client.auth.onAuthStateChange((event, nextSession) => {
      authEventSeen = true;
      setSession(nextSession);
      setAuthLoading(false);
      if (event === 'PASSWORD_RECOVERY') setRecoveryMode(true);
      if (event === 'SIGNED_OUT') setRecoveryMode(false);
      // Supabase methods run in effects, never within this synchronous auth callback.
    });
    void client.auth.getSession().then(({ data, error }) => {
      if (!mounted.current || authEventSeen) return;
      setSession(data.session); setAuthLoading(false);
      if (error) setAuthFailure('로그인 상태를 확인하지 못했습니다. 다시 로그인해 주세요.');
    }).catch(() => { if (mounted.current) { setAuthLoading(false); setAuthFailure('로그인 상태를 확인하지 못했습니다.'); } });
    return () => { mounted.current = false; subscription.unsubscribe(); };
  }, [client]);

  const userId = session?.user.id;
  const email = session?.user.email ?? '';
  useEffect(() => {
    setSnapshot(EMPTY);
    if (!client || !userId) { controllerRef.current = null; return; }
    const controller = new MemberWorkspaceController(userId, email, createWorkspaceRepository(client), browserStorage());
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(() => setSnapshot(controller.getSnapshot()));
    void controller.load();
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (controller.hasUnsavedChanges()) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { unsubscribe(); controller.dispose(); controllerRef.current = null; window.removeEventListener('beforeunload', beforeUnload); };
  }, [client, userId, email]);

  async function accountRequest(request: () => Promise<{ error: unknown }>, successMessage = ''): Promise<boolean> {
    if (!client) { setAuthFailure('회원 서비스 연결을 준비 중입니다.'); return false; }
    setAuthLoading(true); setAuthFailure(null); setAuthMessage('');
    try {
      const result = await request();
      if (result.error) throw result.error;
      if (mounted.current) setAuthMessage(successMessage);
      return true;
    } catch (error) { if (mounted.current) setAuthFailure(authError(error)); return false; }
    finally { if (mounted.current) setAuthLoading(false); }
  }
  const redirectTo = () => `${window.location.origin}${window.location.pathname}`;

  return {
    configured: Boolean(client), loading: authLoading || Boolean(userId && snapshot.status === 'loading'),
    user: session?.user ?? null,
    // An old user's snapshot must never leak for a frame after an account change.
    workspace: snapshot.data?.profile.id === userId ? snapshot.data : null,
    ready: Boolean(userId && snapshot.data?.profile.id === userId && snapshot.ready),
    saveStatus: snapshot.status, error: authFailure || (userId ? snapshot.error : null), authMessage, recoveryMode,
    signIn: (emailAddress: string, password: string) => accountRequest(() => client!.auth.signInWithPassword({ email: emailAddress.trim(), password })),
    signUp: (emailAddress: string, password: string) => accountRequest(() => client!.auth.signUp({ email: emailAddress.trim(), password, options: { emailRedirectTo: redirectTo() } }), '가입 확인 메일을 확인해 주세요. 인증 후 로그인할 수 있습니다.'),
    requestPasswordReset: (emailAddress: string) => accountRequest(() => client!.auth.resetPasswordForEmail(emailAddress.trim(), { redirectTo: redirectTo() }), '가입된 이메일이면 비밀번호 재설정 안내를 보냈습니다. 받은 편지함을 확인해 주세요.'),
    updatePassword: async (password: string) => {
      const result = await accountRequest(() => client!.auth.updateUser({ password }), '비밀번호를 변경했습니다.');
      if (result) setRecoveryMode(false);
      return result;
    },
    signOut: async () => {
      const controller = controllerRef.current;
      if (controller?.hasUnsavedChanges() && !(await controller.flush())) {
        setAuthFailure('변경 내용을 저장하지 못해 로그아웃하지 않았습니다. 먼저 다시 저장하거나 임시저장 파일을 내려받아 주세요.');
        return false;
      }
      await detachBrowserPushOnLogout();
      return accountRequest(() => client!.auth.signOut({ scope: 'local' }));
    },
    updateWorkspace: (updater: (current: MemberWorkspace) => MemberWorkspace) => controllerRef.current?.update(updater),
    retrySave: () => controllerRef.current?.flush(),
    retryLoad: () => controllerRef.current?.load(),
    downloadDraftAndReload: async () => {
      const controller = controllerRef.current;
      const data = controller?.getSnapshot().data;
      if (!data) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = '입찰관리_미저장내용.json'; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      await controller.reloadCloudAfterBackup();
      setAuthFailure(null);
    },
  };
}
export type MemberWorkspaceAccess = ReturnType<typeof useMemberWorkspace>;
