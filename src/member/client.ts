import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { validateWorkspace, WorkspaceConflict, type WorkspaceRepository } from './workspace';

let client: SupabaseClient | null | undefined;
export function getMemberClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = import.meta.env.VITE_SUPABASE_URL?.trim();
  const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY)?.trim();
  if (!url || !key || key.startsWith('sb_secret_')) return client = null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) return client = null;
    // Reject a mistakenly configured legacy service-role JWT as well as new secret keys.
    if (key.split('.').length === 3) {
      const payload = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload.role !== 'anon') return client = null;
    }
    client = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'construction-bid.auth' } });
  } catch { client = null; }
  return client;
}

export function createWorkspaceRepository(supabase: SupabaseClient): WorkspaceRepository {
  return {
    async load(userId, signal) {
      const { data, error } = await supabase.from('bid_member_workspaces').select('data,updated_at').eq('user_id', userId).abortSignal(signal).maybeSingle();
      if (error) throw error;
      return data ? { data: validateWorkspace(data.data, userId), updatedAt: data.updated_at } : null;
    },
    async save(userId, workspace, expectedUpdatedAt, signal) {
      const query = expectedUpdatedAt === null
        ? supabase.from('bid_member_workspaces').insert({ user_id: userId, data: workspace })
        : supabase.from('bid_member_workspaces').update({ data: workspace }).eq('user_id', userId).eq('updated_at', expectedUpdatedAt);
      const { data, error } = await query.select('updated_at').abortSignal(signal).maybeSingle();
      if (error?.code === '23505' || (!error && !data)) throw new WorkspaceConflict('Concurrent update');
      if (error) throw error;
      return data!.updated_at as string;
    },
  };
}
