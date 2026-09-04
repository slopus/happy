/**
 * Ring buffer of user prompts that just arrived from the app, used by the
 * remote-mode session scanner to avoid double-forwarding.
 *
 * The scanner walks the on-disk Claude JSONL looking for prompts that landed
 * in the file but never reached the server — i.e. the ones the user typed in
 * a `claude --resume <id>` terminal sitting alongside a Happy session.
 * App-sent prompts also land in the JSONL once the SDK writes them, so they
 * would be forwarded twice without this dedupe.
 *
 * Entries match by content within a short time window; entries older than
 * `maxAgeMs` roll off so unrelated future prompts with identical text still
 * get through from the terminal side.
 *
 * Prompts are trimmed before comparison: the SDK writes the prompt to the
 * JSONL with a trailing newline while the app delivers it without one, so an
 * exact-match dedupe misses and the app-sent prompt is persisted twice.
 */
export function createAppPromptDedupe(maxAgeMs: number = 5 * 60 * 1000) {
    const recentAppPrompts: Array<{ text: string; addedAt: number }> = [];

    const record = (text: string) => {
        const now = Date.now();
        recentAppPrompts.push({ text: text.trim(), addedAt: now });
        const cutoff = now - maxAgeMs;
        while (recentAppPrompts.length > 0 && recentAppPrompts[0].addedAt < cutoff) {
            recentAppPrompts.shift();
        }
    };

    const consume = (text: string): boolean => {
        const normalized = text.trim();
        const cutoff = Date.now() - maxAgeMs;
        for (let i = 0; i < recentAppPrompts.length; i++) {
            const entry = recentAppPrompts[i];
            if (entry.addedAt < cutoff) continue;
            if (entry.text === normalized) {
                recentAppPrompts.splice(i, 1);
                return true;
            }
        }
        return false;
    };

    return { record, consume };
}
