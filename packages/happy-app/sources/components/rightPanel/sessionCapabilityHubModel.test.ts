import { describe, expect, it } from 'vitest';
import type { DecryptedArtifact } from '@/sync/artifactTypes';
import type { Session } from '@/sync/storageTypes';
import type { Message } from '@/sync/typesMessage';
import {
    buildSessionCapabilityHubModel,
    getCapabilityDetailItems,
} from './sessionCapabilityHubModel';
import { getBrowserSteps } from './browserStepsModel';

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        seq: 1,
        createdAt: 1000,
        updatedAt: 5000,
        active: true,
        activeAt: 5000,
        metadata: {
            path: '/Users/jacky/project',
            host: 'macbook',
            skills: ['using-superpowers', 'codex-harness'],
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    };
}

function createArtifact(overrides: Partial<DecryptedArtifact> = {}): DecryptedArtifact {
    return {
        id: 'artifact-1',
        title: 'Capability Hub Draft',
        sessions: ['session-1'],
        draft: false,
        headerVersion: 1,
        bodyVersion: 1,
        seq: 1,
        createdAt: 1000,
        updatedAt: 6000,
        isDecrypted: true,
        ...overrides,
    };
}

function createToolMessage(
    id: string,
    createdAt: number,
    toolName: string,
    input: Record<string, unknown>,
): Message {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt,
        tool: {
            name: toolName,
            state: 'completed',
            input,
            createdAt,
            startedAt: createdAt,
            completedAt: createdAt + 1,
            description: null,
        },
        children: [],
    };
}

describe('sessionCapabilityHubModel', () => {
    it('builds compact block counts from session data', () => {
        const session = createSession();
        const messages: Message[] = [
            createToolMessage('image-1', 2000, 'file', {
                ref: 'blob://1',
                name: 'draft.png',
                source: 'generated',
                image: { width: 1200, height: 800, thumbhash: 'abc' },
            }),
            createToolMessage('edit-1', 3000, 'Write', {
                file_path: '/Users/jacky/project/docs/plan.md',
                content: 'hello',
            }),
        ];
        const artifacts = [
            createArtifact(),
            createArtifact({
                id: 'artifact-2',
                sessions: ['session-2'],
                updatedAt: 7000,
            }),
        ];

        const model = buildSessionCapabilityHubModel({ session, messages, artifacts });

        expect(model.blocks.map((block) => [block.key, block.count])).toEqual([
            ['outputs', 3],
            ['sources', 0],
            ['skills', 2],
            ['quickPrompts', 0],
            ['images', 1],
            ['artifacts', 1],
            ['files', 1],
        ]);
    });

    it('filters artifacts by linked session id and ignores drafts', () => {
        const session = createSession();
        const artifacts = [
            createArtifact({ id: 'artifact-a', sessions: ['session-1'], updatedAt: 4000 }),
            createArtifact({ id: 'artifact-b', sessions: ['session-2'], updatedAt: 8000 }),
            createArtifact({ id: 'artifact-c', sessions: ['session-1'], draft: true, updatedAt: 9000 }),
        ];

        const items = getCapabilityDetailItems('artifacts', { session, messages: [], artifacts });

        expect(items.map((item) => item.id)).toEqual(['artifact-a']);
    });

    it('extracts image attachments newest-first from file tool calls', () => {
        const session = createSession();
        const messages: Message[] = [
            createToolMessage('image-1', 1000, 'file', {
                ref: 'blob://1',
                name: 'first.png',
                image: { width: 800, height: 600 },
            }),
            createToolMessage('image-2', 5000, 'file', {
                ref: 'blob://2',
                name: 'second.png',
                image: { width: 400, height: 300 },
            }),
        ];

        const items = getCapabilityDetailItems('images', { session, messages, artifacts: [] });

        expect(items.map((item) => item.id)).toEqual(['image-2', 'image-1']);
        expect(items[0]).toMatchObject({
            id: 'image-2',
            title: 'second.png',
            ref: 'blob://2',
        });
    });

    it('keeps browser step frames out of the ordinary image gallery', () => {
        const session = createSession();
        const messages: Message[] = [
            createToolMessage('browser-step-1', 1000, 'file', {
                ref: 'blob://browser-step-1',
                name: 'browser-step-001.jpg',
                source: 'browser_step',
                browserStep: { label: '打开订单中心' },
                image: { width: 1280, height: 720 },
            }),
            createToolMessage('generated-image-1', 2000, 'file', {
                ref: 'blob://generated-image-1',
                name: 'generated.png',
                source: 'generated',
                image: { width: 1024, height: 1024 },
            }),
        ];

        const model = buildSessionCapabilityHubModel({ session, messages, artifacts: [] });
        const browserSteps = getBrowserSteps(messages);

        expect(browserSteps).toHaveLength(1);
        expect(browserSteps?.[0]).toMatchObject({
            label: '打开订单中心',
            ref: 'blob://browser-step-1',
        });
        expect(model.details.images.map((item) => item.ref)).toEqual(['blob://generated-image-1']);
    });

    it('preserves generated image source metadata for the gallery entry', () => {
        const session = createSession();
        const messages: Message[] = [
            createToolMessage('image-1', 1000, 'file', {
                ref: 'blob://1',
                name: 'generated.png',
                source: 'generated',
                prompt: 'draw a cat',
                batchId: 'batch-1',
                image: { width: 1024, height: 1024 },
            }),
        ];

        const items = getCapabilityDetailItems('images', { session, messages, artifacts: [] });

        expect(items[0]).toMatchObject({
            title: 'generated.png',
            source: 'generated',
            prompt: 'draw a cat',
            batchId: 'batch-1',
        });
    });

    it('collects touched files from edit-like tools including patch changes', () => {
        const session = createSession();
        const messages: Message[] = [
            createToolMessage('write-1', 2000, 'Write', {
                file_path: '/Users/jacky/project/docs/plan.md',
                content: 'hello',
            }),
            createToolMessage('patch-1', 5000, 'CodexPatch', {
                changes: {
                    'packages/happy-app/sources/app.tsx': {
                        modify: { old_content: 'a', new_content: 'b' },
                    },
                    'packages/happy-app/sources/index.ts': {
                        add: { content: 'export {}' },
                    },
                },
            }),
        ];

        const items = getCapabilityDetailItems('files', { session, messages, artifacts: [] });

        expect(items.map((item) => item.path)).toEqual([
            'packages/happy-app/sources/app.tsx',
            'packages/happy-app/sources/index.ts',
            '/Users/jacky/project/docs/plan.md',
        ]);
    });

    it('partitions task outputs and sources while merging live updates for one resource', () => {
        const session = createSession();
        const messages: Message[] = [
            createToolMessage('write-1', 2000, 'Write', {
                file_path: '/Users/jacky/project/docs/context.md',
                content: 'first',
            }),
            createToolMessage('fetch-1', 3000, 'WebFetch', {
                url: 'https://docs.example.com/reference',
            }),
            createToolMessage('edit-1', 5000, 'Edit', {
                file_path: '/Users/jacky/project/docs/context.md',
                old_string: 'first',
                new_string: 'second',
            }),
        ];

        const model = buildSessionCapabilityHubModel({ session, messages, artifacts: [] });

        expect(model.details.outputs).toHaveLength(1);
        expect(model.details.outputs[0]?.event).toMatchObject({
            kind: 'file_modified',
            path: '/Users/jacky/project/docs/context.md',
            messageId: 'edit-1',
            messageIds: ['write-1', 'edit-1'],
            occurrences: 2,
        });
        expect(model.details.sources).toHaveLength(1);
        expect(model.details.sources[0]?.event).toMatchObject({
            kind: 'source_used',
            resourceType: 'web',
            uri: 'https://docs.example.com/reference',
        });
        expect(model.blocks.find((block) => block.key === 'outputs')).toMatchObject({
            count: 1,
            preview: 'context.md',
            empty: false,
        });
    });

    it('keeps task context isolated to the selected session across session switches', () => {
        const artifacts = [
            createArtifact({ id: 'artifact-a', title: 'Session A preview', sessions: ['session-1'] }),
            createArtifact({ id: 'artifact-b', title: 'Session B preview', sessions: ['session-2'] }),
        ];
        const sessionA = createSession({ id: 'session-1' });
        const sessionB = createSession({ id: 'session-2' });

        const modelA = buildSessionCapabilityHubModel({
            session: sessionA,
            messages: [createToolMessage('fetch-a', 2000, 'WebFetch', { url: 'https://a.example/source' })],
            artifacts,
        });
        const modelB = buildSessionCapabilityHubModel({
            session: sessionB,
            messages: [createToolMessage('fetch-b', 3000, 'WebFetch', { url: 'https://b.example/source' })],
            artifacts,
        });

        expect(modelA.details.outputs.map((item) => item.title)).toEqual(['Session A preview']);
        expect(modelA.details.sources.map((item) => item.event.uri)).toEqual(['https://a.example/source']);
        expect(modelB.details.outputs.map((item) => item.title)).toEqual(['Session B preview']);
        expect(modelB.details.sources.map((item) => item.event.uri)).toEqual(['https://b.example/source']);
    });

    it('treats metadata.skills as available session skills context', () => {
        const session = createSession({
            metadata: {
                path: '/Users/jacky/project',
                host: 'macbook',
                skills: ['using-superpowers', 'codex-harness'],
            },
        });

        const items = getCapabilityDetailItems('skills', { session, messages: [], artifacts: [] });

        expect(items.map((item) => item.title)).toEqual(['using-superpowers', 'codex-harness']);
        expect(items.every((item) => item.meta === 'available')).toBe(true);
    });

    it('does not cap skill count at the detail preview size', () => {
        const skillNames = Array.from({ length: 30 }, (_, index) => `skill-${index + 1}`);
        const model = buildSessionCapabilityHubModel({
            session: createSession(),
            messages: [],
            artifacts: [],
            skillNames,
        });

        expect(model.blocks.find((block) => block.key === 'skills')?.count).toBe(30);
        expect(model.details.skills).toHaveLength(30);
    });

    it('prefers scanned skill names over incomplete session metadata', () => {
        const session = createSession({
            metadata: {
                path: '/Users/jacky/project',
                host: 'macbook',
                skills: ['metadata-only'],
            },
        });

        const items = getCapabilityDetailItems('skills', {
            session,
            messages: [],
            artifacts: [],
            skillNames: ['agent-browser', 'codex-harness', 'using-superpowers'],
        });

        expect(items.map((item) => item.title)).toEqual(['agent-browser', 'codex-harness', 'using-superpowers']);
    });

    it('includes user quick prompts newest-first', () => {
        const items = getCapabilityDetailItems('quickPrompts', {
            session: createSession(),
            messages: [],
            artifacts: [],
            quickPrompts: [
                {
                    id: 'prompt-1',
                    title: 'Older prompt',
                    prompt: 'Summarize the current session.',
                    createdAt: 1000,
                    updatedAt: 1000,
                },
                {
                    id: 'prompt-2',
                    title: 'Newer prompt',
                    prompt: 'Run tests and summarize failures.',
                    createdAt: 2000,
                    updatedAt: 3000,
                },
            ],
        });

        expect(items.map((item) => item.title)).toEqual(['Newer prompt', 'Older prompt']);
        expect(items[0]).toMatchObject({
            id: 'prompt-2',
            kind: 'quickPrompt',
            prompt: 'Run tests and summarize failures.',
        });
    });
});
