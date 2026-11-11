import type { FileReference } from '../fileWorkspace/context';

/** Persisted offsets refer to rendered text, never Markdown source offsets. */
export type MessageAnnotation = Readonly<{
    id: string;
    revision: number;
    messageId: string;
    file?: FileReference;
    quote: string;
    anchorText: string;
    start: number;
    end: number;
    comment: string;
    context?: { before: string; after: string };
}>;
export type AnnotationSelection = Omit<MessageAnnotation, 'id' | 'revision' | 'comment'>;
export const EMPTY_ANNOTATIONS: readonly MessageAnnotation[] = Object.freeze([]);

export function fileAnnotationLabel(file: FileReference): string {
    return file.path.split('/').slice(-2).join('/');
}

/** Revision-bound identity prevents highlights moving to a different file or version. */
export function fileAnnotationSourceId(file: FileReference): string {
    return 'workspace-file:' + JSON.stringify([file.path, file.hash]);
}
function isFileReference(value: unknown): value is FileReference {
    if (!value || typeof value !== 'object') return false;
    const file = value as FileReference;
    return typeof file.path === 'string' && !!file.path && typeof file.hash === 'string' && !!file.hash
        && (file.artifact === undefined || (!!file.artifact && ['workspaceId', 'artifactId', 'expectedRevision'].every(key =>
            typeof file.artifact![key as keyof NonNullable<FileReference['artifact']>] === 'string')
            && (file.artifact.versionId === undefined || typeof file.artifact.versionId === 'string')));
}
export function isAnnotation(value: unknown): value is MessageAnnotation {
    if (!value || typeof value !== 'object') return false;
    const a = value as MessageAnnotation;
    return ['id', 'messageId', 'quote', 'anchorText', 'comment'].every(key => typeof a[key as keyof MessageAnnotation] === 'string')
        && !!a.id && !!a.messageId && !!a.quote.trim() && !!a.anchorText
        && (a.file === undefined || (isFileReference(a.file) && a.messageId === fileAnnotationSourceId(a.file)))
        && (a.context === undefined || (!!a.context && typeof a.context.before === 'string' && typeof a.context.after === 'string'))
        && Number.isSafeInteger(a.revision) && a.revision >= 0
        && Number.isSafeInteger(a.start) && a.start >= 0
        && Number.isSafeInteger(a.end) && a.end > a.start;
}

/** Storage is injected so account isolation, failed writes and reloads can be tested. */
export function createAnnotationDraftStore(deps: {
    read: (sessionId: string) => string | undefined;
    write: (sessionId: string, value: string) => void;
    newId: () => string;
    isCurrent?: () => boolean;
}) {
    const sessions = new Map<string, readonly MessageAnnotation[]>();
    const listeners = new Set<() => void>();
    const current = () => deps.isCurrent?.() !== false;
    const getSnapshot = (sessionId: string): readonly MessageAnnotation[] => {
        if (!current()) return EMPTY_ANNOTATIONS;
        if (!sessions.has(sessionId)) {
            let annotations: readonly MessageAnnotation[] = EMPTY_ANNOTATIONS;
            try {
                const parsed = JSON.parse(deps.read(sessionId) ?? 'null');
                if (parsed?.version === 1 && Array.isArray(parsed.items) && parsed.items.every(isAnnotation)
                    && new Set(parsed.items.map((a: MessageAnnotation) => a.id)).size === parsed.items.length) annotations = parsed.items;
            } catch { /* Corrupt local caches do not prevent opening the conversation. */ }
            sessions.set(sessionId, annotations);
        }
        return sessions.get(sessionId)!;
    };
    const commit = (sessionId: string, items: readonly MessageAnnotation[]) => {
        if (!current()) throw new Error('Account changed; reload required');
        // A failed save must not replace the last durable draft in the view.
        deps.write(sessionId, JSON.stringify({ version: 1, items }));
        sessions.set(sessionId, items);
        listeners.forEach(listener => listener());
    };
    return {
        getSnapshot,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        add(sessionId: string, selection: AnnotationSelection, comment = '') {
            const items = getSnapshot(sessionId);
            const existing = items.find(a => a.messageId === selection.messageId && a.start === selection.start
                && a.end === selection.end && a.anchorText === selection.anchorText);
            if (existing) return existing;
            const item: MessageAnnotation = { ...selection, comment, id: deps.newId(), revision: 0 };
            if (!isAnnotation(item)) throw new Error('Invalid annotation selection');
            commit(sessionId, [...items, item]);
            return item;
        },
        update(sessionId: string, id: string, comment: string) {
            const items = getSnapshot(sessionId);
            if (!items.some(a => a.id === id)) return;
            commit(sessionId, items.map(a => a.id === id ? { ...a, comment, revision: a.revision + 1 } : a));
        },
        remove(sessionId: string, id: string) {
            commit(sessionId, getSnapshot(sessionId).filter(a => a.id !== id));
        },
        restore(sessionId: string, submitted: readonly MessageAnnotation[]) {
            if (!submitted.every(isAnnotation)) throw new Error('Invalid annotations');
            const items = getSnapshot(sessionId);
            const ids = new Set(items.map(a => a.id));
            const missing = submitted.filter(a => {
                if (ids.has(a.id)) return false;
                ids.add(a.id);
                return true;
            });
            if (missing.length) commit(sessionId, [...items, ...missing]);
        },
        clearSubmitted(sessionId: string, submitted: readonly MessageAnnotation[]) {
            const versions = new Map(submitted.map(a => [a.id, a.revision]));
            const currentItems = getSnapshot(sessionId);
            const items = currentItems.filter(a => versions.get(a.id) !== a.revision);
            if (items.length !== currentItems.length) {
                // The queue already accepted this snapshot. Retire it in memory
                // even if local persistence fails, so another click cannot resend
                // it. The caller reports that a refresh may restore the old cache.
                try { commit(sessionId, items); }
                catch (error) {
                    if (current()) {
                        sessions.set(sessionId, items);
                        listeners.forEach(listener => listener());
                    }
                    throw error;
                }
            }
        },
    };
}

export type AnnotationPromptLabels = { intro: string; annotation: string; quote: string; comment: string; explain: string; additional: string; fileInstructions?: string; fileReview?: string };
export function formatAnnotatedMessage(text: string, items: readonly MessageAnnotation[], labels: AnnotationPromptLabels, includeFileContext = true): string {
    if (!items.length) return text;
    // Context precedes the free text so an attached /command is not accidentally
    // interpreted as a CLI command with the annotation payload as arguments.
    const sections = items.map((a, index) => `${labels.annotation} ${index + 1}${a.file ? (includeFileContext ? '\n[Workspace file annotation]\n' + JSON.stringify({ ...a.file, renderedStart: a.start, renderedEnd: a.end, ...(a.context ? { context: a.context } : {}) }) : '\n' + fileAnnotationLabel(a.file)) : ''}\n${labels.quote}\n${a.quote.split('\n').map(line => '> ' + line).join('\n')}\n\n${labels.comment}\n${a.comment.trim() || (a.file ? labels.fileReview ?? labels.explain : labels.explain)}`);
    return [labels.intro, includeFileContext && items.some(a => a.file) ? labels.fileInstructions : '', ...sections, text.trim() ? `${labels.additional}\n${text}` : ''].filter(Boolean).join('\n\n');
}
