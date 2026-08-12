import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSdkQuery = vi.hoisted(() => vi.fn(() => ({ mocked: true })));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
    query: mockSdkQuery,
}));

vi.mock('./happyEntrypoint', () => ({
    resolveHappyEntrypoint: vi.fn(() => 'happy-cli'),
}));

vi.mock('../utils/proxyBypass', () => ({
    ensureLocalProxyBypass: vi.fn(),
}));

import { query } from './query';

describe('Claude SDK query isolation', () => {
    beforeEach(() => {
        mockSdkQuery.mockClear();
    });

    it('disables filesystem settings and ambient MCP discovery', () => {
        const mcpServers = {
            happy: { type: 'http', url: 'http://127.0.0.1:1234' },
        };

        query({
            prompt: 'hello',
            options: {
                cwd: '/tmp/untrusted-repository',
                settingsPath: '/tmp/happy-hook-settings.json',
                mcpServers,
            },
        });

        expect(mockSdkQuery).toHaveBeenCalledWith({
            prompt: 'hello',
            options: expect.objectContaining({
                cwd: '/tmp/untrusted-repository',
                settings: '/tmp/happy-hook-settings.json',
                mcpServers,
                settingSources: [],
                strictMcpConfig: true,
            }),
        });
    });

    it('keeps strict isolation when Happy has no explicit MCP servers', () => {
        query({ prompt: 'hello', options: { cwd: '/tmp/untrusted-repository' } });

        expect(mockSdkQuery).toHaveBeenCalledWith({
            prompt: 'hello',
            options: expect.objectContaining({
                settingSources: [],
                strictMcpConfig: true,
            }),
        });
    });
});
