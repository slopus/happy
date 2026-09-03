import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { Readable } from 'node:stream';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { buildMcpAppFixtureHtml } from './build.js';
import type {
    DeploymentPlannerOutput,
    IncidentBoardOutput,
    ServiceCatalogOutput,
} from './src/viewModel.js';

const RESOURCE_URI = 'ui://paws-release-readiness/app.html';
const SERVICE_CATALOG_RESOURCE_URI = 'ui://paws-service-catalog/app.html';
const INCIDENT_BOARD_RESOURCE_URI = 'ui://paws-incident-board/app.html';
const DEPLOYMENT_PLANNER_RESOURCE_URI = 'ui://paws-deployment-planner/app.html';
const APP_RESOURCE_URIS = [
    RESOURCE_URI,
    SERVICE_CATALOG_RESOURCE_URI,
    INCIDENT_BOARD_RESOURCE_URI,
    DEPLOYMENT_PLANNER_RESOURCE_URI,
] as const;

const checkSchema = z.object({
    name: z.string().min(1),
    passed: z.boolean(),
});

const outputSchema = z.object({
    releaseName: z.string(),
    passed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    percent: z.number().int().min(0).max(100),
    status: z.enum(['ready', 'needs-attention']),
    checks: z.array(checkSchema),
});

type ReadinessOutput = z.infer<typeof outputSchema>;

const serviceSchema = z.object({
    id: z.string(),
    name: z.string(),
    status: z.enum(['healthy', 'degraded', 'maintenance']),
    region: z.string(),
    latencyMs: z.number().int().nonnegative(),
    version: z.string(),
    owner: z.string(),
});

const serviceCatalogOutputSchema = z.object({
    kind: z.literal('service-catalog'),
    title: z.string(),
    services: z.array(serviceSchema),
});

const incidentSchema = z.object({
    id: z.string(),
    title: z.string(),
    severity: z.enum(['critical', 'warning']),
    service: z.string(),
    ageMinutes: z.number().int().nonnegative(),
    summary: z.string(),
    runbook: z.array(z.string()),
});

const incidentBoardOutputSchema = z.object({
    kind: z.literal('incident-board'),
    title: z.string(),
    incidents: z.array(incidentSchema),
});

const environmentSchema = z.object({
    id: z.string(),
    name: z.string(),
    risk: z.enum(['low', 'elevated']),
});

const deploymentStepSchema = z.object({
    id: z.string(),
    label: z.string(),
    required: z.boolean(),
    selected: z.boolean(),
});

const deploymentPlannerOutputSchema = z.object({
    kind: z.literal('deployment-planner'),
    title: z.string(),
    environments: z.array(environmentSchema),
    steps: z.array(deploymentStepSchema),
});

export type RunningMcpAppFixture = {
    mcpUrl: string;
    close: () => Promise<void>;
};

export async function loadAppHtml(): Promise<string> {
    const html = await buildMcpAppFixtureHtml();
    if (![
        'approve-release-readiness',
        'check-service-health',
        'confirm-incident-runbook',
        'preview-deployment-plan',
    ].every((marker) => html.includes(marker))) {
        throw new Error('MCP App bundle is missing its SDK initialization marker');
    }
    return html;
}

export function createMcpAppServer(html: string): McpServer {
    const server = new McpServer({
        name: 'Paws MCP App Console E2E Fixture',
        version: '1.0.0',
    });

    registerAppTool(server, 'show-release-readiness', {
        title: 'Show Release Readiness',
        description: 'Shows deterministic release-readiness checks in an MCP App.',
        inputSchema: {
            releaseName: z.string().min(1),
            checks: z.array(checkSchema).min(1),
        },
        outputSchema: outputSchema.shape,
        annotations: { readOnlyHint: true },
        _meta: { ui: { resourceUri: RESOURCE_URI } },
    }, async ({ releaseName, checks }): Promise<CallToolResult> => {
        const passed = checks.filter((check) => check.passed).length;
        const total = checks.length;
        const percent = Math.round((passed / total) * 100);
        const structuredContent: ReadinessOutput = {
            releaseName,
            passed,
            total,
            percent,
            status: passed === total ? 'ready' : 'needs-attention',
            checks,
        };

        return {
            content: [{
                type: 'text',
                text: `${releaseName}: ${passed}/${total} checks passed (${percent}%).`,
            }],
            structuredContent,
        };
    });

    registerAppTool(server, 'show-service-catalog', {
        title: 'Show Service Catalog',
        description: 'Shows a filterable horizontal service collection in an MCP App.',
        inputSchema: {},
        outputSchema: serviceCatalogOutputSchema.shape,
        annotations: { readOnlyHint: true },
        _meta: { ui: { resourceUri: SERVICE_CATALOG_RESOURCE_URI } },
    }, async (): Promise<CallToolResult> => {
        const structuredContent: ServiceCatalogOutput = {
            kind: 'service-catalog',
            title: 'Production service catalog',
            services: [
                { id: 'gateway', name: 'Gateway API', status: 'healthy', region: 'Singapore', latencyMs: 82, version: 'v4.12.0', owner: 'Edge' },
                { id: 'sync', name: 'Sync Engine', status: 'degraded', region: 'Frankfurt', latencyMs: 241, version: 'v3.8.2', owner: 'Realtime' },
                { id: 'media', name: 'Media Pipeline', status: 'maintenance', region: 'Virginia', latencyMs: 134, version: 'v2.6.1', owner: 'Media' },
                { id: 'search', name: 'Search Index', status: 'healthy', region: 'Tokyo', latencyMs: 96, version: 'v5.4.0', owner: 'Discovery' },
                { id: 'analytics', name: 'Analytics Stream', status: 'degraded', region: 'Sydney', latencyMs: 286, version: 'v1.18.3', owner: 'Insights' },
                { id: 'billing', name: 'Billing Worker', status: 'healthy', region: 'Oregon', latencyMs: 71, version: 'v7.2.4', owner: 'Commerce' },
            ],
        };
        return {
            content: [{ type: 'text', text: 'Production service catalog: 6 services, 2 need attention.' }],
            structuredContent,
        };
    });

    registerAppTool(server, 'show-incident-board', {
        title: 'Show Incident Board',
        description: 'Shows a filterable incident response workflow in an MCP App.',
        inputSchema: {},
        outputSchema: incidentBoardOutputSchema.shape,
        annotations: { readOnlyHint: true },
        _meta: { ui: { resourceUri: INCIDENT_BOARD_RESOURCE_URI } },
    }, async (): Promise<CallToolResult> => {
        const structuredContent: IncidentBoardOutput = {
            kind: 'incident-board',
            title: 'Live incident command',
            incidents: [
                { id: 'inc-1042', title: 'Webhook delivery delays', severity: 'critical', service: 'Gateway API', ageMinutes: 18, summary: 'Queue depth exceeded the alert threshold.', runbook: ['Freeze deploys', 'Drain backlog'] },
                { id: 'inc-1041', title: 'Search replica lag', severity: 'warning', service: 'Search', ageMinutes: 43, summary: 'One replica is catching up.', runbook: ['Inspect replica', 'Rebalance reads'] },
                { id: 'inc-1039', title: 'Analytics ingest retries', severity: 'warning', service: 'Analytics Stream', ageMinutes: 67, summary: 'Retry volume increased after a downstream timeout.', runbook: ['Confirm downstream health', 'Reduce batch size'] },
            ],
        };
        return {
            content: [{ type: 'text', text: 'Live incident command: 3 active incidents, 1 critical.' }],
            structuredContent,
        };
    });

    registerAppTool(server, 'show-deployment-planner', {
        title: 'Show Deployment Planner',
        description: 'Shows an interactive multi-step deployment planner in an MCP App.',
        inputSchema: {},
        outputSchema: deploymentPlannerOutputSchema.shape,
        annotations: { readOnlyHint: true },
        _meta: { ui: { resourceUri: DEPLOYMENT_PLANNER_RESOURCE_URI } },
    }, async (): Promise<CallToolResult> => {
        const structuredContent: DeploymentPlannerOutput = {
            kind: 'deployment-planner',
            title: 'Progressive delivery plan',
            environments: [
                { id: 'preview', name: 'Preview', risk: 'low' },
                { id: 'production', name: 'Production', risk: 'elevated' },
            ],
            steps: [
                { id: 'tests', label: 'Verify automated checks', required: true, selected: true },
                { id: 'canary', label: 'Run a 10% canary', required: true, selected: true },
                { id: 'notify', label: 'Notify release channel', required: false, selected: false },
            ],
        };
        return {
            content: [{ type: 'text', text: 'Progressive delivery plan: Preview selected with 2 steps.' }],
            structuredContent,
        };
    });

    for (const uri of APP_RESOURCE_URIS) {
        registerAppResource(server, uri, uri, {
            mimeType: RESOURCE_MIME_TYPE,
        }, async (): Promise<ReadResourceResult> => ({
            contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html }],
        }));
    }

    server.registerTool('approve-release-readiness', {
        title: 'Approve Release Readiness',
        description: 'Returns a deterministic mediated action result for Host E2E.',
        inputSchema: { releaseName: z.string().min(1) },
        outputSchema: { approval: z.literal('approved'), releaseName: z.string() },
        annotations: { readOnlyHint: true },
    }, async ({ releaseName }): Promise<CallToolResult> => ({
        content: [{ type: 'text', text: `Approved ${releaseName}.` }],
        structuredContent: { approval: 'approved', releaseName },
    }));

    server.registerTool('check-service-health', {
        title: 'Check Service Health',
        description: 'Returns a deterministic service health verification for Host E2E.',
        inputSchema: { serviceId: z.string().min(1) },
        outputSchema: {
            serviceId: z.string(),
            check: z.literal('passed'),
            checkedAt: z.string(),
        },
        annotations: { readOnlyHint: true },
    }, async ({ serviceId }): Promise<CallToolResult> => ({
        content: [{ type: 'text', text: `Health verification passed for ${serviceId}.` }],
        structuredContent: { serviceId, check: 'passed', checkedAt: '2026-09-03T08:00:00.000Z' },
    }));

    server.registerTool('confirm-incident-runbook', {
        title: 'Confirm Incident Runbook',
        description: 'Returns a deterministic runbook confirmation for Host E2E.',
        inputSchema: { incidentId: z.string().min(1) },
        outputSchema: {
            incidentId: z.string(),
            confirmation: z.literal('confirmed'),
            owner: z.string(),
        },
        annotations: { readOnlyHint: true },
    }, async ({ incidentId }): Promise<CallToolResult> => ({
        content: [{ type: 'text', text: `Runbook confirmed for ${incidentId}.` }],
        structuredContent: { incidentId, confirmation: 'confirmed', owner: 'On-call SRE' },
    }));

    server.registerTool('preview-deployment-plan', {
        title: 'Preview Deployment Plan',
        description: 'Returns a deterministic deployment preview for Host E2E.',
        inputSchema: {
            environmentId: z.string().min(1),
            stepIds: z.array(z.string().min(1)).min(1),
        },
        outputSchema: {
            environmentId: z.string(),
            planId: z.string(),
            status: z.literal('ready'),
            stepCount: z.number().int().positive(),
        },
        annotations: { readOnlyHint: true },
    }, async ({ environmentId, stepIds }): Promise<CallToolResult> => ({
        content: [{ type: 'text', text: `Deployment preview ready for ${environmentId}.` }],
        structuredContent: {
            environmentId,
            planId: `plan-${environmentId}-${stepIds.length}`,
            status: 'ready',
            stepCount: stepIds.length,
        },
    }));

    return server;
}

export async function startMcpAppFixture(options: { port: number }): Promise<RunningMcpAppFixture> {
    const html = await loadAppHtml();
    const httpServer = createHttpServer(async (request, response) => {
        const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (requestUrl.pathname !== '/mcp') {
            response.writeHead(404, { 'content-type': 'application/json' });
            response.end('{"error":"Not found"}');
            return;
        }
        const mcpServer = createMcpAppServer(html);
        const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });

        try {
            await mcpServer.connect(transport);
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const requestHeaders = new Headers();
            for (const [name, value] of Object.entries(request.headers)) {
                if (value !== undefined) requestHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
            }
            const webRequest = new Request(`http://127.0.0.1${request.url ?? '/mcp'}`, {
                method: request.method,
                headers: requestHeaders,
                body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
            });
            const webResponse = await transport.handleRequest(webRequest);
            response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
            if (webResponse.body) Readable.fromWeb(webResponse.body as never).pipe(response);
            else response.end();
        } catch {
            if (!response.headersSent) {
                response.writeHead(500, { 'content-type': 'application/json' });
                response.end(JSON.stringify({
                    jsonrpc: '2.0',
                    error: { code: -32603, message: 'Internal server error' },
                    id: null,
                }));
            }
        } finally {
            response.once('close', () => {
                void transport.close();
                void mcpServer.close();
            });
        }
    });
    await listen(httpServer, options.port);
    const address = httpServer.address();
    if (!address || typeof address === 'string') {
        await closeServer(httpServer);
        throw new Error('MCP App fixture did not expose a TCP address');
    }

    return {
        mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
        close: () => closeServer(httpServer),
    };
}

function listen(server: HttpServer, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
}

function closeServer(server: HttpServer): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}
