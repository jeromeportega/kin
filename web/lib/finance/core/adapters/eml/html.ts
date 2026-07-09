/**
 * Shared, retailer-agnostic HTML helpers for email-receipt parsing. Every
 * function here is LINEAR in input length — email HTML is attacker-controllable
 * (a From-spoofed message can carry a giant body), so no helper may use a regex
 * that backtracks catastrophically.
 */

/** Cap HTML before scanning. Real retailer receipt emails are well under 300 KB;
 *  the cap bounds work on adversarial input. */
export const MAX_HTML_BYTES = 512 * 1024;

/** Cap on extracted rows/cells so a pathological table can't spray the item list. */
export const MAX_BLOCKS = 2000;

/**
 * Extract the inner content of each `<tag>…</tag>` block by a LINEAR indexOf
 * scan. A regex like `/<tr>([\s\S]*?)<\/tr>/g` is O(n²) on unclosed tags — a
 * ReDoS vector on email HTML (~100s on a 1.8 MB flood). This scan is O(n): each
 * indexOf advances past what it consumed. Tag matching is name-exact (so `<tr>`
 * doesn't match `<track>`). Not nesting-aware (parity with a non-greedy regex);
 * callers' reconciliation guards backstop gross errors.
 */
export function extractTagBlocks(html: string, tag: string): string[] {
  const lower = html.toLowerCase();
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const blocks: string[] = [];
  let i = 0;
  while (blocks.length < MAX_BLOCKS) {
    let openIdx = lower.indexOf(open, i);
    // Skip longer tag names that share the prefix (e.g. <track> for tag "tr").
    while (openIdx !== -1) {
      const after = lower[openIdx + open.length];
      if (after === undefined || '> \t\r\n/'.includes(after)) break;
      openIdx = lower.indexOf(open, openIdx + open.length);
    }
    if (openIdx === -1) break;
    const gt = html.indexOf('>', openIdx);
    if (gt === -1) break;
    const closeIdx = lower.indexOf(close, gt + 1);
    if (closeIdx === -1) break;
    blocks.push(html.slice(gt + 1, closeIdx));
    i = closeIdx + close.length;
  }
  return blocks;
}

/**
 * Remove every `<…>` tag via a LINEAR indexOf scan. Replaces the prior
 * `/<[^>]{0,5000}>/g` regex, which had a bounded-but-real polynomial worst case
 * on adversarial input (and silently left tags longer than 5000 chars in place).
 * Each tag becomes a space so adjacent text doesn't fuse (`<b>a</b><i>b</i>` →
 * `a b`).
 */
function stripTags(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt === -1) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, lt) + ' ';
    const gt = s.indexOf('>', lt + 1);
    if (gt === -1) break; // unterminated tag → drop the remainder
    i = gt + 1;
  }
  return out;
}

/** Strip HTML tags, decode common entities, and normalize whitespace. Linear. */
export function stripHtml(html: string): string {
  const safe = html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html;
  return stripTags(safe)
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Text content of a single HTML fragment. */
export function innerText(fragment: string): string {
  return stripHtml(fragment).trim();
}
