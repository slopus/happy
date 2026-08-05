import { describe, expect, it } from 'vitest';
import type { DecryptedArtifact } from '@/sync/artifactTypes';
import type { Message } from '@/sync/typesMessage';
import { projectTaskResourceEvents } from './taskResourceEvents';

function tool(
    id: string,
    name: string,
    input: unknown,
    options: { createdAt?: number; result?: unknown; state?: 'running' | 'completed' | 'error' } = {},
): Message {
    const createdAt = options.createdAt ?? 1000;
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt,
        tool: {
            name,
            state: options.state ?? 'completed',
            input,
            result: options.result,
            createdAt,
            startedAt: createdAt,
            completedAt: createdAt + 1,
            description: null,
        },
        children: [],
    };
}

function artifact(overrides: Partial<DecryptedArtifact> = {}): DecryptedArtifact {
    return {
        id: 'artifact-1',
        title: 'Preview dashboard',
        sessions: ['session-1'],
        draft: false,
        headerVersion: 1,
        bodyVersion: 1,
        seq: 1,
        createdAt: 1000,
        updatedAt: 4000,
        isDecrypted: true,
        ...overrides,
    };
}

describe('projectTaskResourceEvents', () => {
    it('projects the four canonical event kinds from completed historical messages', () => {
        const events = projectTaskResourceEvents({
            sessionId: 'session-1',
            messages: [
                tool('patch', 'CodexPatch', {
                    changes: {
                        'src/new.ts': { add: { content: 'new' } },
                        'src/existing.ts': { update: { content: 'changed' } },
                    },
                }, { createdAt: 1000 }),
                tool('image', 'file', {
                    ref: 'blob://generated',
                    name: 'preview.png',
                    source: 'generated',
                }, { createdAt: 2000 }),
                tool('fetch', 'WebFetch', {
                    url: 'https://example.com/docs',
                }, { createdAt: 3000 }),
            ],
            artifacts: [artifact()],
        });

        expect(new Set(events.map((event) => event.kind))).toEqual(new Set([
            'file_created',
            'file_modified',
            'preview_created',
            'source_used',
        ]));
        expect(events.every((event) => event.sessionId === 'session-1')).toBe(true);
        expect(events.find((event) => event.path === 'src/new.ts')).toMatchObject({
            resourceType: 'file',
            title: 'new.ts',
        });
    });

    it('never reports running or failed tools as successful outputs', () => {
        const canceled = tool('canceled', 'Write', { file_path: '/tmp/canceled.txt' });
        if (canceled.kind === 'tool-call') {
            canceled.tool.permission = { id: 'permission-1', status: 'canceled' };
        }
        const denied = tool('denied', 'Write', { file_path: '/tmp/denied.txt' });
        if (denied.kind === 'tool-call') {
            denied.tool.permission = { id: 'permission-2', status: 'denied' };
        }
        const geminiFailedPatch = tool('gemini-failed', 'GeminiPatch', {
            fileChanges: {
                '/tmp/gemini-failed.txt': { type: 'add', content: 'not written' },
            },
        }, { result: { success: false, stdout: '', stderr: 'patch failed' } });
        const acpFailedWrite = tool('acp-failed', 'Write', {
            file_path: '/tmp/acp-failed.txt',
        }, { result: { error: 'write failed' } });
        const acpFailedFetch = tool('acp-fetch-failed', 'WebFetch', {
            url: 'https://failed.example/source',
        }, { result: { error: { message: 'fetch failed' } } });
        const events = projectTaskResourceEvents({
            sessionId: 'session-1',
            messages: [
                tool('failed', 'Write', { file_path: '/tmp/failed.txt' }, { state: 'error' }),
                tool('running', 'Write', { file_path: '/tmp/running.txt' }, { state: 'running' }),
                canceled,
                denied,
                geminiFailedPatch,
                acpFailedWrite,
                acpFailedFetch,
                tool('done', 'Write', { file_path: '/tmp/done.txt' }, { state: 'completed' }),
            ],
        });

        expect(events.map((event) => event.path)).toEqual(['/tmp/done.txt']);
    });

    it('merges repeated edits by path while preserving the message chain', () => {
        const events = projectTaskResourceEvents({
            sessionId: 'session-1',
            messages: [
                tool('first', 'Write', { file_path: '/repo/README.md' }, { createdAt: 1000 }),
                tool('second', 'Edit', { file_path: '/repo/README.md' }, { createdAt: 3000 }),
                tool('third', 'GeminiPatch', {
                    fileChanges: [{ path: '/repo/README.md', action: 'update' }],
                }, { createdAt: 5000 }),
            ],
        });

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            kind: 'file_modified',
            messageId: 'third',
            messageIds: ['first', 'second', 'third'],
            occurrences: 3,
            firstSeenAt: 1000,
            createdAt: 5000,
        });
    });

    it('deduplicates Codex patch aliases and preserves a proven add classification', () => {
        const events = projectTaskResourceEvents({
            sessionId: 'session-1',
            messages: [
                tool('patch', 'CodexPatch', {
                    changes: {
                        'src/new.ts': {
                            kind: { type: 'add' },
                            add: { content: 'new' },
                        },
                    },
                    fileChanges: {
                        'src/new.ts': {
                            type: 'add',
                            content: 'new',
                        },
                    },
                }),
            ],
        });

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            kind: 'file_created',
            path: 'src/new.ts',
            messageIds: ['patch'],
            occurrences: 1,
        });
    });

    it('skips malformed and deleted patch entries and points moves at the openable destination', () => {
        const events = projectTaskResourceEvents({
            sessionId: 'session-1',
            messages: [
                tool('patch', 'CodexPatch', {
                    changes: {
                        'src/null.ts': null,
                        'src/empty.ts': {},
                        'src/null-add.ts': { add: null },
                        'src/deleted.ts': { kind: { type: 'delete' } },
                        'src/old-name.ts': {
                            kind: { type: 'update', move_path: 'src/new-name.ts' },
                            update: { content: 'renamed' },
                        },
                    },
                }),
            ],
        });

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            kind: 'file_modified',
            path: 'src/new-name.ts',
            title: 'new-name.ts',
        });
    });

    it('keeps only artifacts linked to the current session', () => {
        const events = projectTaskResourceEvents({
            sessionId: 'session-1',
            messages: [],
            artifacts: [
                artifact({ id: 'current', sessions: ['session-1'] }),
                artifact({ id: 'other', sessions: ['session-2'] }),
                artifact({ id: 'draft', sessions: ['session-1'], draft: true }),
            ],
        });

        expect(events.map((event) => event.uri)).toEqual(['/artifacts/current']);
    });

    it('projects user attachments as sources and generated attachments as previews', () => {
        const events = projectTaskResourceEvents({
            sessionId: 'session-1',
            messages: [
                tool('user-image', 'file', { ref: 'blob://user', name: 'brief.png', source: 'user' }),
                tool('generated-image', 'file', { ref: 'blob://generated', name: 'result.png', source: 'generated' }),
            ],
        });

        expect(events.find((event) => event.messageId === 'user-image')?.kind).toBe('source_used');
        expect(events.find((event) => event.messageId === 'generated-image')?.kind).toBe('preview_created');
    });

    it('keeps audio and video file events out of the image resource lane', () => {
        const events = projectTaskResourceEvents({
            sessionId: 'session-1',
            messages: [
                tool('audio', 'file', {
                    ref: 'blob://voice',
                    name: 'voice.mp3',
                    kind: 'audio',
                    mimeType: 'audio/mpeg',
                    source: 'user',
                }),
                tool('video', 'file', {
                    ref: 'blob://clip',
                    name: 'clip.mp4',
                    kind: 'video',
                    mimeType: 'video/mp4',
                    source: 'user',
                }),
            ],
        });

        expect(events).toHaveLength(2);
        expect(events.every((event) => event.resourceType === 'attachment')).toBe(true);
        expect(events.map((event) => event.mediaKind).sort()).toEqual(['audio', 'video']);
    });

    it('parses structured and provider text WebSearch links without scraping arbitrary prose URLs', () => {
        const events = projectTaskResourceEvents({
            sessionId: 'session-1',
            messages: [
                tool('structured', 'WebSearch', { query: 'one' }, {
                    result: { results: [{ title: 'One', url: 'https://one.example/a' }] },
                    createdAt: 1000,
                }),
                tool('text', 'WebSearch', { query: 'two' }, {
                    result: 'Result\nLinks: [{"title":"Two","url":"https://two.example/b"}]\nMore prose.',
                    createdAt: 2000,
                }),
                tool('unsafe-prose', 'WebSearch', { query: 'three' }, {
                    result: 'Mentioned https://not-a-confirmed-source.example in prose only.',
                    createdAt: 3000,
                }),
            ],
        });

        expect(events.map((event) => event.title)).toEqual(['Two', 'One']);
    });

    it('drops malformed and non-http WebFetch addresses', () => {
        const events = projectTaskResourceEvents({
            sessionId: 'session-1',
            messages: [
                tool('bad', 'WebFetch', { url: 'not-a-url' }),
                tool('file', 'WebFetch', { url: 'file:///private/data' }),
                tool('good', 'WebFetch', { url: 'https://docs.example/path' }),
            ],
        });

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ uri: 'https://docs.example/path', title: 'docs.example' });
    });
});
