/** Historical metadata stays readable, but the retired runtime cannot run. */
export function isRetiredAgentFlavor(flavor: unknown): flavor is 'personal' | 'ask' {
    return flavor === 'personal' || flavor === 'ask';
}

export function isRetiredSession(session: { metadata?: { flavor?: string | null } | null }): boolean {
    return isRetiredAgentFlavor(session.metadata?.flavor);
}

/** Personal moved to Bots; retired Ask transcripts remain available in history. */
export function isHiddenRetiredSession(session: { metadata?: { flavor?: string | null } | null }): boolean {
    return session.metadata?.flavor === 'personal';
}
