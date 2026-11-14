/** Historical metadata stays readable, but the retired runtime cannot run. */
export function isRetiredAgentFlavor(flavor: unknown): flavor is 'personal' {
    return flavor === 'personal';
}

export function isRetiredSession(session: { metadata?: { flavor?: string | null } | null }): boolean {
    return isRetiredAgentFlavor(session.metadata?.flavor);
}
