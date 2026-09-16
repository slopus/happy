import { MMKV } from 'react-native-mmkv';
import { accountStorageId } from '@/auth/accountRuntime';
import { z } from 'zod';
import { ApiMessageSchema, type ApiMessage } from './apiTypes';

const LATEST_BOUNDARY = 2147483647;
const DISK_BUDGET = 128 * 1024 * 1024;
const pageSchema = z.object({ messages: z.array(ApiMessageSchema), hasMore: z.boolean() });
const entrySchema = z.object({ ref: z.string(), lower: z.number().int().nonnegative(), upper: z.number().int().nonnegative() });
const indexSchema = z.array(entrySchema);
type Page = z.infer<typeof pageSchema>;
type Disk = Pick<MMKV, 'getString' | 'set' | 'delete' | 'clearAll' | 'size'>;

/** Native wire-page archive, separate from the small startup snapshot cache.
 * Immutable page bytes are written before publishing their coverage index.
 * Reads touch only connected pages near the requested boundary, never the
 * entire transcript. Only encrypted wire records enter this optional cache.
 */
export class SessionHistoryPageCache {
    generation: object = {};
    private sessionFences = new Map<string, object>();

    /** A background reader must survive unrelated session deletions, while
     * deletion of its own archive or a full cache clear fences late writes. */
    captureFence(account: string, session: string): () => boolean {
        const key = this.key(account, session);
        const token = this.sessionFences.get(key) ?? {};
        this.sessionFences.set(key, token);
        return () => this.sessionFences.get(key) === token;
    }
    constructor(private disk: Disk, private budget = DISK_BUDGET) {}

    private key(account: string, session: string) { return JSON.stringify([account, session]); }
    private index(key: string) {
        return indexSchema.parse(JSON.parse(this.disk.getString(key) ?? '[]'));
    }

    save(account: string, session: string, boundary: number, input: Page, generation = this.generation): boolean {
        if (generation !== this.generation) return false;
        let ref: string | undefined;
        try {
            const page = pageSchema.parse(input);
            if (!Number.isInteger(boundary) || boundary <= 0 || boundary > LATEST_BOUNDARY) return false;
            if (page.messages.some(row => row.content.t !== 'encrypted' || !Number.isInteger(row.seq) || row.seq <= 0 || row.seq >= boundary)) return false;
            if (page.hasMore && page.messages.length === 0) return false;
            const seqs = page.messages.map(row => row.seq);
            const lower = page.hasMore ? Math.min(...seqs) : 0;
            // The latest-page sentinel does not certify future/unseen messages.
            const upper = boundary === LATEST_BOUNDARY ? Math.max(0, ...seqs) : boundary - 1;
            const key = this.key(account, session);
            const entries = this.index(key);
            const bytes = JSON.stringify(page);
            if (entries.some(entry => entry.lower === lower && entry.upper === upper && this.disk.getString(entry.ref) === bytes)) return true;
            ref = `page:${Date.now()}:${Math.random().toString(36).slice(2)}`;
            const replaced = entries.filter(entry => entry.lower >= lower && entry.upper <= upper);
            const nextIndex = JSON.stringify([
                ...entries.filter(entry => !replaced.includes(entry)), { ref, lower, upper },
            ]);
            // MMKV.size includes its append log. Replacing an index appends
            // the whole value; count it and cleanup records before admission.
            // Three bytes per UTF-16 code unit bounds UTF-8, even for non-ASCII IDs.
            const writeBudget = (bytes.length + nextIndex.length + key.length + ref.length) * 3
                + replaced.reduce((size, entry) => size + entry.ref.length * 3 + 32, 0) + 4096;
            if (this.disk.size + writeBudget > this.budget) return false;
            this.disk.set(ref, bytes);
            this.disk.set(key, nextIndex);
            // Coverage has committed. Cleanup failure only leaves unused bytes.
            for (const entry of replaced) {
                try { this.disk.delete(entry.ref); } catch { /* optional cleanup */ }
            }
            return true;
        } catch {
            if (ref) { try { this.disk.delete(ref); } catch { /* optional cleanup */ } }
            return false;
        }
    }

    readOlder(account: string, session: string, boundary: number, limit = 100): Page | null {
        try {
            if (!Number.isInteger(boundary) || boundary <= 0 || !Number.isInteger(limit) || limit <= 0) return null;
            const entries = this.index(this.key(account, session));
            const rows = new Map<number, ApiMessage>();
            let cursor = boundary;
            let complete = false;
            while (rows.size <= limit && !complete) {
                const entry = entries.filter(item => item.lower < cursor && item.upper >= cursor - 1)
                    .sort((a, b) => a.lower - b.lower)[0];
                if (!entry) break;
                const page = pageSchema.parse(JSON.parse(this.disk.getString(entry.ref) ?? 'null'));
                if (page.messages.some(row => row.content.t !== 'encrypted' || row.seq < entry.lower || row.seq > entry.upper)) return null;
                for (const row of page.messages) if (row.seq < cursor) rows.set(row.seq, row);
                cursor = entry.lower;
                complete = cursor === 0;
            }
            if (!rows.size && !complete) return null;
            return { messages: [...rows.values()].sort((a, b) => a.seq - b.seq).slice(-limit),
                hasMore: rows.size > limit || !complete };
        } catch { return null; }
    }

    remove(account: string, session: string): void {
        this.generation = {};
        this.sessionFences.delete(this.key(account, session));
        try {
            const key = this.key(account, session);
            let entries: z.infer<typeof indexSchema> = [];
            try { entries = this.index(key); } catch { /* remove corrupt index too */ }
            this.disk.delete(key);
            for (const entry of entries) this.disk.delete(entry.ref);
        } catch { /* optional cache */ }
    }

    clear(): void {
        this.generation = {};
        this.sessionFences.clear();
        try { this.disk.clearAll(); } catch { /* optional cache */ }
    }
}

export const sessionHistoryPageCache = new SessionHistoryPageCache(new MMKV({ id: accountStorageId('session-history-pages-v1')! }));
