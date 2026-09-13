import { z } from 'zod';

import { imageDataUri, isImagePath } from '@/utils/imageFiles';
import { apiSocket } from './apiSocket';
import { isRigMetadataV1 } from './rig';
import { storage } from './storage';
import type { Metadata } from './storageTypes';

const HAPPY_AGENT_GIT_RPC_METHODS = ['gitState', 'readFile', 'readFileAtRevision'] as const;
const HAPPY_AGENT_GIT_REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HAPPY_AGENT_GIT_MAX_BYTES = 512 * 1024;
const HAPPY_AGENT_GIT_MAX_TEXT_LINES = 20_000;

const HAPPY_AGENT_GIT_FILE_STATUSES = [
    'added',
    'conflicted',
    'copied',
    'deleted',
    'modified',
    'renamed',
    'submodule',
    'type_changed',
    'untracked',
] as const;

const HappyAgentGitFactsSchema = z.object({
    branch: z.string().nullable(),
    detached: z.boolean(),
    head: z.string().nullable(),
    upstream: z.string().nullable(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
}).passthrough();

export const HappyAgentGitFileSchema = z.object({
    path: z.string().min(1),
    previousPath: z.string().min(1).optional(),
    status: z.enum(HAPPY_AGENT_GIT_FILE_STATUSES),
    staged: z.boolean(),
    unstaged: z.boolean(),
    binary: z.boolean(),
    insertions: z.number().int().nonnegative().optional(),
    deletions: z.number().int().nonnegative().optional(),
}).passthrough();

export type HappyAgentGitFile = z.infer<typeof HappyAgentGitFileSchema>;

export const HappyAgentGitStateSchema = z.object({
    facts: HappyAgentGitFactsSchema,
    comparison: z.enum(['ready', 'unavailable']),
    base: z.string().regex(HAPPY_AGENT_GIT_REVISION_PATTERN).nullable(),
    changedFiles: z.number().int().nonnegative(),
    insertions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    countsExact: z.boolean(),
    conflicted: z.boolean(),
    files: z.array(HappyAgentGitFileSchema),
    filesTruncated: z.boolean(),
    scannedAt: z.number().finite().nonnegative(),
}).passthrough().superRefine((state, context) => {
    if (state.comparison === 'ready' && state.base === null) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'A ready Git comparison must include a base revision.',
            path: ['base'],
        });
    }
});

export type HappyAgentGitState = z.infer<typeof HappyAgentGitStateSchema>;

const HappyAgentGitFailureSchema = z.object({
    success: z.literal(false),
    code: z.enum([
        'invalid',
        'forbidden',
        'missing',
        'too_large',
        'unavailable',
        'unsupported',
    ]),
    error: z.string().min(1),
}).passthrough();

const HappyAgentGitStateResponseSchema = z.union([
    z.object({
        success: z.literal(true),
        git: HappyAgentGitStateSchema,
    }).passthrough(),
    HappyAgentGitFailureSchema,
]);

const HappyAgentGitReadFileResponseSchema = z.union([
    z.object({
        success: z.literal(true),
        content: z.string(),
        hash: z.string().regex(/^[0-9a-f]{64}$/),
    }).passthrough(),
    HappyAgentGitFailureSchema,
]);

const HappyAgentGitReadFileAtRevisionResponseSchema = z.union([
    z.object({
        success: z.literal(true),
        content: z.string(),
    }).passthrough(),
    HappyAgentGitFailureSchema,
]);

export type HappyAgentFileContent =
    | { kind: 'text'; oldText: string; newText: string }
    | { kind: 'image'; before: string | null; after: string | null }
    | { kind: 'message'; message: string };

type ReadSide = 'before' | 'after';

type ReadContent = {
    path: string;
    content: string;
};

function sessionMetadata(sessionId: string): Metadata | null | undefined {
    return storage.getState().sessions[sessionId]?.metadata;
}

function requireSupportedSession(sessionId: string): void {
    if (!supportsHappyAgentGit(sessionMetadata(sessionId))) {
        throw new Error('Git changes are not available for this session.');
    }
}

function parseGitRevision(value: string): boolean {
    return HAPPY_AGENT_GIT_REVISION_PATTERN.test(value);
}

function parseFailureOrThrow<T extends { success: boolean }>(
    result: unknown,
    schema: z.ZodType<T>,
    invalidMessage: string,
): T {
    const parsed = schema.safeParse(result);
    if (!parsed.success) throw new Error(invalidMessage);
    return parsed.data;
}

/** Whether this session advertises the complete native Git changes surface. */
export function supportsHappyAgentGit(metadata: Metadata | null | undefined): boolean {
    if (!isRigMetadataV1(metadata)) return false;
    const capabilities = metadata?.capabilities;
    return capabilities?.files?.read === true
        && Array.isArray(capabilities.rpcMethods)
        && HAPPY_AGENT_GIT_RPC_METHODS.every((method) => capabilities.rpcMethods.includes(method));
}

/** Fetches and validates one native Git snapshot for a session. */
export async function getHappyAgentGitState(sessionId: string): Promise<HappyAgentGitState> {
    requireSupportedSession(sessionId);

    // The native agent resolves its workspace from the session identity.
    const response = await apiSocket.sessionRPC<unknown, Record<string, never>>(sessionId, 'gitState', {});
    const parsed = parseFailureOrThrow(
        response,
        HappyAgentGitStateResponseSchema,
        'Happy Agent returned an invalid Git state.',
    );
    if (!parsed.success) throw new Error(parsed.error);
    return parsed.git;
}

function beforePathFor(file: HappyAgentGitFile): string | null {
    return file.status === 'added' || file.status === 'untracked'
        ? null
        : file.previousPath ?? file.path;
}

function afterPathFor(file: HappyAgentGitFile): string | null {
    return file.status === 'deleted' ? null : file.path;
}

function unsupportedFileMessage(file: HappyAgentGitFile): string | null {
    switch (file.status) {
        case 'conflicted': return 'This file has unresolved conflicts and cannot be previewed.';
        case 'submodule': return 'Submodule changes cannot be previewed.';
        case 'type_changed': return 'This file changed type and cannot be previewed.';
        default: return null;
    }
}

function isBase64(value: string): boolean {
    if (value.length === 0) return true;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;

    const padding = value.length - value.replace(/=+$/, '').length;
    // Existing padding belongs to a complete quartet. Unpadded final
    // quartets are accepted and normalized below.
    if (padding > 0 && value.length % 4 !== 0) return false;
    if (value.length % 4 === 1) return false;
    return true;
}

type Base64Size = { normalized: string; decodedBytes: number };

function inspectBase64(value: string): Base64Size | null {
    const clean = value.replace(/\s+/g, '');
    if (!isBase64(clean)) return null;

    const normalized = clean + '='.repeat((4 - (clean.length % 4)) % 4);
    const padding = normalized.length - normalized.replace(/=+$/, '').length;
    const decodedBytes = normalized.length / 4 * 3 - padding;
    return { normalized, decodedBytes };
}

function decodeUtf8(inspected: Base64Size):
    | { kind: 'text'; value: string }
    | { kind: 'message'; message: string } {
    try {
        const binary = atob(inspected.normalized);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
        }
        // ignoreBOM keeps a leading U+FEFF in the output instead of consuming
        // it, so adding or removing a byte order mark still shows as a change.
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        if (text.includes('\u0000')) {
            return { kind: 'message', message: 'This file contains binary data and cannot be shown as text.' };
        }
        return { kind: 'text', value: text };
    } catch {
        return { kind: 'message', message: 'This file is not valid UTF-8 text.' };
    }
}

/** Counts only real lines, without allocating a split array for large files. */
function countTextLinesWithin(text: string, maximum: number): number | null {
    if (text.length === 0) return 0;
    if (maximum < 1) return null;
    let lines = 1;
    // A final newline terminates the last line; it does not start another one.
    for (let index = 0; index + 1 < text.length; index += 1) {
        if (text.charCodeAt(index) !== 10) continue;
        lines += 1;
        if (lines > maximum) return null;
    }
    return lines;
}

function hasTooManyTextLines(oldText: string, newText: string): boolean {
    const oldLines = countTextLinesWithin(oldText, HAPPY_AGENT_GIT_MAX_TEXT_LINES);
    if (oldLines === null) return true;
    return countTextLinesWithin(newText, HAPPY_AGENT_GIT_MAX_TEXT_LINES - oldLines) === null;
}

async function readSide(
    sessionId: string,
    side: ReadSide,
    path: string,
    revision: string,
): Promise<ReadContent> {
    const response = side === 'after'
        ? await apiSocket.sessionRPC<unknown, { path: string }>(sessionId, 'readFile', { path })
        : await apiSocket.sessionRPC<unknown, { path: string; revision: string }>(sessionId, 'readFileAtRevision', {
            path,
            revision,
        });
    const schema = side === 'after'
        ? HappyAgentGitReadFileResponseSchema
        : HappyAgentGitReadFileAtRevisionResponseSchema;
    const parsed = schema.safeParse(response);
    if (!parsed.success) throw new Error('Happy Agent returned an invalid file response.');
    if (!parsed.data.success) throw new Error(parsed.data.error);
    return { path, content: parsed.data.content };
}

/** Reads the two sides of one snapshot file through the native session RPCs. */
export async function readHappyAgentGitFile(
    sessionId: string,
    gitBase: string,
    file: HappyAgentGitFile,
): Promise<HappyAgentFileContent> {
    requireSupportedSession(sessionId);

    const parsedFile = HappyAgentGitFileSchema.safeParse(file);
    if (!parsedFile.success) throw new Error('Happy Agent returned an invalid Git file.');
    const change = parsedFile.data;

    if (!parseGitRevision(gitBase)) {
        throw new Error('Happy Agent returned an invalid Git comparison base.');
    }

    const unsupported = unsupportedFileMessage(change);
    if (unsupported) return { kind: 'message', message: unsupported };

    const beforePath = beforePathFor(change);
    const afterPath = afterPathFor(change);
    if (beforePath === null && afterPath === null) {
        return { kind: 'message', message: 'This file has no readable comparison side.' };
    }

    if (change.binary) {
        const imageBefore = beforePath !== null && isImagePath(beforePath);
        const imageAfter = afterPath !== null && isImagePath(afterPath);
        const hasNonImageSide = (beforePath !== null && !imageBefore)
            || (afterPath !== null && !imageAfter);
        if (hasNonImageSide) {
            return { kind: 'message', message: 'Binary file changes cannot be previewed.' };
        }
    }

    const settled = await Promise.allSettled([
        beforePath === null ? Promise.resolve<ReadContent | null>(null) : readSide(sessionId, 'before', beforePath, gitBase),
        afterPath === null ? Promise.resolve<ReadContent | null>(null) : readSide(sessionId, 'after', afterPath, gitBase),
    ]);
    const readResult = (result: typeof settled[number]): ReadContent | null => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
    };
    const before = readResult(settled[0]);
    const after = readResult(settled[1]);

    if (change.binary) {
        let beforeUri: string | null = null;
        let afterUri: string | null = null;
        for (const [side, content] of [
            ['before', before] as const,
            ['after', after] as const,
        ]) {
            if (!content) continue;
            const inspected = inspectBase64(content.content);
            if (!inspected) {
                throw new Error('Happy Agent returned invalid file contents.');
            }
            if (inspected.decodedBytes > HAPPY_AGENT_GIT_MAX_BYTES) {
                throw new Error('This file is too large to preview on the phone.');
            }
            if (inspected.decodedBytes === 0) {
                return { kind: 'message', message: 'Image content is empty.' };
            }
            const uri = imageDataUri(content.path, inspected.normalized);
            if (uri === null) return { kind: 'message', message: 'Binary file changes cannot be previewed.' };
            if (side === 'before') beforeUri = uri;
            else afterUri = uri;
        }
        return { kind: 'image', before: beforeUri, after: afterUri };
    }

    const oldBytes = before ? inspectBase64(before.content) : { normalized: '', decodedBytes: 0 };
    const newBytes = after ? inspectBase64(after.content) : { normalized: '', decodedBytes: 0 };
    if (!oldBytes || !newBytes) {
        throw new Error('Happy Agent returned invalid file contents.');
    }
    if (oldBytes.decodedBytes > HAPPY_AGENT_GIT_MAX_BYTES || newBytes.decodedBytes > HAPPY_AGENT_GIT_MAX_BYTES) {
        throw new Error('This file is too large to preview on the phone.');
    }
    const oldText = decodeUtf8(oldBytes);
    const newText = decodeUtf8(newBytes);
    if (oldText.kind === 'message') return oldText;
    if (newText.kind === 'message') return newText;
    if (hasTooManyTextLines(oldText.value, newText.value)) {
        return { kind: 'message', message: 'This file has too many lines to preview here.' };
    }
    return { kind: 'text', oldText: oldText.value, newText: newText.value };
}