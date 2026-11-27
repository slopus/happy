/** Encrypted immutable portable history, bounded model reads and manifest-only originals. */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
    PortableContextArchiveSchema, PortableContextDescriptorSchema, PortableContextUploadSchema,
    PortableThreadReadSchema, PortableThreadAttachmentSchema,
    PortableContextBoundarySchema, type PortableContextBoundary,
    type PortableContextArchive, type PortableContextDescriptor,
} from '@slopus/happy-wire';
import { encryptBlob, decryptBlob } from '@/api/encryption';
import { openAttachmentDownload } from '@/api/attachmentDownload';
import { deriveKey } from '@/utils/deriveKey';
import { AsyncLock } from '@/utils/lock';
import { detectCodexImage } from '@/codex/codexImageInput';

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_CHUNKS = 6000;
const MAX_ATTACHMENT_BYTES = 500 * 1024 * 1024;
const MAX_ENCRYPTED_ATTACHMENT_BYTES = 64 * 1024 * 1024;
/** Directory root shared by live workers and daemon-only historical exports. */
export const PORTABLE_CONTEXT_DIRECTORY_NAME = 'portable-context';
const sha = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const textResult = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const boundaryIdentity = (boundary: PortableContextBoundary | null | undefined): string => boundary ? `${boundary.id}:${boundary.afterSeq}` : 'none';

export type PortableContextStoreOptions = {
    directory: string; sessionId: string; serverUrl: string; token: string; encryptionKey: Uint8Array;
    descriptor: () => unknown;
    boundary?: () => PortableContextBoundary | undefined;
    allowed?: () => boolean;
};
/** Contains private source keys. Only authenticated encrypted RPC may return this page. */
export type PortableContextExportPage = {
    chunk: string; nextTextOffset: number | null; descriptor: PortableContextDescriptor;
};
const ActiveReceiptSchema = z.object({ version: z.literal(1), boundary: PortableContextBoundarySchema.nullable(),
    descriptor: PortableContextDescriptorSchema.nullable() }).strict();
type ActiveReceipt = z.infer<typeof ActiveReceiptSchema>;

function parseArchive(raw: string, snapshotId: string): PortableContextArchive {
    // JSON/Zod errors can contain private input; never propagate them to RPC logs.
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error('Invalid portable history JSON'); }
    const validated = PortableContextArchiveSchema.safeParse(parsed);
    if (!validated.success) throw new Error('Invalid portable history schema');
    const archive = validated.data;
    const { snapshot, blobKeys } = archive;
    if (snapshot.id !== snapshotId) throw new Error('Portable history snapshot ID mismatch');
    const heads = new Map(snapshot.heads.map(head => [head.sessionId, head]));
    if (heads.size !== snapshot.heads.length || !/^[a-zA-Z0-9_-]+$/.test(snapshot.rootSessionId) || !heads.has(snapshot.sourceSessionId)
        || snapshot.heads.some(head => !/^[a-zA-Z0-9_-]+$/.test(head.sessionId) || head.afterSeq > head.throughSeq)) {
        throw new Error('Invalid portable history heads');
    }
    const items = new Set<string>();
    const attachments = new Set<string>();
    for (const item of snapshot.items) {
        const head = heads.get(item.sourceSessionId);
        if (item.id.length > 1024 || items.has(item.id) || !head || item.seq <= head.afterSeq || item.seq > head.throughSeq) {
            throw new Error('Invalid portable history item boundary');
        }
        items.add(item.id);
        for (const attachment of item.attachments ?? []) {
            const prefix = `sessions/${item.sourceSessionId}/attachments/`;
            const filename = attachment.ref.slice(prefix.length);
            if (attachment.id.length > 1024 || attachment.name.length > 4096 || (attachment.mimeType?.length ?? 0) > 256
                || attachments.has(attachment.id) || attachment.sourceSessionId !== item.sourceSessionId
                || !attachment.ref.startsWith(prefix) || !/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(filename)
                || (attachment.encrypted && !Object.hasOwn(blobKeys, item.sourceSessionId))) {
                throw new Error('Invalid portable history attachment manifest');
            }
            attachments.add(attachment.id);
        }
    }
    for (const [sourceId, key] of Object.entries(blobKeys)) {
        if (!heads.has(sourceId) || !/^[A-Za-z0-9+/]{43}=$/.test(key)
            || Buffer.from(key, 'base64').length !== 32 || Buffer.from(key, 'base64').toString('base64') !== key) {
            throw new Error('Invalid portable history source key');
        }
    }
    return archive;
}

function descriptorOf(archive: PortableContextArchive, digest: string): PortableContextDescriptor {
    const { id, rootSessionId, sourceSessionId, heads } = archive.snapshot;
    return { version: 1, id, sha256: digest, rootSessionId, sourceSessionId, heads };
}

export class PortableContextStore {
    private readonly lock = new AsyncLock();
    private readonly ready: Promise<{ directory: string; key: Uint8Array }>;
    private readonly materializedDirectories = new Set<string>();
    private readonly revokedSnapshots = new Set<string>();
    private closed = false;
    private generation = 0;
    private cached: { descriptor: PortableContextDescriptor; archive: PortableContextArchive; raw: string } | undefined;
    private activeReceipt: ActiveReceipt | undefined;
    private resetting = false;
    private readonly stagedFootprints = new Map<string, { chunks: number; bytes: number }>();

    constructor(private readonly options: PortableContextStoreOptions) {
        this.ready = (async () => {
            const key = await deriveKey(options.encryptionKey, 'Happy Portable Context', ['storage', options.serverUrl, options.sessionId]);
            const directory = join(options.directory, sha(`${options.serverUrl}\0${options.sessionId}\0${Buffer.from(key).toString('hex')}`));
            await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            await fs.chmod(directory, 0o700);
            const receipt = await this.readEncrypted(join(directory, 'active.enc'), key);
            if (receipt !== null) {
                let parsed: unknown;
                try { parsed = JSON.parse(receipt); } catch { throw new Error('Invalid portable history authority'); }
                const validated = ActiveReceiptSchema.safeParse(parsed);
                if (!validated.success) throw new Error('Invalid portable history authority');
                this.activeReceipt = validated.data;
            }
            return { directory, key };
        })();
        void this.ready.catch(() => {}); // startup callers surface initialization failures explicitly
    }

    async initialize(): Promise<void> { await this.ready; this.assertOpen(); }
    getSavedBoundary(): PortableContextBoundary | undefined { return this.activeReceipt?.boundary ?? undefined; }

    getPublishedDescriptor(): PortableContextDescriptor | undefined {
        if (this.resetting) return undefined;
        return boundaryIdentity(this.activeReceipt?.boundary) === boundaryIdentity(this.options.boundary?.()) ? this.activeReceipt?.descriptor ?? undefined : undefined;
    }

    private async invalidateMaterialized(): Promise<void> {
        this.generation++;
        this.cached = undefined;
        const directories = [...this.materializedDirectories];
        this.materializedDirectories.clear();
        await Promise.all(directories.map(directory => fs.rm(directory, { recursive: true, force: true })));
    }

    /** A durable tombstone precedes the acknowledged metadata clear. */
    async revoke(boundary?: PortableContextBoundary): Promise<void> {
        const current = this.getPublishedDescriptor();
        if (current) this.revokedSnapshots.add(current.id);
        this.resetting = true;
        await this.invalidateMaterialized();
        try {
            await this.lock.inLock(async () => {
                const { directory, key } = await this.ready;
                await this.saveReceipt(directory, key, { version: 1,
                    boundary: boundary ?? { id: randomUUID(), afterSeq: this.options.boundary?.()?.afterSeq ?? 0 }, descriptor: null });
            });
        } finally { this.resetting = false; }
    }

    async invalidateForLifecycle(): Promise<void> { await this.invalidateMaterialized(); }
    async dispose(): Promise<void> { this.closed = true; await this.invalidateMaterialized(); }

    private assertOpen(): void {
        if (this.closed) throw new Error('Portable history session is closed');
        if (this.resetting) throw new Error('Portable history is being cleared');
        if (this.options.allowed && !this.options.allowed()) throw new Error('Portable history target is archived or being deleted');
    }

    private async saveReceipt(directory: string, key: Uint8Array, receipt: ActiveReceipt): Promise<void> {
        const path = join(directory, 'active.enc');
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporary, encryptBlob(Buffer.from(JSON.stringify(receipt)), key), { mode: 0o600, flag: 'wx' });
            await fs.rename(temporary, path);
            this.activeReceipt = receipt;
            this.cached = undefined;
        } finally { await fs.unlink(temporary).catch(() => {}); }
    }

    private async readEncrypted(path: string, key: Uint8Array): Promise<string | null> {
        let bytes: Buffer;
        try { bytes = await fs.readFile(path); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw new Error('Cannot read encrypted portable history');
        }
        const plaintext = decryptBlob(bytes, key);
        if (!plaintext) throw new Error('Cannot authenticate portable history');
        return Buffer.from(plaintext).toString('utf8');
    }

    private async publish(path: string, plaintext: string, key: Uint8Array): Promise<void> {
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporary, encryptBlob(Buffer.from(plaintext), key), { mode: 0o600, flag: 'wx' });
            try { await fs.link(temporary, path); } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                if (await this.readEncrypted(path, key) !== plaintext) throw new Error('Portable history is immutable');
            }
        } finally { await fs.unlink(temporary).catch(() => {}); }
    }

    async upload(input: unknown): Promise<{ success: true; descriptor?: PortableContextDescriptor }> {
        const result = PortableContextUploadSchema.safeParse(input);
        if (!result.success) throw new Error('Invalid portable history upload');
        const request = result.data;
        return this.lock.inLock(async () => {
            this.assertOpen();
            const { directory, key } = await this.ready;
            const boundary = this.options.boundary?.() ?? null;
            if (this.activeReceipt && boundaryIdentity(this.activeReceipt.boundary) !== boundaryIdentity(boundary)) throw new Error('Portable history boundary was cleared');
            const uploadDirectory = join(directory, request.snapshotId);
            await fs.mkdir(uploadDirectory, { recursive: true, mode: 0o700 });
            // An immutable upload epoch prevents replaying an old committed or partial snapshot after clear/restart.
            const boundaryPath = join(uploadDirectory, 'boundary.enc');
            const savedBoundary = await this.readEncrypted(boundaryPath, key);
            const encodedBoundary = JSON.stringify({ boundary });
            if (savedBoundary !== null && savedBoundary !== encodedBoundary) throw new Error('Portable history snapshot belongs to a cleared boundary');
            if (savedBoundary === null) await this.publish(boundaryPath, encodedBoundary, key);
            if (request.action === 'append') {
                if (request.index >= MAX_CHUNKS) throw new Error('Portable history exceeds chunk limit');
                const path = join(uploadDirectory, `${request.index}.chunk`);
                const encoded = JSON.stringify(request.chunk); // preserve surrogate pairs split across chunks
                const previous = await this.readEncrypted(path, key);
                if (previous !== null) {
                    if (previous !== encoded) throw new Error('Portable history chunk is immutable');
                    return { success: true };
                }
                if (await this.readEncrypted(join(uploadDirectory, 'archive.enc'), key) !== null) throw new Error('Portable history snapshot is immutable');
                const entries = await fs.readdir(uploadDirectory, { withFileTypes: true });
                const chunkFiles = entries.filter(entry => entry.isFile() && entry.name.endsWith('.chunk'));
                const footprint = this.stagedFootprints.get(request.snapshotId);
                let storedBytes = footprint?.chunks === chunkFiles.length ? footprint.bytes : 0;
                if (footprint?.chunks !== chunkFiles.length) for (const entry of chunkFiles) {
                    storedBytes += (await fs.stat(join(uploadDirectory, entry.name))).size;
                }
                const total = storedBytes + Buffer.byteLength(encoded) + 40;
                if (total > MAX_ARCHIVE_BYTES) throw new Error('Portable history exceeds storage limit');
                await this.publish(path, encoded, key);
                this.stagedFootprints.set(request.snapshotId, { chunks: chunkFiles.length + 1, bytes: total });
                return { success: true };
            }
            if (request.chunks > MAX_CHUNKS) throw new Error('Portable history exceeds chunk limit');
            const chunkFiles = (await fs.readdir(uploadDirectory)).filter(name => /^\d+\.chunk$/.test(name));
            if (chunkFiles.length !== request.chunks) throw new Error('Portable history upload chunk count mismatch');
            const archivePath = join(uploadDirectory, 'archive.enc');
            const existing = await this.readEncrypted(archivePath, key);
            if (existing !== null) {
                if (sha(existing) !== request.sha256) throw new Error('Portable history snapshot is immutable');
                const descriptor = descriptorOf(parseArchive(existing, request.snapshotId), request.sha256);
                this.assertOpen();
                await this.saveReceipt(directory, key, { version: 1, boundary, descriptor });
                return { success: true, descriptor };
            }
            const parts: string[] = [];
            let size = 0;
            for (let index = 0; index < request.chunks; index++) {
                const encoded = await this.readEncrypted(join(uploadDirectory, `${index}.chunk`), key);
                if (encoded === null) throw new Error('Portable history upload is incomplete');
                let chunk: unknown;
                try { chunk = JSON.parse(encoded); } catch { throw new Error('Invalid portable history chunk'); }
                if (typeof chunk !== 'string') throw new Error('Invalid portable history chunk');
                size += Buffer.byteLength(chunk);
                if (size > MAX_ARCHIVE_BYTES) throw new Error('Portable history exceeds storage limit');
                parts.push(chunk);
            }
            const raw = parts.join('');
            if (sha(raw) !== request.sha256) throw new Error('Portable history digest mismatch');
            const archive = parseArchive(raw, request.snapshotId);
            await this.publish(archivePath, raw, key);
            this.assertOpen();
            if (boundaryIdentity(this.options.boundary?.()) !== boundaryIdentity(boundary)) throw new Error('Portable history boundary was cleared');
            const descriptor = descriptorOf(archive, request.sha256);
            await this.saveReceipt(directory, key, { version: 1, boundary, descriptor });
            return { success: true, descriptor };
        });
    }

    private currentDescriptor(): PortableContextDescriptor {
        this.assertOpen();
        const active = this.getPublishedDescriptor();
        if (!active || this.revokedSnapshots.has(active.id)) throw new Error('No committed portable history is active or it was cleared');
        const hint = this.options.descriptor();
        if (hint !== undefined) {
            const parsed = PortableContextDescriptorSchema.safeParse(hint);
            if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(active)) throw new Error('Portable history descriptor mismatch');
        }
        return active;
    }

    private assertCurrent(descriptor: PortableContextDescriptor, generation: number): void {
        if (generation !== this.generation || JSON.stringify(this.currentDescriptor()) !== JSON.stringify(descriptor)) {
            throw new Error('Portable history was replaced or cleared');
        }
    }

    private async activeArchive(): Promise<{ descriptor: PortableContextDescriptor; archive: PortableContextArchive; raw: string; generation: number }> {
        await this.ready;
        const generation = this.generation;
        const descriptor = this.currentDescriptor();
        if (this.cached && JSON.stringify(this.cached.descriptor) === JSON.stringify(descriptor)) return { ...this.cached, generation };
        const { directory, key } = await this.ready;
        const raw = await this.readEncrypted(join(directory, descriptor.id, 'archive.enc'), key);
        if (raw === null || sha(raw) !== descriptor.sha256) throw new Error('Committed portable history is unavailable');
        const archive = parseArchive(raw, descriptor.id);
        if (JSON.stringify(descriptorOf(archive, descriptor.sha256)) !== JSON.stringify(descriptor)) throw new Error('Portable history descriptor mismatch');
        this.assertCurrent(descriptor, generation);
        this.cached = { descriptor, archive, raw };
        return { descriptor, archive, raw, generation };
    }

    /**
     * Export the immutable original JSON, including private blob keys, for a
     * frozen inherited prefix. This is deliberately absent from MCP tools.
     * Recheck durable authority as well as this instance's generation: a
     * daemon reader and a live worker may hold separate store instances.
     */
    async exportPage(input: { textOffset?: number }): Promise<PortableContextExportPage> {
        const offset = input?.textOffset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid portable history export offset');
        const { descriptor, raw, generation } = await this.activeArchive();
        if (offset > raw.length) throw new Error('Portable history export offset exceeds archive length');
        const { directory, key } = await this.ready;
        const authority = await this.readEncrypted(join(directory, 'active.enc'), key);
        let parsed: unknown;
        try { parsed = authority === null ? null : JSON.parse(authority); }
        catch { throw new Error('Invalid portable history export authority'); }
        const receipt = ActiveReceiptSchema.safeParse(parsed);
        if (!receipt.success || boundaryIdentity(receipt.data.boundary) !== boundaryIdentity(this.options.boundary?.())
            || JSON.stringify(receipt.data.descriptor) !== JSON.stringify(descriptor)) {
            throw new Error('Portable history export was replaced or cleared');
        }
        const end = Math.min(offset + 48000, raw.length);
        const result = { chunk: raw.slice(offset, end), nextTextOffset: end < raw.length ? end : null, descriptor };
        this.assertCurrent(descriptor, generation);
        return result;
    }

    async read(input: unknown): Promise<CallToolResult> {
        const parsed = PortableThreadReadSchema.safeParse(input);
        if (!parsed.success) throw new Error('Invalid thread_read arguments');
        const args = parsed.data;
        const { archive, descriptor, generation } = await this.activeArchive();
        if (args.itemId !== undefined) {
            const item = archive.snapshot.items.find(item => item.id === args.itemId);
            if (!item) throw new Error('Portable history item does not exist');
            const offset = args.textOffset ?? 0;
            const text = item.text.slice(offset, offset + (args.limit ?? 16000));
            const attachmentOffset = args.offset ?? 0;
            const attachments = item.attachments ?? [];
            const result = textResult({ ...item, attachments: attachments.slice(attachmentOffset, attachmentOffset + 25).map(attachment => ({
                id: attachment.id, name: attachment.name.slice(0, 256), size: attachment.size, kind: attachment.kind, mimeType: attachment.mimeType,
            })), attachmentOffset, nextAttachmentOffset: attachmentOffset + 25 < attachments.length ? attachmentOffset + 25 : null,
                text, textOffset: offset, textLength: item.text.length,
                nextTextOffset: offset + text.length < item.text.length ? offset + text.length : null });
            this.assertCurrent(descriptor, generation);
            return result;
        }
        const query = args.query?.toLocaleLowerCase();
        const matches = archive.snapshot.items.filter(item => !query || item.text.toLocaleLowerCase().includes(query));
        const offset = args.offset ?? 0;
        const page = matches.slice(offset, offset + Math.min(args.limit ?? 25, 100));
        const result = textResult({ snapshotId: archive.snapshot.id, total: matches.length, offset,
            nextOffset: offset + page.length < matches.length ? offset + page.length : null,
            items: page.map(item => ({ id: item.id, sourceSessionId: item.sourceSessionId, seq: item.seq, role: item.role,
                text: item.text.slice(0, 160), textLength: item.text.length, attachmentCount: item.attachments?.length ?? 0,
                read: { itemId: item.id, textOffset: 0 } })) });
        this.assertCurrent(descriptor, generation);
        return result;
    }

    async attachment(input: unknown): Promise<CallToolResult> {
        const parsed = PortableThreadAttachmentSchema.safeParse(input);
        if (!parsed.success) throw new Error('Invalid thread_attachment arguments');
        const { archive, descriptor, generation } = await this.activeArchive();
        const attachment = archive.snapshot.items.flatMap(item => item.attachments ?? []).find(item => item.id === parsed.data.attachmentId);
        if (!attachment) throw new Error('Attachment is not in the active history manifest');
        const limit = attachment.encrypted ? MAX_ENCRYPTED_ATTACHMENT_BYTES : MAX_ATTACHMENT_BYTES;
        if (attachment.size > limit) throw new Error('Attachment exceeds materialization limit');
        let output: string | undefined;
        let materializedDirectory: string | undefined;
        let response: Response | undefined;
        try {
            response = await openAttachmentDownload({ serverUrl: this.options.serverUrl, token: this.options.token,
                sessionId: attachment.sourceSessionId, ref: attachment.ref, timeoutMs: 120000, restrictOrigin: true });
            const maxWireBytes = attachment.size + (attachment.encrypted ? 40 : 0);
            if (!response.body) throw new Error('Attachment has no body');
            const contentLength = response.headers.get('content-length');
            if (contentLength && Number(contentLength) > maxWireBytes) {
                await response.body.cancel(); throw new Error('Attachment size mismatch');
            }
            this.assertCurrent(descriptor, generation);
            materializedDirectory = await fs.mkdtemp(join(tmpdir(), 'paws-thread-'));
            this.materializedDirectories.add(materializedDirectory);
            await fs.chmod(materializedDirectory, 0o700);
            this.assertCurrent(descriptor, generation);
            const name = attachment.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100) || 'attachment';
            output = join(materializedDirectory, `${sha(attachment.id).slice(0, 24)}-${randomUUID()}-${name}`);
            const handle = await fs.open(output, 'wx', 0o600);
            const reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            const digest = createHash('sha256');
            let received = 0;
            try {
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    this.assertCurrent(descriptor, generation);
                    received += chunk.value.length;
                    if (received > maxWireBytes) { await reader.cancel(); throw new Error('Attachment size mismatch'); }
                    if (attachment.encrypted) chunks.push(chunk.value);
                    else { await handle.writeFile(chunk.value); digest.update(chunk.value); }
                }
                if (received !== maxWireBytes) throw new Error('Attachment size mismatch');
                if (attachment.encrypted) {
                    const decoded = decryptBlob(Buffer.concat(chunks), Buffer.from(archive.blobKeys[attachment.sourceSessionId], 'base64'));
                    if (!decoded || decoded.length !== attachment.size) throw new Error('Attachment authentication failed');
                    await handle.writeFile(decoded); digest.update(decoded);
                }
            } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); await handle.close(); }
            this.assertCurrent(descriptor, generation);
            const result = textResult({ attachmentId: attachment.id, sourceSessionId: attachment.sourceSessionId,
                path: output, name: attachment.name, size: attachment.size, mimeType: attachment.mimeType, sha256: digest.digest('hex') });
            if (attachment.kind === 'image' && attachment.size <= 2 * 1024 * 1024) {
                const bytes = await fs.readFile(output);
                const detected = detectCodexImage(bytes);
                if (detected) result.content.push({ type: 'image', mimeType: detected.mime, data: bytes.toString('base64') });
            }
            this.assertCurrent(descriptor, generation);
            return result;
        } catch {
            if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
            if (output) await fs.unlink(output).catch(() => {});
            if (materializedDirectory) {
                await fs.rm(materializedDirectory, { recursive: true, force: true });
                this.materializedDirectories.delete(materializedDirectory);
            }
            throw new Error('Portable attachment could not be materialized; it may be unavailable, invalid, oversized, or cleared');
        }
    }
}

export type PortableThreadReadInput = z.infer<typeof PortableThreadReadSchema>;
export type PortableThreadAttachmentInput = z.infer<typeof PortableThreadAttachmentSchema>;
