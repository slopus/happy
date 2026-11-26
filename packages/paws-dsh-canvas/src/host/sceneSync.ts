import { isProjectCanvasDocument, type ProjectCanvasFrameMessage, type ProjectCanvasPlacement, type ProjectCanvasScene,
    type ProjectCanvasSceneResult } from '../protocol';

interface SceneSyncOptions {
    sessionKey: string;
    serialize(): string | undefined;
    restore(document: string): boolean;
    placements(): ProjectCanvasPlacement[];
    post(message: ProjectCanvasFrameMessage): void;
    failed(reason: 'conflict' | 'save' | 'invalid'): void;
}

export function createSceneSync({ sessionKey, serialize, restore, placements, post, failed }: SceneSyncOptions) {
    const draftKey = `paws-dsh-image-canvas:unsaved:${sessionKey}`;
    const flushRequests = new Set<string>();
    let revision = 0;
    let dirty = false;
    let initialized = false;
    let rejectedRevision: number | undefined;
    let pointerDown = false;
    let submitted: ProjectCanvasScene | undefined;
    let deferred: ProjectCanvasScene | undefined;
    let saved: string | undefined;
    let failure: 'conflict' | 'save' | 'invalid' | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function remember(document?: string): void {
        try {
            if (document) sessionStorage.setItem(draftKey, JSON.stringify({ revision, document }));
            else sessionStorage.removeItem(draftKey);
        } catch {
            // Keep the pending edit live when browser storage is unavailable.
        }
    }

    function previousDraft(): ProjectCanvasScene | undefined {
        try {
            const value = JSON.parse(sessionStorage.getItem(draftKey) ?? 'null') as Partial<ProjectCanvasScene> | null;
            if (value && typeof value.revision === 'number' && Number.isSafeInteger(value.revision)
                && value.revision >= 0 && isProjectCanvasDocument(value.document)) {
                return { revision: value.revision, document: value.document };
            }
        } catch {
            // An unavailable local draft does not prevent opening the project.
        }
        return undefined;
    }

    function completeFlushes(ok: boolean): void {
        for (const requestId of flushRequests) {
            post({ type: 'paws-project-canvas/scene-flushed', sessionKey, requestId, ok });
        }
        flushRequests.clear();
    }

    function fail(reason: NonNullable<typeof failure>): void {
        if (failure !== reason) failed(reason);
        failure = reason;
        completeFlushes(false);
    }

    function cancelTimer(): void {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
    }

    function flush(): void {
        cancelTimer();
        if (!initialized || submitted || pointerDown) return;
        if (failure) {
            saveDraft();
            completeFlushes(false);
            return;
        }
        if (!dirty) {
            completeFlushes(true);
            return;
        }
        const document = serializeDraft();
        if (!document) {
            fail('save');
            return;
        }
        if (document === saved) {
            dirty = false;
            remember();
            completeFlushes(true);
            return;
        }
        dirty = false;
        submitted = { revision, document };
        remember(document);
        post({ type: 'paws-project-canvas/scene', sessionKey, revision, document, placements: placements() });
    }

    function schedule(): void {
        cancelTimer();
        if (!pointerDown) timer = setTimeout(flush, 120);
    }

    function acknowledge(nextRevision: number): void {
        if (!submitted || nextRevision !== submitted.revision + 1) return;
        revision = nextRevision;
        saved = submitted.document;
        submitted = undefined;
        if (dirty) schedule();
        else {
            remember();
            completeFlushes(true);
        }
    }

    function accept(scene: ProjectCanvasScene | undefined): boolean {
        if (!initialized) {
            initialized = true;
            const draft = previousDraft();
            if (draft && draft.document !== scene?.document && restore(draft.document)) {
                revision = draft.revision;
                dirty = true;
                if (revision === (scene?.revision ?? 0)) schedule();
                else fail('conflict');
                return true;
            }
            if (draft) remember();
        }
        if (!scene || scene.revision <= revision || scene.revision === rejectedRevision) return false;
        if (submitted?.document === scene.document && scene.revision === submitted.revision + 1) {
            failure = undefined;
            acknowledge(scene.revision);
            return false;
        }
        if (pointerDown) {
            if (!deferred || deferred.revision < scene.revision) deferred = scene;
            return false;
        }
        if (dirty || submitted || failure === 'conflict') {
            const document = serializeDraft();
            if (document) remember(document);
            fail('conflict');
            return false;
        }
        if (!restore(scene.document)) {
            rejectedRevision = scene.revision;
            fail('invalid');
            return false;
        }
        revision = scene.revision;
        saved = scene.document;
        failure = undefined;
        return true;
    }

    function receive(result: ProjectCanvasSceneResult): void {
        if (result.type === 'paws-project-canvas/scene-saved') {
            if (failure !== 'conflict') acknowledge(result.revision);
        } else if (submitted) {
            submitted = undefined;
            dirty = true;
            const document = serializeDraft();
            if (document) remember(document);
            fail(result.reason);
        }
    }

    function trackUserEdit(): void {
        dirty = true;
        schedule();
    }

    function trackPointer(active: boolean): boolean {
        pointerDown = active;
        if (active) return false;
        const scene = deferred;
        deferred = undefined;
        const restored = scene ? accept(scene) : false;
        if (flushRequests.size) flush();
        else if (dirty) schedule();
        return restored;
    }

    function saveDraft(): void {
        if (!dirty) return;
        const document = serializeDraft();
        if (document) remember(document);
    }

    function serializeDraft(): string | undefined {
        try { return serialize(); }
        catch { return undefined; }
    }

    return {
        accept,
        receive,
        trackUserEdit,
        trackPointer,
        flush(requestId: string) {
            flushRequests.add(requestId);
            flush();
        },
        retry() {
            if (failure !== 'save') return;
            failure = undefined;
            flush();
        },
        hasLocalEdits() {
            return dirty || submitted !== undefined;
        },
        saveDraft,
        dispose() {
            cancelTimer();
            saveDraft();
            completeFlushes(false);
        },
    };
}
