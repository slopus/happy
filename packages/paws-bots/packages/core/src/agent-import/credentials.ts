/**
 * Text shaped like a well-known credential. Imported Markdown sometimes holds a key someone
 * pasted into a prompt or a note; an item with one starts unticked and says so, so it never
 * reaches a bot without the user choosing it. The text itself is never changed.
 *
 * Deterministic: each shape needs its provider's prefix and a minimum length. Only the two
 * generic shapes (`sk-` and `Bearer`) must also look random, so words and placeholders
 * ("sk-...", "sk-your-key-here", "Bearer <token>") do not count. A hyphenated word long
 * enough and with a digit ("sk-learn-…-v2-…") still does: over-flagging only unticks an item.
 */
const SHAPES: { pattern: RegExp; random?: boolean }[] = [
  // OpenAI, Anthropic, OpenRouter and other `sk-` keys (`sk-proj-`, `sk-ant-`, `sk-or-v1-`).
  {
    pattern: /(?<![\w-])sk-(?:ant-(?:api\d\d-)?|or-v1-|proj-)?([A-Za-z0-9_-]{20,})/g,
    random: true,
  },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  // AWS access key ids, long-term (AKIA) and temporary (ASIA).
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { pattern: /\bhf_[A-Za-z0-9]{30,}/g },
  // Stripe live secret and restricted keys.
  { pattern: /\b[rs]k_live_[A-Za-z0-9]{20,}/g },
  { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  { pattern: /\bbearer\s+([A-Za-z0-9._~+/-]{24,}=*)/gi, random: true },
];

function random(value: string): boolean {
  return /[A-Za-z]/.test(value) && /\d/.test(value) && new Set(value).size > 4;
}

/** Never returns the value. */
export function looksLikeCredential(text: string): boolean {
  for (const { pattern, random: needsRandom } of SHAPES) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (!needsRandom || random(match[1] ?? match[0])) return true;
    }
  }
  return false;
}
