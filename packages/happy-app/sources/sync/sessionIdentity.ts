/**
 * Index sessions only by their Happy session identity. Machine/account/auth
 * metadata is deliberately not part of the key: multiple daemons may share it.
 */
export function indexSessionsById<T extends { id: string }>(sessions: Iterable<T>): Record<string, T> {
    const indexed: Record<string, T> = {};
    for (const session of sessions) {
        indexed[session.id] = session;
    }
    return indexed;
}
