type Item = { type: string; message?: { id: string; kind: string } };

/** Transcript items are newest-first. Mark only the first agent text after each user turn. */
export function firstAgentTextIds(items: readonly Item[]): ReadonlySet<string> {
    const first = new Set<string>();
    let afterUser = false;
    let agentMarked = false;
    for (let index = items.length - 1; index >= 0; index--) {
        const item = items[index];
        if (item.type !== 'message' || !item.message) continue;
        if (item.message.kind === 'user-text') {
            afterUser = true;
            agentMarked = false;
        } else if (item.message.kind === 'agent-text' && afterUser && !agentMarked) {
            first.add(item.message.id);
            agentMarked = true;
        }
    }
    return first;
}
