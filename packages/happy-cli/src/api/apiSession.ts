import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import { readFile, stat, unlink } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { basename } from 'node:path'
import { io, Socket } from 'socket.io-client'
import { AgentState, ClientToServerEvents, FileEventMessage, FileEventMessageSchema, Metadata, ServerToClientEvents, Session, Update, UserMessage, UserMessageSchema, Usage } from './types'
import { decodeBase64, decryptBlob, encryptBlob, decrypt, encodeBase64, encrypt } from './encryption';
import { requestAttachmentUpload, uploadEncryptedBlob, uploadMediaFile } from './attachmentUpload';
import { detectHonorMotionPhoto, type MotionPhotoVideo } from '@slopus/happy-wire';
import { backoff, delay } from '@/utils/time';
import { configuration } from '@/configuration';
import { RawJSONLines } from '@/claude/types';
import { randomUUID } from 'node:crypto';
import { AsyncLock } from '@/utils/lock';
import { deriveKey } from '@/utils/deriveKey';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers';
import { ScreenshotStore } from '@/utils/screenshotStore';
import { calculateCost } from '@/utils/pricing';
import { shouldReconnect } from '@/utils/lidState';
import { createEnvelope, type SessionEnvelope, type SessionTurnEndStatus } from '@slopus/happy-wire';
import {
    closeClaudeTurnWithStatus,
    mapClaudeLogMessageToSessionEnvelopes,
    type ClaudeSessionProtocolState,
} from '@/claude/utils/sessionProtocolMapper';
import { InvalidateSync } from '@/utils/sync';
import { readImageSize } from './imageSize';
import type { PendingAttachment } from '@/utils/MessageQueue2';
import axios from 'axios';
import { resolveMediaArtifact } from './mediaArtifact';
import { applyPersistedTurnStatus, clearStaleRunningTurnStatus } from './sessionTurnStatus';

function redactPresignedUrl(url: string): string {
    return url.replace(/([?&](?:X-Amz-Signature|Signature)=)[^&]+/g, '$1<redacted>');
}

function responsePreview(data: unknown): string | undefined {
    if (!data) return undefined;
    const text = Buffer.isBuffer(data)
        ? data.toString('utf8')
        : data instanceof ArrayBuffer
            ? Buffer.from(data).toString('utf8')
            : ArrayBuffer.isView(data)
                ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
                : typeof data === 'string'
                    ? data
                    : JSON.stringify(data);
    return text.slice(0, 500);
}

function enrichAttachmentDownloadError(error: unknown, phase: string, url: string): Error {
    if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const statusText = error.response?.statusText;
        const preview = responsePreview(error.response?.data);
        const details = [
            `attachment ${phase} failed`,
            status ? `status=${status}` : undefined,
            statusText ? `statusText=${statusText}` : undefined,
            `url=${url}`,
            preview ? `body=${preview}` : undefined,
        ].filter(Boolean).join(' ');
        const enriched = new Error(details);
        enriched.cause = error;
        return enriched;
    }
    return error instanceof Error ? error : new Error(String(error));
}

/**
 * Stream an HTTP response body straight to a file on disk, backpressured, never
 * buffering the whole payload in memory. This is the plaintext audio/video lane
 * (blobs up to 500MB); on any failure the partial file is unlinked so callers
 * never observe a truncated file. Exported for unit testing against a real
 * local HTTP server (no mocks).
 */
export async function streamResponseBodyToFile(response: Response, destPath: string): Promise<void> {
    if (!response.body) {
        throw new Error('attachment download returned no body to stream');
    }
    try {
        await pipeline(Readable.fromWeb(response.body as any), createWriteStream(destPath));
    } catch (error) {
        await unlink(destPath).catch(() => {});
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`attachment stream-to-disk failed: ${message}`);
    }
}

/**
 * ACP (Agent Communication Protocol) message data types.
 * This is the unified format for all agent messages - CLI adapts each provider's format to ACP.
 */
export type ACPMessageData =
    // Core message types
    | { type: 'message'; message: string }
    | { type: 'reasoning'; message: string }
    | { type: 'thinking'; text: string }
    // Tool interactions
    | { type: 'tool-call'; callId: string; name: string; input: unknown; id: string }
    | { type: 'tool-result'; callId: string; output: unknown; id: string; isError?: boolean }
    // File operations
    | { type: 'file-edit'; description: string; filePath: string; diff?: string; oldContent?: string; newContent?: string; id: string }
    // Terminal/command output
    | { type: 'terminal-output'; data: string; callId: string }
    // Task lifecycle events
    | { type: 'task_started'; id: string }
    | { type: 'task_complete'; id: string }
    | { type: 'turn_aborted'; id: string; status?: 'failed' | 'cancelled' }
    // Permissions
    | { type: 'permission-request'; permissionId: string; toolName: string; description: string; options?: unknown }
    // Usage/metrics
    | { type: 'token_count';[key: string]: unknown };

export type ACPProvider = 'gemini' | 'codex' | 'claude' | 'opencode';

type V3SessionMessage = {
    id: string;
    seq: number;
    content: { t: 'encrypted'; c: string };
    localId: string | null;
    createdAt: number;
    updatedAt: number;
};

type V3GetSessionMessagesResponse = {
    messages: V3SessionMessage[];
    hasMore: boolean;
};

type V3PostSessionMessagesResponse = {
    messages: Array<{
        id: string;
        seq: number;
        localId: string | null;
        createdAt: number;
        updatedAt: number;
    }>;
};

export class ApiSessionClient extends EventEmitter {
    private readonly token: string;
    readonly sessionId: string;
    private metadata: Metadata | null;
    private metadataVersion: number;
    private agentState: AgentState | null;
    private agentStateVersion: number;
    private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private pendingMessages: UserMessage[] = [];
    private pendingMessageCallback: ((message: UserMessage) => void) | null = null;
    private pendingFileEvents: FileEventMessage[] = [];
    private pendingFileEventCallback: ((data: FileEventMessage) => void) | null = null;
    private blobKey: Uint8Array | null = null;
    /**
     * In-flight attachment download promises that belong to the *current*
     * (not-yet-drained) batch. Each promise resolves to the decoded blob (or
     * null on failure), so per-message ownership is intrinsic — there is no
     * shared push-array between batches that a late download could leak into.
     */
    private pendingDownloads: Promise<PendingAttachment | null>[] = [];
    readonly rpcHandlerManager: RpcHandlerManager;
    /**
     * 会话内截图临时缓存：由 client 持有，构造时即 new，时序最早。
     * MCP take 工具（startHappyServer）与会话级 RPC getScreenshotById 共享同一实例，
     * 这样 AI 截图存进去后，App 懒拉取时能查到磁盘路径。
     */
    readonly screenshotStore = new ScreenshotStore();
    private agentStateLock = new AsyncLock();
    private metadataLock = new AsyncLock();
    private encryptionKey: Uint8Array;
    private encryptionVariant: 'legacy' | 'dataKey';
    private reconnectInterval: NodeJS.Timeout | null = null;
    private ignoreArchiveSignal = false;
    private skipInitialMessages = false;
    private hasObservedRootTurnLifecycle = false;
    private claudeSessionProtocolState: ClaudeSessionProtocolState = {
        currentTurnId: null,
        uuidToProviderSubagent: new Map<string, string>(),
        taskPromptToSubagents: new Map<string, string[]>(),
        providerSubagentToSessionSubagent: new Map<string, string>(),
        subagentTitles: new Map<string, string>(),
        bufferedSubagentMessages: new Map<string, RawJSONLines[]>(),
        hiddenParentToolCalls: new Set<string>(),
        startedSubagents: new Set<string>(),
        activeSubagents: new Set<string>(),
    };
    private lastSeq = 0;
    private pendingOutbox: Array<{ content: string; localId: string }> = [];
    private readonly sendSync: InvalidateSync;
    private readonly receiveSync: InvalidateSync;

    constructor(token: string, session: Session) {
        super()
        this.token = token;
        this.sessionId = session.id;
        this.metadata = session.metadata;
        this.metadataVersion = session.metadataVersion;
        this.agentState = session.agentState;
        this.agentStateVersion = session.agentStateVersion;
        this.encryptionKey = session.encryptionKey;
        this.encryptionVariant = session.encryptionVariant;
        this.sendSync = new InvalidateSync(() => this.flushOutbox());
        this.receiveSync = new InvalidateSync(() => this.fetchMessages());

        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });
        registerCommonHandlers(this.rpcHandlerManager, this.metadata.path, this.screenshotStore);

        //
        // Create socket
        //

        this.socket = io(configuration.serverUrl, {
            auth: {
                token: this.token,
                clientType: 'session-scoped' as const,
                sessionId: this.sessionId,
                happyClient: `cli-coding-session/${configuration.currentCliVersion}`
            },
            path: '/v1/updates',
            reconnection: false,
            transports: ['websocket'],
            withCredentials: true,
            autoConnect: false
        });

        //
        // Handlers
        //

        this.socket.on('connect', () => {
            logger.debug('Socket connected successfully');
            if (this.reconnectInterval) {
                clearInterval(this.reconnectInterval);
                this.reconnectInterval = null;
            }
            this.rpcHandlerManager.onSocketConnect(this.socket);
            this.receiveSync.invalidate();
        })

        // Set up global RPC request handler
        this.socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data));
        })

        this.socket.on('disconnect', (reason) => {
            logger.debug(`[API] Socket disconnected: ${reason}`);
            this.rpcHandlerManager.onSocketDisconnect();
            this.startSmartReconnect();
        })

        this.socket.on('connect_error', (error) => {
            logger.debug('[API] Socket connection error:', error);
            this.rpcHandlerManager.onSocketDisconnect();
            this.startSmartReconnect();
        })

        // Server events
        this.socket.on('update', (data: Update) => {
            try {
                logger.debugLargeJson('[SOCKET] [UPDATE] Received update:', data);

                if (!data.body) {
                    logger.debug('[SOCKET] [UPDATE] [ERROR] No body in update!');
                    return;
                }

                if (data.body.t === 'new-message') {
                    const messageSeq = data.body.message?.seq;
                    if (this.lastSeq === 0) {
                        this.receiveSync.invalidate();
                        return;
                    }
                    if (typeof messageSeq !== 'number' || messageSeq !== this.lastSeq + 1 || data.body.message.content.t !== 'encrypted') {
                        this.receiveSync.invalidate();
                        return;
                    }
                    const body = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.message.content.c));
                    logger.debugLargeJson('[SOCKET] [UPDATE] Received update:', body)
                    this.routeIncomingMessage(body);
                    this.lastSeq = messageSeq;
                } else if (data.body.t === 'update-session') {
                    if (data.body.metadata && data.body.metadata.version > this.metadataVersion) {
                        this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.metadata.value));
                        this.metadataVersion = data.body.metadata.version;
                        // Check if session was archived from web/mobile
                        const meta = this.metadata as any;
                        if (meta?.lifecycleState === 'archiveRequested' || meta?.lifecycleState === 'archived') {
                            if (this.ignoreArchiveSignal) {
                                logger.debug(`[SOCKET] Session archived (${meta.lifecycleState}) but suppressed for reconnect`);
                                this.ignoreArchiveSignal = false;
                            } else {
                                logger.debug(`[SOCKET] Session archived (${meta.lifecycleState}), exiting...`);
                                this.emit('archived');
                            }
                        }
                    }
                    if (data.body.agentState && data.body.agentState.version > this.agentStateVersion) {
                        this.agentState = data.body.agentState.value ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.agentState.value)) : null;
                        this.agentStateVersion = data.body.agentState.version;
                    }
                } else if (data.body.t === 'update-machine') {
                    // Session clients shouldn't receive machine updates - log warning
                    logger.debug(`[SOCKET] WARNING: Session client received unexpected machine update - ignoring`);
                } else {
                    // If not a user message, it might be a permission response or other message type
                    this.emit('message', data.body);
                }
            } catch (error) {
                logger.debug('[SOCKET] [UPDATE] [ERROR] Error handling update', { error });
            }
        });

        // DEATH
        this.socket.on('error', (error) => {
            logger.debug('[API] Socket error:', error);
        });

        //
        // Connect (after short delay to give a time to add handlers)
        //

        this.socket.connect();
    }

    onUserMessage(callback: (data: UserMessage) => void) {
        this.pendingMessageCallback = callback;
        while (this.pendingMessages.length > 0) {
            callback(this.pendingMessages.shift()!);
        }
    }

    onFileEvent(callback: (data: FileEventMessage) => void) {
        this.pendingFileEventCallback = callback;
        while (this.pendingFileEvents.length > 0) {
            callback(this.pendingFileEvents.shift()!);
        }
    }

    /**
     * Derive (and cache) the blob decryption key for this session.
     * Legacy sessions use deriveKey(masterSecret, 'Happy Blobs', ['master']).
     * DataKey sessions use deriveKey(dataKey, 'Happy Blobs', ['session']).
     */
    async getBlobKey(): Promise<Uint8Array> {
        if (!this.blobKey) {
            const path = this.encryptionVariant === 'dataKey' ? ['session'] : ['master'];
            this.blobKey = await deriveKey(this.encryptionKey, 'Happy Blobs', path);
        }
        return this.blobKey;
    }

    /**
     * Download an encrypted attachment blob via the request-download flow:
     * POST /request-download → { downloadUrl } → GET downloadUrl. Local mode
     * downloadUrl points back at our server (Bearer required); S3 mode is a
     * presigned URL that does not accept extra headers.
     */
    async downloadAttachment(ref: string): Promise<Uint8Array> {
        const response = await this.openAttachmentDownload(ref, 60000);
        const buffer = await response.arrayBuffer();
        return new Uint8Array(buffer);
    }

    /**
     * Resolve a ref to a fetched, ok Response ready to read/stream.
     *
     * POST /request-download → { downloadUrl }, then GET it. Local-storage
     * downloadUrls point back at our own happy server and need the Bearer
     * token; presigned S3 URLs carry auth in the query string and reject extra
     * headers, so only those go out unauthenticated. The serverUrl may be a
     * loopback address while the server builds the URL from its PUBLIC_URL
     * host, so an exact prefix match misses — detect presigned S3 by the
     * X-Amz-* / Signature query params instead.
     */
    private async openAttachmentDownload(ref: string, timeoutMs: number): Promise<Response> {
        const requestUrl = `${configuration.serverUrl}/v1/sessions/${this.sessionId}/attachments/request-download`;
        let requestRes;
        try {
            requestRes = await axios.post(
                requestUrl,
                { ref },
                {
                    headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
                    timeout: 30000,
                },
            );
        } catch (error) {
            throw enrichAttachmentDownloadError(error, 'request-download', requestUrl);
        }
        const downloadUrl = requestRes.data?.downloadUrl;
        if (typeof downloadUrl !== 'string') {
            throw new Error('request-download returned no downloadUrl');
        }

        const isPresignedS3 = /[?&](X-Amz-Algorithm|X-Amz-Signature|X-Amz-Credential|Signature|Expires)=/.test(downloadUrl);
        const headers: Record<string, string> = {};
        if (!isPresignedS3) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }
        const abort = AbortSignal.timeout(timeoutMs);
        let response: Response;
        try {
            response = await fetch(downloadUrl, {
                headers,
                signal: abort,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`attachment download network error: ${message}`);
        }
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`attachment download failed: ${response.status}${body ? ` ${body}` : ''}`);
        }
        return response;
    }

    /**
     * Stream a plaintext (unencrypted) attachment straight to disk without ever
     * holding the whole file in memory. Used for the audio/video lane, where a
     * blob can be up to 500MB — an arrayBuffer() there would OOM the daemon,
     * especially with several sessions downloading concurrently. On any failure
     * the half-written file is removed so callers never see a truncated file.
     */
    async streamAttachmentToDisk(ref: string, destPath: string): Promise<void> {
        // Longer timeout than the buffered path: 500MB over a slow link needs more headroom.
        const response = await this.openAttachmentDownload(ref, 15 * 60 * 1000);
        await streamResponseBodyToFile(response, destPath);
    }

    /**
     * Download and decrypt an attachment blob.
     * Returns the decrypted binary data or null if decryption fails.
     */
    async downloadAndDecryptAttachment(ref: string): Promise<Uint8Array | null> {
        const encrypted = await this.downloadAttachment(ref);
        const key = await this.getBlobKey();
        const decrypted = decryptBlob(encrypted, key);
        return decrypted;
    }

    /**
     * Encrypt + upload a local image file via the attachment channel, returning the
     * server ref. Reuses getBlobKey() so the app can decrypt with the same session
     * blob key. Throws on read/encrypt/upload failure.
     */
    async uploadImageAttachment(filePath: string): Promise<{ ref: string; name: string; size: number; dims: { width: number; height: number } | null; motionPhoto: MotionPhotoVideo | null }> {
        const raw = new Uint8Array(await readFile(filePath));
        const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
        if (raw.length > MAX_ATTACHMENT_BYTES) {
            throw new Error(`Image too large: ${raw.length} bytes (max ${MAX_ATTACHMENT_BYTES})`);
        }
        const dims = readImageSize(raw);
        const name = basename(filePath);
        const key = await this.getBlobKey();
        const encrypted = encryptBlob(raw, key);
        const descriptor = await requestAttachmentUpload(
            configuration.serverUrl,
            this.token,
            this.sessionId,
            name,
            encrypted.length,
        );
        await uploadEncryptedBlob(descriptor, encrypted, this.token);
        return { ref: descriptor.ref, name, size: raw.length, dims, motionPhoto: detectHonorMotionPhoto(raw) };
    }

    /** Stream a locally generated media artifact through the plaintext lane. */
    async uploadMediaAttachment(filePath: string, requestedMimeType?: string): Promise<{
        ref: string;
        name: string;
        size: number;
        kind: 'audio' | 'video';
        mimeType: string;
    }> {
        const media = resolveMediaArtifact(filePath, requestedMimeType);
        const info = await stat(filePath);
        if (!info.isFile()) throw new Error(`Not a regular file: ${filePath}`);
        const maxBytes = 500 * 1024 * 1024;
        if (info.size > maxBytes) {
            throw new Error(`Media file too large: ${info.size} bytes (max ${maxBytes})`);
        }

        const name = basename(filePath);
        const descriptor = await requestAttachmentUpload(
            configuration.serverUrl,
            this.token,
            this.sessionId,
            name,
            info.size,
            media.kind,
        );
        await uploadMediaFile(descriptor, filePath, info.size, media.mimeType, this.token);
        return { ref: descriptor.ref, name, size: info.size, ...media };
    }

    /**
     * Emit a file event so the app renders the uploaded attachment inline (FileView).
     * When dims are provided we include an image{} block carrying the real width/height
     * so the app renders at the true aspect ratio. The wire schema requires
     * image.thumbhash; we don't compute a real one, so we pass thumbhash:'' — the app's
     * FileView treats a falsy thumbhash as "no placeholder" but still uses width/height.
     * When dims is null/undefined (non-image or unparseable) we omit image{} and the app
     * falls back to a 4:3 inline render. Use role 'user' to match the proven path.
     */
    sendFileEvent(ref: string, name: string, size: number, dims?: { width: number; height: number } | null, options?: {
        source?: 'user' | 'generated';
        kind?: 'audio' | 'video';
        mimeType?: string;
        encrypted?: boolean;
        prompt?: string;
        batchId?: string;
        localPath?: string;
        motionPhoto?: MotionPhotoVideo;
    }): void {
        const metadata = {
            ...(options?.source ? { source: options.source } : {}),
            ...(options?.kind ? { kind: options.kind } : {}),
            ...(options?.mimeType ? { mimeType: options.mimeType } : {}),
            ...(options?.encrypted !== undefined ? { encrypted: options.encrypted } : {}),
            ...(options?.prompt ? { prompt: options.prompt } : {}),
            ...(options?.batchId ? { batchId: options.batchId } : {}),
            ...(options?.localPath ? { localPath: options.localPath } : {}),
            ...(options?.motionPhoto ? { motionPhoto: options.motionPhoto } : {}),
        };
        const ev = dims
            ? { t: 'file' as const, ref, name, size, ...metadata, image: { width: dims.width, height: dims.height, thumbhash: '' } }
            : { t: 'file' as const, ref, name, size, ...metadata };
        this.sendSessionProtocolMessage(createEnvelope('user', ev));
    }

    /**
     * Track an attachment download whose promise resolves to the decoded blob
     * (or null on failure). The download stays in the current batch until the
     * next drainAttachmentsForUserMessage call swaps the bucket out — file
     * events that arrive after the swap go into a fresh bucket bound to the
     * next user-text message.
     */
    trackAttachmentDownload(promise: Promise<PendingAttachment | null>): void {
        this.pendingDownloads.push(promise);
    }

    /**
     * Atomically claim every download started before this call, wait for them
     * to resolve, and return the successful ones. The swap-then-await order
     * guarantees that a late-arriving file event cannot leak into this batch.
     */
    async drainAttachmentsForUserMessage(): Promise<PendingAttachment[]> {
        const downloads = this.pendingDownloads;
        this.pendingDownloads = [];
        if (downloads.length === 0) return [];
        const results = await Promise.all(downloads);
        return results.filter((x): x is PendingAttachment => x !== null);
    }

    private authHeaders() {
        return {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`
        };
    }

    private routeIncomingMessage(message: unknown) {
        const userResult = UserMessageSchema.safeParse(message);
        if (userResult.success) {
            if (this.pendingMessageCallback) {
                this.pendingMessageCallback(userResult.data);
            } else {
                this.pendingMessages.push(userResult.data);
            }
            return;
        }

        // Check for file events (image attachments from app)
        const fileResult = FileEventMessageSchema.safeParse(message);
        if (fileResult.success) {
            logger.debug(`[API] Received file event: ${fileResult.data.content.data.ev.name} (ref: ${fileResult.data.content.data.ev.ref})`);
            if (this.pendingFileEventCallback) {
                this.pendingFileEventCallback(fileResult.data);
            } else {
                this.pendingFileEvents.push(fileResult.data);
            }
            return;
        }

        this.emit('message', message);
    }

    private async fetchMessages() {
        // On reconnect, skip processing existing messages — just advance lastSeq
        const skipRouting = this.skipInitialMessages;
        if (skipRouting) {
            this.skipInitialMessages = false;
            logger.debug('[API] Reconnect mode: skipping existing messages, advancing lastSeq');
        }

        let afterSeq = this.lastSeq;
        while (true) {
            const response = await axios.get<V3GetSessionMessagesResponse>(
                `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(this.sessionId)}/messages`,
                {
                    params: {
                        after_seq: afterSeq,
                        limit: 100
                    },
                    headers: this.authHeaders(),
                    timeout: 60000
                }
            );

            const messages = Array.isArray(response.data.messages) ? response.data.messages : [];
            let maxSeq = afterSeq;

            for (const message of messages) {
                if (message.seq > maxSeq) {
                    maxSeq = message.seq;
                }

                if (skipRouting) continue;

                if (message.content?.t !== 'encrypted') {
                    continue;
                }

                try {
                    const body = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(message.content.c));
                    this.routeIncomingMessage(body);
                } catch (error) {
                    logger.debug('[API] Failed to decrypt fetched message', {
                        sessionId: this.sessionId,
                        seq: message.seq,
                        error
                    });
                }
            }

            this.lastSeq = Math.max(this.lastSeq, maxSeq);
            const hasMore = !!response.data.hasMore;
            if (hasMore && maxSeq === afterSeq) {
                logger.debug('[API] fetchMessages pagination stalled, stopping to avoid infinite loop', {
                    sessionId: this.sessionId,
                    afterSeq
                });
                break;
            }
            afterSeq = maxSeq;
            if (!hasMore) {
                break;
            }
        }
    }

    private static readonly MAX_OUTBOX_BATCH_SIZE = 50;

    private async flushOutbox() {
        // Send latest messages first so the user sees recent activity immediately,
        // then backfill older messages in subsequent batches.
        while (this.pendingOutbox.length > 0) {
            const batchSize = Math.min(this.pendingOutbox.length, ApiSessionClient.MAX_OUTBOX_BATCH_SIZE);
            const batchStart = this.pendingOutbox.length - batchSize;
            const batch = this.pendingOutbox.slice(batchStart);

            const response = await axios.post<V3PostSessionMessagesResponse>(
                `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(this.sessionId)}/messages`,
                {
                    messages: batch
                },
                {
                    headers: this.authHeaders(),
                    timeout: 60000
                }
            );

            // Do not advance the receive cursor from POST acknowledgements.
            // Outbound agent messages can receive higher seq values while an
            // app-sent user message with a lower seq is still in flight on the
            // socket. Advancing here would make the next catch-up fetch start
            // after that queued user message, so Codex would never read it.
            this.pendingOutbox.splice(batchStart, batch.length);
        }
    }

    private enqueueMessage(content: unknown, invalidate: boolean = true) {
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.pendingOutbox.push({
            content: encrypted,
            localId: randomUUID()
        });
        if (invalidate) {
            this.sendSync.invalidate();
        }
    }

    /**
     * Send message to session
     * @param body - Message body (can be MessageContent or raw content for agent messages)
     */
    sendClaudeSessionMessage(body: RawJSONLines) {
        const mapped = mapClaudeLogMessageToSessionEnvelopes(body, this.claudeSessionProtocolState);
        this.claudeSessionProtocolState.currentTurnId = mapped.currentTurnId;
        for (const envelope of mapped.envelopes) {
            this.sendSessionProtocolMessage(envelope);
        }
        // Track usage from assistant messages
        if (body.type === 'assistant' && body.message?.usage) {
            try {
                this.sendUsageData(body.message.usage, body.message.model);
            } catch (error) {
                logger.debug('[SOCKET] Failed to send usage data:', error);
            }
        }

        // Update metadata with summary if this is a summary message
        if (body.type === 'summary' && 'summary' in body && 'leafUuid' in body) {
            this.updateMetadata((metadata) => ({
                ...metadata,
                summary: {
                    text: body.summary,
                    updatedAt: Date.now()
                }
            }));
        }
    }

    closeClaudeSessionTurn(status: SessionTurnEndStatus = 'completed') {
        const mapped = closeClaudeTurnWithStatus(this.claudeSessionProtocolState, status);
        this.claudeSessionProtocolState.currentTurnId = mapped.currentTurnId;
        for (const envelope of mapped.envelopes) {
            this.sendSessionProtocolMessage(envelope);
        }
    }

    sendCodexMessage(body: any) {
        let content = {
            role: 'agent',
            content: {
                type: 'codex',
                data: body  // This wraps the entire Claude message
            },
            meta: {
                sentFrom: 'cli'
            }
        };
        this.enqueueMessage(content);
    }

    private enqueueSessionProtocolEnvelope(envelope: SessionEnvelope, invalidate: boolean = true) {
        const content = {
            role: 'session',
            content: envelope,
            meta: {
                sentFrom: 'cli'
            }
        };

        this.enqueueMessage(content, invalidate);
    }

    sendSessionProtocolMessage(envelope: SessionEnvelope) {
        if (!envelope.subagent && envelope.role !== 'user') {
            if (envelope.ev.t === 'turn-start') {
                this.hasObservedRootTurnLifecycle = true;
                this.persistTurnStatus('running', envelope.time, envelope.turn);
            } else if (envelope.ev.t === 'turn-end') {
                this.hasObservedRootTurnLifecycle = true;
                this.persistTurnStatus(envelope.ev.status, envelope.time, envelope.turn);
            }
        }

        if (envelope.role !== 'user') {
            this.enqueueSessionProtocolEnvelope(envelope);
            return;
        }

        if (envelope.ev.t !== 'text') {
            this.enqueueSessionProtocolEnvelope(envelope);
            return;
        }

        this.enqueueSessionProtocolEnvelope(envelope);
    }

    /**
     * Send a generic agent message to the session using ACP (Agent Communication Protocol) format.
     * Works for any agent type (Gemini, Codex, Claude, etc.) - CLI normalizes to unified ACP format.
     * 
     * @param provider - The agent provider sending the message (e.g., 'gemini', 'codex', 'claude')
     * @param body - The message payload (type: 'message' | 'reasoning' | 'tool-call' | 'tool-result')
     */
    sendAgentMessage(provider: 'gemini' | 'codex' | 'claude' | 'opencode' | 'openclaw', body: ACPMessageData) {
        if (body.type === 'task_started') {
            this.hasObservedRootTurnLifecycle = true;
            this.persistTurnStatus('running', Date.now(), body.id);
        } else if (body.type === 'task_complete') {
            this.hasObservedRootTurnLifecycle = true;
            this.persistTurnStatus('completed', Date.now(), body.id);
        } else if (body.type === 'turn_aborted') {
            this.hasObservedRootTurnLifecycle = true;
            this.persistTurnStatus(body.status ?? 'cancelled', Date.now(), body.id);
        }

        let content = {
            role: 'agent',
            content: {
                type: 'acp',
                provider,
                data: body
            },
            meta: {
                sentFrom: 'cli'
            }
        };

        logger.debug(`[SOCKET] Sending ACP message from ${provider}:`, { type: body.type, hasMessage: 'message' in body });

        this.enqueueMessage(content);
    }

    sendSessionEvent(event: {
        type: 'switch', mode: 'local' | 'remote'
    } | {
        type: 'message', message: string
    } | {
        type: 'permission-mode-changed', mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
    } | {
        type: 'ready'
    }, id?: string) {
        if (event.type === 'ready' && !this.hasObservedRootTurnLifecycle) {
            this.updateAgentState(clearStaleRunningTurnStatus);
        }
        let content = {
            role: 'agent',
            content: {
                id: id ?? randomUUID(),
                type: 'event',
                data: event
            }
        };
        this.enqueueMessage(content);
    }

    private persistTurnStatus(
        status: 'running' | 'completed' | 'failed' | 'cancelled',
        updatedAt: number,
        turnId?: string,
    ) {
        this.updateAgentState(currentState => applyPersistedTurnStatus(currentState, {
            status,
            updatedAt,
            ...(turnId ? { turnId } : {}),
        }));
    }

    /**
     * Send a ping message to keep the connection alive
     */
    keepAlive(thinking: boolean, mode: 'local' | 'remote') {
        if (process.env.DEBUG) { // too verbose for production
            logger.debug(`[API] Sending keep alive message: ${thinking}`);
        }
        this.socket.volatile.emit('session-alive', {
            sid: this.sessionId,
            time: Date.now(),
            thinking,
            mode
        });
    }

    /**
     * Send session death message
     */
    sendSessionDeath() {
        this.socket.emit('session-end', { sid: this.sessionId, time: Date.now() });
    }

    /**
     * Send usage data to the server
     */
    sendUsageData(usage: Usage, model?: string) {
        // Calculate total tokens
        const totalTokens = usage.input_tokens + usage.output_tokens + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);

        const costs = calculateCost(usage, model);

        // Transform Claude usage format to backend expected format
        const usageReport = {
            key: 'claude-session',
            sessionId: this.sessionId,
            tokens: {
                total: totalTokens,
                input: usage.input_tokens,
                output: usage.output_tokens,
                cache_creation: usage.cache_creation_input_tokens || 0,
                cache_read: usage.cache_read_input_tokens || 0
            },
            cost: {
                total: costs.total,
                input: costs.input,
                output: costs.output
            }
        }
        logger.debugLargeJson('[SOCKET] Sending usage data:', usageReport)
        this.socket.emit('usage-report', usageReport);
    }

    /**
     * Returns the latest session metadata known to the client.
     */
    getMetadata(): Metadata | null {
        return this.metadata;
    }

    /**
     * Update session metadata
     * @param handler - Handler function that returns the updated metadata
     */
    suppressNextArchiveSignal() {
        this.ignoreArchiveSignal = true;
    }

    skipExistingMessages() {
        this.skipInitialMessages = true;
    }

    updateMetadata(handler: (metadata: Metadata) => Metadata) {
        void this.updateMetadataAndAwait(handler);
    }

    async updateMetadataAndAwait(handler: (metadata: Metadata) => Metadata): Promise<void> {
        await this.metadataLock.inLock(async () => {
            await backoff(async () => {
                let updated = handler(this.metadata!); // Weird state if metadata is null - should never happen but here we are
                const answer = await this.socket.emitWithAck('update-metadata', { sid: this.sessionId, expectedVersion: this.metadataVersion, metadata: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)) });
                if (answer.result === 'success') {
                    this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    this.metadataVersion = answer.version;
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.metadataVersion) {
                        this.metadataVersion = answer.version;
                        this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    }
                    throw new Error('Metadata version mismatch');
                } else if (answer.result === 'error') {
                    // Hard error - ignore
                }
            });
        });
    }

    /**
     * Update session agent state
     * @param handler - Handler function that returns the updated agent state
     */
    updateAgentState(handler: (metadata: AgentState) => AgentState): Promise<void> {
        logger.debugLargeJson('Updating agent state', this.agentState);
        return this.agentStateLock.inLock(async () => {
            await backoff(async () => {
                const current = this.agentState || {};
                let updated = handler(current);
                if (updated === current) {
                    return;
                }
                const answer = await this.socket.emitWithAck('update-state', { sid: this.sessionId, expectedVersion: this.agentStateVersion, agentState: updated ? encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)) : null });
                if (answer.result === 'success') {
                    this.agentState = answer.agentState ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState)) : null;
                    this.agentStateVersion = answer.version;
                    logger.debug('Agent state updated', this.agentState);
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.agentStateVersion) {
                        this.agentStateVersion = answer.version;
                        this.agentState = answer.agentState ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState)) : null;
                    }
                    throw new Error('Agent state version mismatch');
                } else if (answer.result === 'error') {
                    // console.error('Agent state update error', answer);
                    // Hard error - ignore
                }
            });
        });
    }

    /**
     * Wait for socket buffer to flush
     */
    async flush(): Promise<void> {
        await Promise.race([
            this.sendSync.invalidateAndAwait(),
            delay(10000)
        ]);
        if (!this.socket.connected) {
            return;
        }
        return new Promise((resolve) => {
            this.socket.emit('ping', () => {
                resolve();
            });
            setTimeout(() => {
                resolve();
            }, 10000);
        });
    }

    async close() {
        logger.debug('[API] socket.close() called');
        this.sendSync.stop();
        this.receiveSync.stop();
        if (this.reconnectInterval) {
            clearInterval(this.reconnectInterval);
            this.reconnectInterval = null;
        }
        this.socket.close();
    }

    private startSmartReconnect() {
        if (this.reconnectInterval) return;

        this.reconnectInterval = setInterval(() => {
            if (this.socket.connected) {
                clearInterval(this.reconnectInterval!);
                this.reconnectInterval = null;
                return;
            }
            if (!shouldReconnect()) {
                logger.debug('[API] Still not ready to reconnect');
                return;
            }
            logger.debug('[API] Attempting reconnect');
            this.socket.connect();
        }, 3000);

        if (shouldReconnect()) {
            logger.debug('[API] Network up + lid open — reconnecting in 1s');
            setTimeout(() => { if (!this.socket.connected) this.socket.connect() }, 1000);
        }
    }
}
