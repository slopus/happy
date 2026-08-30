import { describe, expect, it } from 'vitest';
import type { Message } from './typesMessage';
import { buildPublicSessionSnapshot } from './publicSessionSnapshot';

const now = 1_777_777_777_777;

describe('buildPublicSessionSnapshot', () => {
    it('maps visible user, assistant, thinking, and tool content into the public contract', () => {
        const messages: Message[] = [
            { kind: 'user-text', id: 'u1', localId: 'local', createdAt: 1, text: 'private wire text', displayText: 'Visible question' },
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'Visible answer' },
            { kind: 'agent-text', id: 'a2', localId: null, createdAt: 3, text: 'Reasoning', isThinking: true },
            {
                kind: 'tool-call', id: 't1', localId: null, createdAt: 4,
                tool: {
                    name: 'Bash', state: 'completed', input: { command: 'pwd', sessionId: 'secret-session' },
                    description: 'Read the working directory', result: {
                        output: '/workspace',
                        machineId: 'secret-machine',
                        api_key: 'secret-api-key',
                        Authorization: 'Bearer secret-token',
                        nested: { password: 'secret-password' },
                    },
                    createdAt: 4, startedAt: 4, completedAt: 5,
                },
                children: [],
            },
        ];

        const result = buildPublicSessionSnapshot({ title: 'Session title', messages, sharedAt: now });

        expect(result.snapshot).toEqual({
            version: 1,
            title: 'Session title',
            sharedAt: now,
            presentation: { groupToolCalls: true },
            messages: [
                { id: 'message-1', role: 'user', createdAt: 1, blocks: [{ type: 'text', markdown: 'Visible question' }] },
                { id: 'message-2', role: 'assistant', createdAt: 2, blocks: [{ type: 'text', markdown: 'Visible answer' }] },
                { id: 'message-3', role: 'assistant', createdAt: 3, blocks: [{ type: 'thinking', markdown: 'Reasoning' }] },
                {
                    id: 'message-4', role: 'assistant', createdAt: 4,
                    blocks: [{
                        type: 'tool', name: 'Bash', status: 'completed',
                    }],
                },
            ],
        });
        const serialized = JSON.stringify(result.snapshot);
        expect(serialized).not.toContain('private wire text');
        expect(serialized).not.toContain('secret-session');
        expect(serialized).not.toContain('secret-machine');
        expect(serialized).not.toContain('secret-api-key');
        expect(serialized).not.toContain('secret-token');
        expect(serialized).not.toContain('secret-password');
    });

    it('freezes the owner tool-grouping preference into the public snapshot', () => {
        const result = buildPublicSessionSnapshot({
            title: 'Ungrouped session',
            messages: [],
            sharedAt: now,
            groupToolCalls: false,
        });

        expect(result.snapshot.presentation).toEqual({ groupToolCalls: false });
    });

    it('publishes only the public tool envelope and drops hidden tools and private metadata', () => {
        const visible: Message = {
            kind: 'tool-call', id: 'visible', localId: null, createdAt: 1,
            tool: {
                name: 'Read', state: 'completed', description: '/Users/private/secrets.txt',
                input: {
                    path: '/Users/private/secrets.txt', file_path: '/Users/private/secrets.txt', cwd: '/Users/private',
                    workdir: '/workspace/private', homeDir: '/Users/private', host: 'private-host', model: 'internal-model',
                    permission_mode: 'bypassPermissions', token: 'secret-token', arbitrary: 'must-not-be-public',
                },
                result: { output: 'raw private output', apiKey: 'secret-key' },
                createdAt: 1, startedAt: 1, completedAt: 1,
            }, children: [],
        };
        const hiddenTool = (id: string, name: string): Message => ({
            kind: 'tool-call', id, localId: null, createdAt: 2,
            tool: {
                name, state: 'completed', input: { content: 'hidden input' }, result: { content: 'hidden result' },
                description: 'hidden description', createdAt: 2, startedAt: 2, completedAt: 2,
            }, children: [],
        });

        const result = buildPublicSessionSnapshot({
            title: 'Safe tools',
            messages: [
                visible,
                hiddenTool('codex-reasoning', 'CodexReasoning'),
                hiddenTool('gemini-reasoning', 'GeminiReasoning'),
                hiddenTool('think', 'think'),
                hiddenTool('change-title', 'change_title'),
                hiddenTool('tool-search', 'ToolSearch'),
            ],
            sharedAt: now,
        });

        expect(result.snapshot.messages).toEqual([{
            id: 'message-1', role: 'assistant', createdAt: 1,
            blocks: [{ type: 'tool', name: 'Read', status: 'completed' }],
        }]);
        const serialized = JSON.stringify(result.snapshot);
        for (const prohibited of ['Users', 'workspace', 'private-host', 'internal-model', 'permission_mode', 'secret-token', 'secret-key', 'raw private output', 'hidden input']) {
            expect(serialized).not.toContain(prohibited);
        }
    });

    it('replaces private file refs with deduplicated opaque attachment ids', () => {
        const fileTool = (id: string): Message => ({
            kind: 'tool-call', id, localId: null, createdAt: 1,
            tool: {
                name: 'file', state: 'completed',
                input: {
                    ref: 'sessions/private-session/attachments/photo.enc',
                    localPath: '/Users/private/photo.jpg',
                    name: '../photo.jpg', size: 5, kind: 'image', mimeType: 'image/jpeg', encrypted: true,
                },
                description: 'Attached image', createdAt: 1, startedAt: 1, completedAt: 1,
            },
            children: [],
        });
        let idCalls = 0;
        const result = buildPublicSessionSnapshot({
            title: 'Files', messages: [fileTool('f1'), fileTool('f2')], sharedAt: now,
            createAttachmentId: () => { idCalls += 1; return '11111111-1111-4111-8111-111111111111'; },
        });

        expect(idCalls).toBe(1);
        expect(result.attachments).toEqual([{
            attachmentId: '11111111-1111-4111-8111-111111111111',
            sourceRef: 'sessions/private-session/attachments/photo.enc',
            encrypted: true,
            kind: 'image', name: 'photo.jpg', mimeType: 'image/jpeg', size: 5,
        }]);
        expect(result.snapshot.messages[0].blocks[0]).toEqual({
            type: 'attachment', attachmentId: '11111111-1111-4111-8111-111111111111',
            kind: 'image', name: 'photo.jpg', mimeType: 'image/jpeg', size: 5,
        });
        const serialized = JSON.stringify(result.snapshot);
        expect(serialized).not.toContain('private-session');
        expect(serialized).not.toContain('/Users/private');
    });

    it('preserves attachment lane metadata for plaintext media and ordinary files', () => {
        const messages: Message[] = [
            {
                kind: 'tool-call', id: 'video', localId: null, createdAt: 1,
                tool: {
                    name: 'file', state: 'completed', input: {
                        ref: 'sessions/s/attachments/movie.mp4', name: 'movie.mp4', size: 10,
                        kind: 'video', mimeType: 'video/mp4', encrypted: false,
                    },
                    description: null, createdAt: 1, startedAt: 1, completedAt: 1,
                }, children: [],
            },
            {
                kind: 'tool-call', id: 'document', localId: null, createdAt: 2,
                tool: {
                    name: 'file', state: 'completed', input: {
                        ref: 'sessions/s/attachments/report.enc', name: 'report.pdf', size: 20,
                        kind: 'file', mimeType: 'application/pdf', encrypted: true,
                    },
                    description: null, createdAt: 2, startedAt: 2, completedAt: 2,
                }, children: [],
            },
        ];
        const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
        const result = buildPublicSessionSnapshot({ title: 'Media', messages, sharedAt: now, createAttachmentId: () => ids.shift()! });

        expect(result.attachments.map(({ kind, mimeType, encrypted }) => ({ kind, mimeType, encrypted }))).toEqual([
            { kind: 'video', mimeType: 'video/mp4', encrypted: false },
            { kind: 'file', mimeType: 'application/pdf', encrypted: true },
        ]);
    });

    it('preserves safe generated-image presentation metadata', () => {
        const message: Message = {
            kind: 'tool-call', id: 'generated-image', localId: null, createdAt: 1,
            tool: {
                name: 'file', state: 'completed', input: {
                    ref: 'sessions/private/attachments/generated.enc',
                    name: 'painting.png',
                    size: 32,
                    kind: 'image',
                    mimeType: 'image/png',
                    encrypted: true,
                    source: 'generated',
                    image: { width: 1536, height: 1024, thumbhash: 'safe-thumbhash' },
                    localPath: '/Users/private/painting.png',
                },
                description: null, createdAt: 1, startedAt: 1, completedAt: 1,
            },
            children: [],
        };

        const result = buildPublicSessionSnapshot({
            title: 'Generated image', messages: [message], sharedAt: now,
            createAttachmentId: () => '11111111-1111-4111-8111-111111111111',
        });

        expect(result.snapshot.messages[0].blocks[0]).toMatchObject({
            type: 'attachment',
            source: 'generated',
            image: { width: 1536, height: 1024, thumbhash: 'safe-thumbhash' },
        });
        expect(JSON.stringify(result.snapshot)).not.toContain('/Users/private');
        expect(JSON.stringify(result.snapshot)).not.toContain('sessions/private');
    });

    it('normalizes cross-platform attachment names without Node path APIs', () => {
        const message: Message = {
            kind: 'tool-call', id: 'audio', localId: null, createdAt: 1,
            tool: {
                name: 'file', state: 'completed', input: {
                    ref: 'sessions/s/attachments/voice.enc', name: 'C:\\Users\\private\\voice.WAV', size: 12,
                    kind: 'audio', encrypted: true,
                },
                description: null, createdAt: 1, startedAt: 1, completedAt: 1,
            }, children: [],
        };

        const result = buildPublicSessionSnapshot({
            title: 'Audio', messages: [message], sharedAt: now,
            createAttachmentId: () => '11111111-1111-4111-8111-111111111111',
        });

        expect(result.attachments[0]).toMatchObject({ name: 'voice.WAV', mimeType: 'audio/wav' });
        expect(JSON.stringify(result.snapshot)).not.toContain('Users');
        expect(JSON.stringify(result.snapshot)).not.toContain('private');
    });
});
