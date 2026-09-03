import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { dirname } from 'node:path';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { startMcpAppFixture, type RunningMcpAppFixture } from './server.js';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));

function expectBundledMcpAppResource(
    resource: Awaited<ReturnType<Client['readResource']>>,
    expectedUri = 'ui://paws-release-readiness/app.html',
): void {
    expect(resource.contents).toHaveLength(1);
    expect(resource.contents[0]).toMatchObject({
        uri: expectedUri,
        mimeType: 'text/html;profile=mcp-app',
    });
    expect(resource.contents[0]).toHaveProperty('text');
    const html = resource.contents[0] && 'text' in resource.contents[0]
        ? resource.contents[0].text
        : '';
    expect(html).toContain('mcp-example-root');
    expect(html).toContain('Paws Release Readiness');
    expect(html).toContain('approve-release-readiness');
    const script = /<script>([\s\S]+)<\/script>/u.exec(html)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Script(script!, { filename: 'mcp-app-fixture.js' })).not.toThrow();
}

describe('local MCP App fixture contract', () => {
    let fixture: RunningMcpAppFixture | undefined;
    let client: Client | undefined;

    afterEach(async () => {
        await client?.close();
        client = undefined;
        await fixture?.close();
        fixture = undefined;
    });

    it('exposes a UI resource and preserves structured tool output over real HTTP MCP', async () => {
        fixture = await startMcpAppFixture({ port: 0 });
        client = new Client({ name: 'paws-console-e2e', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(fixture.mcpUrl)));

        const tools = await client.listTools();
        const tool = tools.tools.find((candidate) => candidate.name === 'show-release-readiness');

        expect(tool).toMatchObject({
            name: 'show-release-readiness',
            title: 'Show Release Readiness',
            _meta: {
                ui: { resourceUri: 'ui://paws-release-readiness/app.html' },
            },
        });

        const resource = await client.readResource({ uri: 'ui://paws-release-readiness/app.html' });
        expectBundledMcpAppResource(resource);

        const result = await client.callTool({
            name: 'show-release-readiness',
            arguments: {
                releaseName: 'Paws MCP Apps PR 1',
                checks: [
                    { name: 'Protocol metadata preserved', passed: true },
                    { name: 'Structured content preserved', passed: true },
                    { name: 'UI resource reachable', passed: true },
                    { name: 'Happy Web host available', passed: false },
                ],
            },
        });

        expect(result).toMatchObject({
            content: [{ type: 'text', text: 'Paws MCP Apps PR 1: 3/4 checks passed (75%).' }],
            structuredContent: {
                releaseName: 'Paws MCP Apps PR 1',
                passed: 3,
                total: 4,
                percent: 75,
                status: 'needs-attention',
                checks: [
                    { name: 'Protocol metadata preserved', passed: true },
                    { name: 'Structured content preserved', passed: true },
                    { name: 'UI resource reachable', passed: true },
                    { name: 'Happy Web host available', passed: false },
                ],
            },
        });

        const approval = await client.callTool({
            name: 'approve-release-readiness',
            arguments: { releaseName: 'Paws MCP Apps PR 1' },
        });
        expect(approval).toMatchObject({ structuredContent: {
            approval: 'approved', releaseName: 'Paws MCP Apps PR 1',
        } });
    });

    it('serves the same bundled MCP App over stdio', async () => {
        client = new Client({ name: 'paws-console-stdio-e2e', version: '1.0.0' });
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: ['--import', 'tsx', 'main.ts', '--stdio'],
            cwd: fixtureDirectory,
            stderr: 'pipe',
        });
        await client.connect(transport);

        const resource = await client.readResource({ uri: 'ui://paws-release-readiness/app.html' });
        expectBundledMcpAppResource(resource);
    });

    it('exposes three complex App tools with independent UI resources', async () => {
        fixture = await startMcpAppFixture({ port: 0 });
        client = new Client({ name: 'paws-complex-apps-e2e', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(fixture.mcpUrl)));

        const tools = await client.listTools();
        expect(tools.tools).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'show-service-catalog',
                _meta: expect.objectContaining({ ui: { resourceUri: 'ui://paws-service-catalog/app.html' } }),
            }),
            expect.objectContaining({
                name: 'show-incident-board',
                _meta: expect.objectContaining({ ui: { resourceUri: 'ui://paws-incident-board/app.html' } }),
            }),
            expect.objectContaining({
                name: 'show-deployment-planner',
                _meta: expect.objectContaining({ ui: { resourceUri: 'ui://paws-deployment-planner/app.html' } }),
            }),
        ]));

        for (const uri of [
            'ui://paws-service-catalog/app.html',
            'ui://paws-incident-board/app.html',
            'ui://paws-deployment-planner/app.html',
        ]) {
            expectBundledMcpAppResource(await client.readResource({ uri }), uri);
        }
    });

    it('returns deterministic horizontal service catalog content and health-check feedback', async () => {
        fixture = await startMcpAppFixture({ port: 0 });
        client = new Client({ name: 'paws-service-catalog-e2e', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(fixture.mcpUrl)));

        const result = await client.callTool({ name: 'show-service-catalog', arguments: {} });
        expect(result).toMatchObject({
            structuredContent: {
                kind: 'service-catalog',
                title: 'Production service catalog',
                services: expect.arrayContaining([
                    expect.objectContaining({ id: 'gateway', name: 'Gateway API', status: 'healthy', region: 'Singapore', latencyMs: 82 }),
                    expect.objectContaining({ id: 'sync', name: 'Sync Engine', status: 'degraded', region: 'Frankfurt', latencyMs: 241 }),
                ]),
            },
        });

        const health = await client.callTool({
            name: 'check-service-health',
            arguments: { serviceId: 'sync' },
        });
        expect(health).toMatchObject({ structuredContent: {
            serviceId: 'sync', check: 'passed', checkedAt: '2026-09-03T08:00:00.000Z',
        } });
    });

    it('returns deterministic incident workflow content and confirmation feedback', async () => {
        fixture = await startMcpAppFixture({ port: 0 });
        client = new Client({ name: 'paws-incident-board-e2e', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(fixture.mcpUrl)));

        const result = await client.callTool({ name: 'show-incident-board', arguments: {} });
        expect(result).toMatchObject({
            structuredContent: {
                kind: 'incident-board',
                title: 'Live incident command',
                incidents: expect.arrayContaining([
                    expect.objectContaining({ id: 'inc-1042', severity: 'critical', service: 'Gateway API', runbook: ['Freeze deploys', 'Drain backlog'] }),
                    expect.objectContaining({ id: 'inc-1041', severity: 'warning', service: 'Search' }),
                ]),
            },
        });

        const confirmation = await client.callTool({
            name: 'confirm-incident-runbook',
            arguments: { incidentId: 'inc-1042' },
        });
        expect(confirmation).toMatchObject({ structuredContent: {
            incidentId: 'inc-1042', confirmation: 'confirmed', owner: 'On-call SRE',
        } });
    });

    it('returns a deterministic deployment plan and mediated preview result', async () => {
        fixture = await startMcpAppFixture({ port: 0 });
        client = new Client({ name: 'paws-deployment-planner-e2e', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(fixture.mcpUrl)));

        const result = await client.callTool({ name: 'show-deployment-planner', arguments: {} });
        expect(result).toMatchObject({
            structuredContent: {
                kind: 'deployment-planner',
                title: 'Progressive delivery plan',
                environments: [
                    { id: 'preview', name: 'Preview', risk: 'low' },
                    { id: 'production', name: 'Production', risk: 'elevated' },
                ],
                steps: [
                    { id: 'tests', required: true, selected: true },
                    { id: 'canary', required: true, selected: true },
                    { id: 'notify', required: false, selected: false },
                ],
            },
        });

        const preview = await client.callTool({
            name: 'preview-deployment-plan',
            arguments: { environmentId: 'production', stepIds: ['tests', 'canary', 'notify'] },
        });
        expect(preview).toMatchObject({ structuredContent: {
            environmentId: 'production', planId: 'plan-production-3', status: 'ready', stepCount: 3,
        } });
    });
});
