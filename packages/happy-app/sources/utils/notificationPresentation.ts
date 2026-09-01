export function shouldPresentNotification(kind: unknown, appState: string): boolean {
    return kind === 'done'
        || kind === 'permission'
        || kind === 'question'
        || kind === 'share-ready'
        || kind === 'share-failed'
        || appState !== 'active';
}
