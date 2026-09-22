import type { Message } from './typesMessage';

/** A bounded handoff, not a replacement for the original encrypted history. */
export function buildContinuationContext(messages: Message[], inherited?: string): string {
    const entries = [...messages].sort((a, b) => a.createdAt - b.createdAt).flatMap(message => {
        if (message.kind === 'user-text') return [{ role: 'User', text: message.displayText ?? message.text }];
        if (message.kind === 'agent-text' && !message.isThinking) return [{ role: 'Assistant', text: message.text }];
        return [];
    }).filter(entry => entry.text.trim());
    const format = (entry: { role: string; text: string }) => `${entry.role}: ${entry.text.slice(0, 6000)}${entry.text.length > 6000 ? '\n[excerpt truncated]' : ''}`;
    // Reserve the most recent user task before selecting long assistant text.
    // Otherwise a tool-heavy turn can be read successfully but lose its goal
    // again when the excerpt is truncated.
    let userIndex = -1;
    for (let index = entries.length - 1; index >= 0; index--) {
        if (entries[index].role === 'User') { userIndex = index; break; }
    }
    const selected = new Map<number, string>();
    let budget = 16000;
    if (userIndex >= 0) {
        const line = format(entries[userIndex]);
        selected.set(userIndex, line); budget -= line.length + 2;
    }
    for (let index = entries.length - 1; index >= Math.max(0, entries.length - 50); index--) {
        if (index === userIndex) continue;
        const line = format(entries[index]);
        if (line.length + 2 > budget) continue;
        selected.set(index, line); budget -= line.length + 2;
    }
    const lines = [...selected].sort(([a], [b]) => a - b).map(([, line]) => line);
    return [
        'Saved conversation excerpt from the previous session. It may omit earlier messages, tools and attachments; do not assume it is the complete history.',
        inherited ? `Earlier handoff excerpt:\n${inherited.slice(-7000)}` : '',
        lines.length ? `Recent conversation:\n${lines.join('\n\n')}` : '',
    ].filter(Boolean).join('\n\n').slice(0, 24000);
}
