/** Keep a small, plain-text search corpus without persisting raw provider objects. */
export const REGION_SEARCH_TEXT_LIMIT = 16_000;

const privateField = /(?:service.?key|api.?key|authorization|password|passwd|secret|token|credential|email|e.?mail|tel(?:no)?|phone|fax|url|uri|href|link)/i;
const usefulField = /(?:addr|adres|address|rgn|region|plce|place|site|instt|agency|ntce.?nm|title|dtllist)/i;
const provinceName = /서울(?:특별시)?|부산(?:광역시)?|대구(?:광역시)?|인천(?:광역시)?|광주(?:광역시|시)?|대전(?:광역시)?|울산(?:광역시)?|세종(?:특별자치시|시)?|경기(?:도)?|강원(?:특별자치도|도)?|충청북도|충청남도|충북|충남|전북(?:특별자치도)?|전라북도|전라남도|전남(?:광주통합특별시)?|경상북도|경상남도|경북|경남|제주(?:특별자치도|도)?/gu;

function plainText(value: string): string {
  return value.normalize('NFKC')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/(?:https?:\/\/|ftp:\/\/|file:\/\/|www\.)[^\s<>"']+/gi, ' ')
    .replace(/(?:service.?key|api.?key|authorization|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos);/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Region names may occur in a title, an agency, an address or a nested private
 * works list. Only Korean-bearing text is useful for the Korean region filter;
 * numeric codes, credentials, contacts and URLs never enter this corpus.
 */
export function noticeRegionSearchText(...sources: unknown[]): string {
  const fragments: { text: string; priority: number }[] = [];
  const regionalWords = new Set<string>();
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (value: unknown, key = '', depth = 0): void => {
    if (++nodes > 10_000 || depth > 10 || privateField.test(key)) return;
    if (typeof value === 'string') {
      const cleaned = plainText(value);
      if (/[가-힣]/.test(cleaned)) {
        // Scan the whole value before bounding generic prose: a place name at
        // the end of a long body must remain searchable in the compact index.
        for (const name of cleaned.matchAll(provinceName)) regionalWords.add(name[0]);
        // A linear scan also handles a suffix followed by a Korean particle,
        // e.g. "파장동에서", without retrying a regex at every body position.
        for (const word of cleaned.matchAll(/[가-힣]+/gu)) {
          for (let index = 1; index < word[0].length; index++) {
            if ('시군구읍면동리'.includes(word[0][index])) regionalWords.add(word[0].slice(Math.max(0, index - 31), index + 1));
          }
        }
        fragments.push({ text: cleaned, priority: usefulField.test(key) ? 0 : 1 });
      }
      return;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
    } else {
      // Put address and geographic fields ahead of potentially large bodies.
      for (const [name, item] of Object.entries(value).sort(([a], [b]) => Number(usefulField.test(b)) - Number(usefulField.test(a)))) visit(item, name, depth + 1);
    }
  };
  for (const source of sources) visit(source);
  for (const text of regionalWords) fragments.push({ text, priority: -1 });
  const unique = new Set<string>();
  const output: string[] = [];
  let length = 0;
  for (const { text } of fragments.sort((a, b) => a.priority - b.priority)) {
    if (unique.has(text)) continue;
    unique.add(text);
    const remaining = REGION_SEARCH_TEXT_LIMIT - length - (output.length ? 1 : 0);
    if (remaining <= 0) break;
    // Keep space for other fields when a provider sends a very large body.
    const part = text.slice(0, Math.min(remaining, 4_000));
    output.push(part);
    length += part.length + (output.length > 1 ? 1 : 0);
  }
  return output.join('\n');
}
