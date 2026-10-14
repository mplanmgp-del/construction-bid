import type { QuickLink } from './types';

export const MAX_QUICK_LINKS = 4;
export const QUICK_LINK_LABEL_LIMIT = 24;

/** Saved shortcuts can only navigate to ordinary web pages. */
export function normalizeQuickLinkUrl(input: string): string | null {
  const value = input.trim();
  if (!value) return '';
  if (value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value) || value.startsWith('/')) return null;
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(value);
  const isWebUrl = /^https?:\/\//i.test(value);
  const isHostWithPort = /^(?:localhost|[^/:]+\.[^/:]+):\d+(?:[/?#]|$)/i.test(value);
  if (hasScheme && !isWebUrl && !isHostWithPort) return null;
  try {
    const url = new URL(isWebUrl ? value : `https://${value}`);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function validateQuickLinkDrafts(drafts: QuickLink[]): { links: QuickLink[]; errors: Record<number, string> } {
  const links: QuickLink[] = [];
  const errors: Record<number, string> = {};
  drafts.slice(0, MAX_QUICK_LINKS).forEach((draft, index) => {
    const label = draft.label.trim();
    const url = normalizeQuickLinkUrl(draft.url);
    if (!label && url === '') return;
    if (!url) { errors[index] = '올바른 웹사이트 URL을 입력하세요. http:// 또는 https:// 주소를 사용할 수 있습니다.'; return; }
    if (label.length > QUICK_LINK_LABEL_LIMIT) { errors[index] = `버튼 이름은 ${QUICK_LINK_LABEL_LIMIT}자 이내로 입력하세요.`; return; }
    links.push({ label: label || new URL(url).hostname, url });
  });
  return { links, errors };
}

/** A malformed shortcut must not prevent the rest of a member profile from loading. */
export function readQuickLinks(value: unknown): QuickLink[] {
  if (!Array.isArray(value)) return [];
  const links: QuickLink[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.label !== 'string' || typeof item.url !== 'string') continue;
    const url = normalizeQuickLinkUrl(item.url);
    if (!url) continue;
    links.push({ label: item.label.trim().slice(0, QUICK_LINK_LABEL_LIMIT) || new URL(url).hostname, url });
    if (links.length === MAX_QUICK_LINKS) break;
  }
  return links;
}

export function quickLinkDrafts(value: unknown): QuickLink[] {
  const saved = readQuickLinks(value);
  return Array.from({ length: MAX_QUICK_LINKS }, (_, index) => saved[index] ? { ...saved[index] } : { label: '', url: '' });
}
