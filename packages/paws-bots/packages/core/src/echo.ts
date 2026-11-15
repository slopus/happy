/** A heard line longer than this is a real turn, however much it overlaps the reply. */
const MAX_ECHO_WORDS = 12;
/** Fewer matched words than this is coincidence, not the speaker leaking into the mic. */
const MIN_ECHO_WORDS = 3;
const ECHO_MATCH_RATIO = 0.6;

const CONTRACTIONS: Record<string, string> = {
  m: "am",
  re: "are",
  s: "is",
  ll: "will",
  ve: "have",
  d: "would",
};

/** Dictation writes out what speech contracts, so "I'm" must compare equal to "I am". */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/n['’]t\b/g, " not")
    .replace(/['’](m|re|s|ll|ve|d)\b/g, (_match, tail: string) => ` ${CONTRACTIONS[tail]}`)
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * True when a transcript is the microphone catching the reply that just played.
 *
 * `threshold` is the share of heard words that must match; lower it while audio is
 * still playing, when far more of what the mic picks up is the speaker.
 *
 * ponytail: in-order word overlap, no acoustics. It can still drop a short genuine
 * turn that quotes the reply back; move to an energy/echo-cancellation signal from
 * the audio graph if that shows up in practice.
 */
export function isEchoOfSpeech(
  heard: string,
  spoken: string,
  threshold = ECHO_MATCH_RATIO,
): boolean {
  const heardWords = words(heard);
  const spokenWords = words(spoken);
  if (heardWords.length > MAX_ECHO_WORDS || !spokenWords.length) return false;
  if (heardWords.length === 2) {
    return spokenWords.some(
      (word, i) => word === heardWords[0] && spokenWords[i + 1] === heardWords[1],
    );
  }
  let cursor = 0;
  let matched = 0;
  for (const word of heardWords) {
    const at = spokenWords.indexOf(word, cursor);
    if (at === -1) continue;
    matched += 1;
    cursor = at + 1;
  }
  if (matched < MIN_ECHO_WORDS) return false;
  return matched / heardWords.length >= threshold;
}

/** How long a spoken line can still come back through the microphone. */
const ECHO_MEMORY_MS = 15_000;
/** More than one call's worth of turns inside the window; older ones are dropped. */
const ECHO_MEMORY_MAX = 16;

/**
 * Every line the speaker played recently. Matching only against the last one misses
 * the common case: by the time the microphone delivers an echo, a newer reply has
 * already taken that slot.
 */
export class SpokenMemory {
  private entries: { text: string; at: number }[] = [];

  remember(text: string, now = Date.now()): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.entries.push({ text: trimmed, at: now });
    this.prune(now);
  }

  clear(): void {
    this.entries = [];
  }

  /**
   * ponytail: one in-order match against the window's lines joined in order. That
   * subsumes every consecutive run inside it, so a heard line spanning two replies
   * matches without comparing each pair — at the cost of also matching words picked
   * from lines further apart. Compare runs pairwise if that drops real turns.
   */
  isEcho(heard: string, threshold?: number, now = Date.now()): boolean {
    this.prune(now);
    return isEchoOfSpeech(heard, this.entries.map((entry) => entry.text).join(". "), threshold);
  }

  private prune(now: number): void {
    const cutoff = now - ECHO_MEMORY_MS;
    this.entries = this.entries.filter((entry) => entry.at >= cutoff).slice(-ECHO_MEMORY_MAX);
  }
}

export const spokenMemory = new SpokenMemory();
