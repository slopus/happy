import { describe, expect, it, vi } from 'vitest';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { BROWSER_STEP_TOOL_DESCRIPTION } from '@/browser/browserStepReportingPrompt';
import {
    HAPPY_MCP_BRIDGE_TOOL_NAMES,
    registerHappyBridgeTools,
} from './happyMcpBridgeTools';

type ToolRegistration = {
    name: string;
    config: {
        description?: string;
        title?: string;
        inputSchema?: Record<string, unknown>;
    };
    handler: (args: Record<string, unknown>) => Promise<unknown>;
};

function createServerMock(): { server: McpServer; registrations: ToolRegistration[] } {
    const registrations: ToolRegistration[] = [];
    const server = {
        registerTool: vi.fn((
            name: string,
            config: ToolRegistration['config'],
            handler: ToolRegistration['handler']
        ) => {
            registrations.push({ name, config, handler });
        }),
    };

    return { server: server as unknown as McpServer, registrations };
}

describe('registerHappyBridgeTools', () => {
    it('registers every first-party Happy bridge tool, including media delivery and finance_chart', () => {
        const { server, registrations } = createServerMock();

        registerHappyBridgeTools(server, async () => ({}) as Client);

        expect(registrations.map((registration) => registration.name)).toEqual([...HAPPY_MCP_BRIDGE_TOOL_NAMES]);
        expect(HAPPY_MCP_BRIDGE_TOOL_NAMES).toContain('finance_chart');
        expect(registrations.find((registration) => registration.name === 'send_image')?.config).toMatchObject({
            title: 'Send Image To Chat',
        });
        expect(registrations.find((registration) => registration.name === 'send_image')?.config.description)
            .toContain('current chat');
        expect(registrations.find((registration) => registration.name === 'send_image')?.config.inputSchema)
            .toHaveProperty('path');
        expect(registrations.find((registration) => registration.name === 'send_image')?.config.inputSchema)
            .toHaveProperty('prompt');
        expect(registrations.find((registration) => registration.name === 'send_file')?.config).toMatchObject({
            title: 'Send File To Chat',
        });
        expect(registrations.find((registration) => registration.name === 'send_file')?.config.inputSchema)
            .toHaveProperty('path');
        expect(registrations.find((registration) => registration.name === 'finance_chart')?.config).toMatchObject({
            title: 'Fetch Finance Chart',
        });
        expect(registrations.find((registration) => registration.name === 'finance_chart')?.config.inputSchema)
            .toHaveProperty('query');
    });

    it('forwards send_file calls to the per-session HTTP MCP server', async () => {
        const { server, registrations } = createServerMock();
        const callTool = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok send_file' }], isError: false }));
        registerHappyBridgeTools(server, async () => ({ callTool }) as unknown as Client);

        const sendFile = registrations.find((registration) => registration.name === 'send_file');
        const result = await sendFile?.handler({ path: '/tmp/acceptance.mp4', mimeType: 'video/mp4' });

        expect(callTool).toHaveBeenCalledWith({
            name: 'send_file',
            arguments: { path: '/tmp/acceptance.mp4', mimeType: 'video/mp4' },
        });
        expect(result).toMatchObject({ content: [{ type: 'text', text: 'ok send_file' }], isError: false });
    });

    it('forwards send_image calls to the HTTP MCP client', async () => {
        const { server, registrations } = createServerMock();
        const callTool = vi.fn(async (params: { name: string; arguments?: Record<string, unknown> }) => ({
            content: [{ type: 'text' as const, text: `ok ${params.name}` }],
            isError: false,
        }));

        registerHappyBridgeTools(server, async () => ({ callTool }) as unknown as Client);

        const sendImage = registrations.find((registration) => registration.name === 'send_image');
        expect(sendImage).toBeDefined();

        const result = await sendImage?.handler({ path: '/tmp/render.png', prompt: 'draw a cat', batchId: 'batch-1' });

        expect(callTool).toHaveBeenCalledWith({
            name: 'send_image',
            arguments: { path: '/tmp/render.png', prompt: 'draw a cat', batchId: 'batch-1' },
        });
        expect(result).toMatchObject({
            content: [{ type: 'text', text: 'ok send_image' }],
            isError: false,
        });
    });

    it('forwards browser step screenshots without using the chat image tool', async () => {
        const { server, registrations } = createServerMock();
        const callTool = vi.fn(async (params: { name: string; arguments?: Record<string, unknown> }) => ({
            content: [{ type: 'text' as const, text: `ok ${params.name}` }],
            isError: false,
        }));
        registerHappyBridgeTools(server, async () => ({ callTool }) as unknown as Client);

        expect(HAPPY_MCP_BRIDGE_TOOL_NAMES).toContain('report_browser_step');
        const reportBrowserStep = registrations.find((registration) => registration.name === 'report_browser_step');
        expect(reportBrowserStep).toBeDefined();
        expect(reportBrowserStep?.config.description).toBe(BROWSER_STEP_TOOL_DESCRIPTION);

        const result = await reportBrowserStep?.handler({
            path: '/tmp/ego-step.png',
            label: '已打开订单详情',
        });

        expect(callTool).toHaveBeenCalledWith({
            name: 'report_browser_step',
            arguments: { path: '/tmp/ego-step.png', label: '已打开订单详情' },
        });
        expect(result).toMatchObject({
            content: [{ type: 'text', text: 'ok report_browser_step' }],
            isError: false,
        });
    });

    it('forwards finance_chart calls to the HTTP MCP client', async () => {
        const { server, registrations } = createServerMock();
        const callTool = vi.fn(async (params: { name: string; arguments?: Record<string, unknown> }) => ({
            content: [{ type: 'text' as const, text: `ok ${params.name}` }],
            isError: false,
        }));

        registerHappyBridgeTools(server, async () => ({ callTool }) as unknown as Client);

        const financeChart = registrations.find((registration) => registration.name === 'finance_chart');
        expect(financeChart).toBeDefined();

        const result = await financeChart?.handler({ query: '上证指数', range: '1mo' });

        expect(callTool).toHaveBeenCalledWith({
            name: 'finance_chart',
            arguments: { query: '上证指数', range: '1mo' },
        });
        expect(result).toMatchObject({
            content: [{ type: 'text', text: 'ok finance_chart' }],
            isError: false,
        });
    });

    it('returns an MCP error result when forwarding fails', async () => {
        const { server, registrations } = createServerMock();

        registerHappyBridgeTools(server, async () => {
            throw new Error('HTTP MCP unavailable');
        });

        const sendImage = registrations.find((registration) => registration.name === 'send_image');
        expect(sendImage).toBeDefined();

        const result = await sendImage?.handler({ path: '/tmp/render.png' });

        expect(result).toMatchObject({
            content: [{ type: 'text', text: 'Failed to send image: HTTP MCP unavailable' }],
            isError: true,
        });
    });
});
