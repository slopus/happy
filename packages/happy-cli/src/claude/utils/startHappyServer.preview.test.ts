import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ApiSessionClient } from '@/api/apiSession';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHappyServer } from './startHappyServer';

vi.mock('@/previews/cloudflarePreview', () => ({
    startCloudflarePreview: vi.fn(async (workspace, onExpired) => {
        const preview = {
            version: 1, id: workspace.manifest.previewId, title: workspace.manifest.title,
            provider: 'cloudflare', mode: 'tunnel', state: 'ready',
            url: `https://${workspace.manifest.previewId}.trycloudflare.com`,
            publishedAt: 100, expiresAt: 200,
        } as const;
        return { preview, stop: () => onExpired({ ...preview, state: 'expired', url: undefined, expiresAt: 150 }) };
    }),
}));

type RunningSession = { client: Client; server: Awaited<ReturnType<typeof startHappyServer>>; events: unknown[] };
const sessions: RunningSession[] = [];

async function session(id: string): Promise<RunningSession> {
    const events: unknown[] = [];
    const fake = {
        sessionId: id,
        reportInteractivePreview: (event: unknown) => events.push(event),
        once: vi.fn(),
        removeListener: vi.fn(),
    } as unknown as ApiSessionClient;
    const server = await startHappyServer(fake);
    const client = new Client({ name: 'preview-slot-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    const running = { client, server, events };
    sessions.push(running);
    return running;
}

async function call(running: RunningSession, name: string, args: Record<string, unknown> = {}) {
    const result = await running.client.callTool({ name, arguments: args }) as CallToolResult;
    const text = result.content.find((item) => item.type === 'text');
    return { error: result.isError === true, text: text?.type === 'text' ? text.text : '' };
}

async function createAndPublish(running: RunningSession, title: string) {
    const created = JSON.parse((await call(running, 'create_preview', { title })).text) as { previewId: string; workspacePath: string };
    await writeFile(join(created.workspacePath, 'index.html'), '<h1>Public demo</h1>');
    const published = await call(running, 'publish_preview', { previewId: created.previewId });
    return { ...created, published };
}

afterEach(async () => {
    for (const running of sessions.splice(0)) {
        await running.client.close();
        running.server.stop();
    }
});

describe('session preview MCP tools', () => {
    it('lists capacity, closes only this session’s live tunnel, and allows another publication', async () => {
        const firstSession = await session('session-a');
        const secondSession = await session('session-b');
        const first = await createAndPublish(firstSession, 'First');
        expect(first.published.error).toBe(false);
        expect((await createAndPublish(firstSession, 'Second')).published.error).toBe(false);
        expect((await createAndPublish(firstSession, 'Third')).published.error).toBe(false);

        const full = JSON.parse((await call(firstSession, 'list_previews')).text);
        expect(full).toMatchObject({ limit: 3, used: 3, remaining: 0 });
        expect(full.previews).toHaveLength(3);
        expect((await createAndPublish(firstSession, 'Fourth')).published).toMatchObject({ error: true, text: expect.stringContaining('3/3') });

        expect(await call(secondSession, 'close_preview', { previewId: first.previewId })).toMatchObject({ error: true });
        expect(JSON.parse((await call(firstSession, 'list_previews')).text).used).toBe(3);
        const closed = await call(firstSession, 'close_preview', { previewId: first.previewId });
        expect(JSON.parse(closed.text)).toMatchObject({ closed: first.previewId, used: 2, remaining: 1 });
        expect(firstSession.events).toContainEqual(expect.objectContaining({ id: first.previewId, state: 'expired', url: undefined }));
        expect(await call(firstSession, 'close_preview', { previewId: first.previewId })).toMatchObject({ error: true });

        const replacement = await createAndPublish(firstSession, 'Replacement');
        expect(replacement.published.error).toBe(false);
        expect(JSON.parse((await call(firstSession, 'list_previews')).text)).toMatchObject({ used: 3, remaining: 0 });
    });
});
