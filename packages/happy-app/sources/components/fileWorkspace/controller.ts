import { resolveSessionFilePath } from '@/utils/sessionFileLinks';

export type FileDocument = {
    path: string; revision: number; phase: 'loading' | 'ready' | 'error'; content: string; draft: string;
    hash: string | null; draftBaseHash: string | null; saving: boolean; conflict: boolean; error: string | null;
    media?: { bytes: Uint8Array; mime: string };
    fileRevision?: string;
};
export type FileWorkspaceSnapshot = {
    tabs: string[]; active: string | null; open: boolean; documents: Record<string, FileDocument>;
};
export type FileWorkspaceIO = {
    root: string;
    read: (path: string, signal?: AbortSignal) => Promise<{ content: string; hash: string; media?: FileDocument['media']; fileRevision?: string }>;
    write: (path: string, content: string, expectedHash: string) => Promise<{ hash: string; fileRevision?: string }>;
    isCurrent?: () => boolean;
};
export const documentDirty = (document: FileDocument) => document.phase === 'ready' && document.draft !== document.content;

/** Owns loaded baselines and drafts, not versions. One instance per account/session/root. */
export class FileWorkspaceController {
    private snapshot: FileWorkspaceSnapshot = { tabs: [], active: null, open: false, documents: {} };
    private listeners = new Set<() => void>();
    private revisions = new Map<string, number>();
    private requests = new Map<string, object>();
    private reads = new Map<string, AbortController>();
    private disposed = false;
    private restoredDrafts = new Map<string, { draft: string; hash: string }>();
    constructor(private io: FileWorkspaceIO) {}
    getSnapshot = () => this.snapshot;
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    private current() { return !this.disposed && (this.io.isCurrent?.() ?? true); }
    private commit(next: FileWorkspaceSnapshot) {
        if (!this.current()) return;
        this.snapshot = next;
        this.listeners.forEach(listener => listener());
    }
    private update(path: string, change: Partial<FileDocument>) {
        const entry = this.snapshot.documents[path];
        if (entry) this.commit({ ...this.snapshot, documents: { ...this.snapshot.documents, [path]: { ...entry, ...change } } });
    }
    async open(raw: string) {
        if (!this.current()) return;
        const resolved = resolveSessionFilePath(raw, this.io.root);
        if (!resolved?.withinSessionRoot) return;
        const path = resolved.absolutePath;
        const exists = this.snapshot.documents[path];
        if (!exists && this.snapshot.tabs.length >= 20) throw new Error('FILE_WORKSPACE_TAB_LIMIT');
        this.commit({ ...this.snapshot, open: true, active: path,
            tabs: exists ? this.snapshot.tabs : [...this.snapshot.tabs, path],
            documents: exists ? this.snapshot.documents : { ...this.snapshot.documents, [path]: {
                path, revision: 0, phase: 'loading', content: '', draft: '', hash: null, draftBaseHash: null, saving: false, conflict: false, error: null,
            } },
        });
        if (!exists) await this.refresh(path);
    }
    edit(path: string, draft: string) {
        if (this.snapshot.documents[path]?.media) return;
        if (this.snapshot.documents[path]?.phase === 'ready' && this.snapshot.documents[path].draft !== draft) { this.revisions.set(path, (this.revisions.get(path) ?? 0) + 1); this.update(path, { draft }); }
    }
    restoreDraft(path: string, saved: { draft: string; hash: string }) {
        const entry = this.snapshot.documents[path];
        if (!entry || documentDirty(entry)) return;
        if (entry.phase !== 'ready') { this.restoredDrafts.set(path, saved); this.commit({ ...this.snapshot }); return; }
        this.update(path, { draft: saved.draft, draftBaseHash: saved.hash, conflict: saved.hash !== entry.hash });
    }
    exportDrafts() {
        return { ...Object.fromEntries(this.restoredDrafts), ...Object.fromEntries(Object.entries(this.snapshot.documents).filter(([, file]) => documentDirty(file) && file.hash).map(([path, file]) => [path, { draft: file.draft, hash: file.draftBaseHash ?? file.hash! }])) };
    }
    setOpen(open: boolean) { this.commit({ ...this.snapshot, open }); }
    closeMany(paths: readonly string[], discard = false) {
        // Check the whole group before removing anything, including cached drafts
        // whose original file could not be loaded. Saving files are never discarded.
        if (paths.some(path => {
            const entry = this.snapshot.documents[path];
            return entry && (entry.saving || (!discard && (documentDirty(entry) || this.restoredDrafts.has(path))));
        })) return false;
        for (const path of paths) this.close(path, discard);
        return true;
    }
    close(path: string, discard = false) {
        const entry = this.snapshot.documents[path];
        if (!entry) return true;
        if (entry.saving || (!discard && (documentDirty(entry) || this.restoredDrafts.has(path)))) return false;
        this.requests.delete(path);
        this.reads.get(path)?.abort(); this.reads.delete(path);
        this.revisions.delete(path);
        this.restoredDrafts.delete(path);
        const index = this.snapshot.tabs.indexOf(path);
        const tabs = this.snapshot.tabs.filter(p => p !== path);
        const { [path]: _removed, ...documents } = this.snapshot.documents;
        this.commit({ ...this.snapshot, tabs, documents,
            active: this.snapshot.active === path ? tabs[Math.min(index, tabs.length - 1)] ?? null : this.snapshot.active,
            open: this.snapshot.open && tabs.length > 0,
        });
        return true;
    }
    async refresh(path: string, discardDraft = false) {
        if (!this.current() || !this.snapshot.documents[path] || this.snapshot.documents[path].saving) return;
        const token = {}; this.requests.set(path, token);
        this.reads.get(path)?.abort();
        const abort = new AbortController(); this.reads.set(path, abort);
        const revision = this.revisions.get(path) ?? 0;
        try {
            const value = await this.io.read(path, abort.signal);
            if (!this.current() || this.requests.get(path) !== token || !this.snapshot.documents[path]) return;
            const entry = this.snapshot.documents[path];
            const discardCurrentDraft = discardDraft && revision === (this.revisions.get(path) ?? 0);
            if (!discardCurrentDraft && documentDirty(entry)) {
                this.update(path, { revision: entry.revision + 1, conflict: value.hash !== (entry.draftBaseHash ?? entry.hash), error: null });
            } else {
                const saved = discardCurrentDraft ? undefined : this.restoredDrafts.get(path);
                this.restoredDrafts.delete(path);
                this.update(path, { revision: entry.revision + 1, phase: 'ready', content: value.content, draft: saved?.draft ?? value.content, hash: value.hash, draftBaseHash: saved?.hash ?? value.hash, conflict: !!saved && saved.hash !== value.hash, error: null, media: value.media, fileRevision: value.fileRevision });
            }
        } catch (error) {
            if (!this.current() || this.requests.get(path) !== token) return;
            const entry = this.snapshot.documents[path];
            this.update(path, { phase: entry?.phase === 'ready' ? 'ready' : 'error', error: error instanceof Error ? error.message : String(error) });
        }
    }
    async save(path: string) {
        const entry = this.snapshot.documents[path];
        if (!this.current() || !entry || entry.phase !== 'ready' || !entry.hash || entry.conflict || entry.saving) return false;
        if (!documentDirty(entry)) return true;
        const content = entry.draft, expectedHash = entry.hash;
        const token = {}; this.requests.set(path, token);
        this.update(path, { saving: true, error: null });
        try {
            const saved = await this.io.write(path, content, expectedHash);
            if (!this.current() || this.requests.get(path) !== token || !this.snapshot.documents[path]) return false;
            this.update(path, { content, hash: saved.hash, draftBaseHash: saved.hash, saving: false, conflict: false, error: null, fileRevision: saved.fileRevision });
            return true;
        } catch (error) {
            if (this.current() && this.requests.get(path) === token) {
                const message = error instanceof Error ? error.message : String(error);
                this.update(path, { saving: false, error: message, conflict: /hash|mismatch|conflict/i.test(message) });
            }
            return false;
        }
    }
    dispose() { this.disposed = true; for (const read of this.reads.values()) read.abort(); this.reads.clear(); this.requests.clear(); this.listeners.clear(); }
}
