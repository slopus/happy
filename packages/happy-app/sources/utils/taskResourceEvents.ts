import type { DecryptedArtifact } from '@/sync/artifactTypes';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';

export type TaskResourceEventKind =
    | 'file_created'
    | 'file_modified'
    | 'preview_created'
    | 'source_used';

export type TaskResourceType = 'file' | 'image' | 'attachment' | 'artifact' | 'web';

type TaskResourceEventBase = {
    id: string;
    kind: TaskResourceEventKind;
    sessionId: string;
    messageId: string;
    messageIds: string[];
    title: string;
    createdAt: number;
    firstSeenAt: number;
    occurrences: number;
    toolName?: string;
    source?: 'user' | 'generated';
    prompt?: string;
    batchId?: string;
    localPath?: string;
    width?: number;
    height?: number;
    thumbhash?: string;
    mimeType?: string;
    mediaKind?: 'image' | 'audio' | 'video' | 'file';
    size?: number;
    artifactId?: string;
    resourceCreatedAt?: number;
    resourceUpdatedAt?: number;
};

type TaskResourceLocator =
    | { resourceType: 'file'; path: string; uri?: never }
    | { resourceType: Exclude<TaskResourceType, 'file'>; uri: string; path?: never };

export type TaskResourceEvent = TaskResourceEventBase & TaskResourceLocator;

type ProjectionArgs = {
    sessionId: string;
    messages: Message[];
    artifacts?: DecryptedArtifact[];
};

type Candidate = Omit<TaskResourceEventBase, 'id' | 'messageIds' | 'firstSeenAt' | 'occurrences'>
    & TaskResourceLocator;

const SINGLE_FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const PATCH_TOOLS = new Set(['CodexPatch', 'GeminiPatch']);
const WEB_FETCH_TOOLS = new Set(['WebFetch', 'web_fetch', 'webfetch']);
const WEB_SEARCH_TOOLS = new Set(['WebSearch', 'web_search', 'websearch']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCompletedToolMessage(message: Message): message is ToolCallMessage {
    if (message.kind !== 'tool-call' || message.tool.state !== 'completed') {
        return false;
    }
    // Protocol cancellation is normalized as a completed tool shell with a
    // canceled permission marker so the conversation can render its final
    // state. It is still not a successful resource operation.
    if (
        message.tool.permission?.status === 'denied'
        || message.tool.permission?.status === 'canceled'
    ) {
        return false;
    }

    const result = message.tool.result;
    if (isRecord(result)) {
        if (result.success === false || result.is_error === true || result.isError === true) {
            return false;
        }
        const hasErrorValue = (value: unknown) => value === true
            || nonEmptyString(value) !== null
            || (Array.isArray(value) && value.length > 0)
            || (isRecord(value) && Object.keys(value).length > 0);
        if (hasErrorValue(result.error) || hasErrorValue(result.errors)) return false;
        const status = nonEmptyString(result.status)?.toLowerCase();
        if (status && ['error', 'failed', 'cancelled', 'canceled', 'denied'].includes(status)) {
            return false;
        }
    }
    return true;
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function safeHttpUrl(value: unknown): string | null {
    const raw = nonEmptyString(value);
    if (!raw) return null;
    try {
        const parsed = new URL(raw);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
    } catch {
        return null;
    }
}

function titleFromPath(path: string): string {
    const normalized = path.replace(/[\\/]+$/, '');
    return normalized.split(/[\\/]/).pop() || path;
}

function titleFromUrl(uri: string): string {
    try {
        return new URL(uri).hostname;
    } catch {
        return uri;
    }
}

function singleFilePath(input: unknown): string | null {
    if (!isRecord(input)) return null;
    for (const key of ['file_path', 'target_file', 'path', 'notebook_path']) {
        const path = nonEmptyString(input[key]);
        if (path) return path;
    }
    return null;
}

function patchFileCandidates(message: ToolCallMessage): Candidate[] {
    const input = message.tool.input;
    if (!isRecord(input)) return [];
    const values = [input.changes, input.fileChanges];
    const kindByPath = new Map<string, 'file_created' | 'file_modified'>();

    const classifyChange = (
        fallbackPath: string,
        change: Record<string, unknown>,
    ): { path: string; created: boolean } | null => {
        const nestedKind = isRecord(change.kind) ? change.kind : null;
        const action = (
            nonEmptyString(change.action)
            ?? nonEmptyString(change.type)
            ?? nonEmptyString(nestedKind?.type)
        )?.toLowerCase();
        const hasPayload = (key: string) => key in change && change[key] !== null && change[key] !== false;

        if (action === 'delete' || action === 'remove' || hasPayload('delete') || hasPayload('remove')) {
            // There is no file_deleted event yet, and the old path is no
            // longer openable after a successful delete.
            return null;
        }

        const created = action === 'add'
            || action === 'create'
            || hasPayload('add')
            || hasPayload('create');
        const modified = action === 'update'
            || action === 'modify'
            || action === 'edit'
            || hasPayload('update')
            || hasPayload('modify')
            || hasPayload('edit')
            || hasPayload('diff')
            || nonEmptyString(change.unified_diff) !== null;
        if (!created && !modified) return null;

        const movePath = nonEmptyString(change.move_path) ?? nonEmptyString(nestedKind?.move_path);
        const path = movePath ?? fallbackPath.trim();
        return path ? { path, created } : null;
    };

    const collect = (path: string, created: boolean) => {
        if (!path.trim()) return;
        const previous = kindByPath.get(path);
        // Provider aliases may expose the same patch in both `changes` and
        // `fileChanges`. Count the resource once and keep the more specific
        // creation classification when either alias proves it.
        kindByPath.set(path, previous === 'file_created' || created ? 'file_created' : 'file_modified');
    };

    for (const value of values) {
        if (isRecord(value)) {
            for (const [path, change] of Object.entries(value)) {
                if (!isRecord(change)) continue;
                const classified = classifyChange(path, change);
                if (classified) collect(classified.path, classified.created);
            }
        } else if (Array.isArray(value)) {
            for (const change of value) {
                if (!isRecord(change)) continue;
                const path = nonEmptyString(change.path);
                if (!path) continue;
                const classified = classifyChange(path, change);
                if (classified) collect(classified.path, classified.created);
            }
        }
    }

    return [...kindByPath].map(([path, kind]) => ({
        kind,
        sessionId: '',
        messageId: message.id,
        resourceType: 'file',
        title: titleFromPath(path),
        path,
        createdAt: message.createdAt,
        toolName: message.tool.name,
    }));
}

function fileAttachmentCandidate(message: ToolCallMessage): Candidate | null {
    if (message.tool.name !== 'file' || !isRecord(message.tool.input)) return null;
    const ref = nonEmptyString(message.tool.input.ref);
    if (!ref) return null;
    const name = nonEmptyString(message.tool.input.name) ?? 'Image';
    const source = message.tool.input.source;
    // Browser operation frames have their own, chronological visual surface.
    // Keep them out of the generic task-resource/image galleries.
    if (source === 'browser_step') return null;
    const image = isRecord(message.tool.input.image) ? message.tool.input.image : null;
    const explicitKind = nonEmptyString(message.tool.input.kind)?.toLowerCase();
    const mimeType = nonEmptyString(message.tool.input.mimeType);
    const imageByName = /\.(?:avif|gif|heic|heif|jpe?g|png|webp)$/i.test(name);
    const isImage = explicitKind === 'image'
        || mimeType?.toLowerCase().startsWith('image/') === true
        || image !== null
        || (!explicitKind && !mimeType && imageByName);
    const mediaKind = isImage
        ? 'image'
        : explicitKind === 'audio' || explicitKind === 'video'
            ? explicitKind
            : 'file';
    return {
        kind: source === 'generated' ? 'preview_created' : 'source_used',
        sessionId: '',
        messageId: message.id,
        resourceType: isImage ? 'image' : 'attachment',
        title: name,
        uri: ref,
        createdAt: message.createdAt,
        toolName: message.tool.name,
        ...(source === 'generated' || source === 'user' ? { source } : {}),
        ...(nonEmptyString(message.tool.input.prompt) ? { prompt: nonEmptyString(message.tool.input.prompt)! } : {}),
        ...(nonEmptyString(message.tool.input.batchId) ? { batchId: nonEmptyString(message.tool.input.batchId)! } : {}),
        ...(nonEmptyString(message.tool.input.localPath) ? { localPath: nonEmptyString(message.tool.input.localPath)! } : {}),
        ...(typeof image?.width === 'number' ? { width: image.width } : {}),
        ...(typeof image?.height === 'number' ? { height: image.height } : {}),
        ...(nonEmptyString(image?.thumbhash) ? { thumbhash: nonEmptyString(image?.thumbhash)! } : {}),
        ...(mimeType ? { mimeType } : {}),
        mediaKind,
        ...(typeof message.tool.input.size === 'number' ? { size: message.tool.input.size } : {}),
    };
}

function webFetchCandidates(message: ToolCallMessage): Candidate[] {
    if (!WEB_FETCH_TOOLS.has(message.tool.name) || !isRecord(message.tool.input)) return [];
    const uri = safeHttpUrl(message.tool.input.url);
    if (!uri) return [];
    return [{
        kind: 'source_used',
        sessionId: '',
        messageId: message.id,
        resourceType: 'web',
        title: titleFromUrl(uri),
        uri,
        createdAt: message.createdAt,
        toolName: message.tool.name,
    }];
}

function collectLinks(value: unknown, output: Array<{ title?: string; uri: string }>, depth = 0): void {
    if (depth > 4 || output.length >= 50) return;
    if (Array.isArray(value)) {
        for (const entry of value) collectLinks(entry, output, depth + 1);
        return;
    }
    if (isRecord(value)) {
        const uri = safeHttpUrl(value.url ?? value.uri ?? value.href);
        if (uri) output.push({ title: nonEmptyString(value.title) ?? undefined, uri });
        for (const key of ['results', 'links', 'content', 'output', 'data']) {
            if (key in value) collectLinks(value[key], output, depth + 1);
        }
        return;
    }
    if (typeof value !== 'string') return;

    // Claude WebSearch commonly embeds a JSON `Links: [...]` payload in a
    // textual result. Parse only the bracketed JSON; never scrape arbitrary
    // prose URLs and accidentally claim they were used as sources.
    const marker = value.indexOf('Links:');
    if (marker < 0) return;
    const start = value.indexOf('[', marker);
    if (start < 0) return;
    let depthCount = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
        const char = value[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === '[') depthCount += 1;
        else if (char === ']') {
            depthCount -= 1;
            if (depthCount === 0) {
                try {
                    collectLinks(JSON.parse(value.slice(start, index + 1)), output, depth + 1);
                } catch {
                    // Malformed provider output is not a successful source.
                }
                return;
            }
        }
    }
}

function webSearchCandidates(message: ToolCallMessage): Candidate[] {
    if (!WEB_SEARCH_TOOLS.has(message.tool.name)) return [];
    const links: Array<{ title?: string; uri: string }> = [];
    collectLinks(message.tool.result, links);
    const seen = new Set<string>();
    return links.flatMap(({ title, uri }) => {
        if (seen.has(uri)) return [];
        seen.add(uri);
        return [{
            kind: 'source_used' as const,
            sessionId: '',
            messageId: message.id,
            resourceType: 'web' as const,
            title: title ?? titleFromUrl(uri),
            uri,
            createdAt: message.createdAt,
            toolName: message.tool.name,
        }];
    });
}

function messageCandidates(message: ToolCallMessage): Candidate[] {
    const attachment = fileAttachmentCandidate(message);
    if (attachment) return [attachment];
    if (SINGLE_FILE_TOOLS.has(message.tool.name)) {
        const path = singleFilePath(message.tool.input);
        return path ? [{
            kind: 'file_modified',
            sessionId: '',
            messageId: message.id,
            resourceType: 'file',
            title: titleFromPath(path),
            path,
            createdAt: message.createdAt,
            toolName: message.tool.name,
        }] : [];
    }
    if (PATCH_TOOLS.has(message.tool.name)) return patchFileCandidates(message);
    const fetch = webFetchCandidates(message);
    if (fetch.length > 0) return fetch;
    return webSearchCandidates(message);
}

function candidateKey(candidate: Candidate): string {
    return `${candidate.resourceType}:${candidate.path ?? candidate.uri ?? candidate.title}`;
}

function mergeResourceEvent(key: string, previous: TaskResourceEvent, candidate: Candidate): TaskResourceEvent {
    const {
        resourceType: _previousResourceType,
        path: _previousPath,
        uri: _previousUri,
        ...previousBase
    } = previous;
    const history = {
        id: key,
        messageIds: previous.messageIds.includes(candidate.messageId)
            ? previous.messageIds
            : [...previous.messageIds, candidate.messageId],
        firstSeenAt: previous.firstSeenAt,
        occurrences: previous.occurrences + 1,
    };

    if (candidate.resourceType === 'file') {
        const { resourceType, path, uri: _candidateUri, ...candidateBase } = candidate;
        return { ...previousBase, ...candidateBase, ...history, resourceType, path };
    }
    const { resourceType, uri, path: _candidatePath, ...candidateBase } = candidate;
    return { ...previousBase, ...candidateBase, ...history, resourceType, uri };
}

export function projectTaskResourceEvents(args: ProjectionArgs): TaskResourceEvent[] {
    const candidates: Candidate[] = [];
    for (const message of args.messages.filter(isCompletedToolMessage)) {
        candidates.push(...messageCandidates(message).map((candidate) => ({
            ...candidate,
            sessionId: args.sessionId,
        })));
    }

    for (const artifact of args.artifacts ?? []) {
        if (artifact.draft || !artifact.sessions?.includes(args.sessionId)) continue;
        candidates.push({
            kind: 'preview_created',
            sessionId: args.sessionId,
            messageId: `artifact:${artifact.id}`,
            resourceType: 'artifact',
            title: artifact.title || 'Untitled',
            uri: `/artifacts/${artifact.id}`,
            createdAt: artifact.updatedAt,
            artifactId: artifact.id,
            resourceCreatedAt: artifact.createdAt,
            resourceUpdatedAt: artifact.updatedAt,
        });
    }

    const merged = new Map<string, TaskResourceEvent>();
    for (const candidate of candidates.sort((a, b) => a.createdAt - b.createdAt)) {
        const key = candidateKey(candidate);
        const previous = merged.get(key);
        if (!previous) {
            merged.set(key, {
                ...candidate,
                id: key,
                messageIds: [candidate.messageId],
                firstSeenAt: candidate.createdAt,
                occurrences: 1,
            });
            continue;
        }
        // A later modification supersedes an inferred creation for the
        // compact output row while the message chain preserves history.
        merged.set(key, mergeResourceEvent(key, previous, candidate));
    }

    return [...merged.values()].sort((a, b) => b.createdAt - a.createdAt);
}
