import { describe, expect, it } from 'vitest';

import { isLiteralMcpAppSandboxRequestUrl } from './mcpAppSandboxHttp';

describe('literal MCP App sandbox request URL boundary', () => {
    it.each([
        '/mcp-app-sandbox',
        '/mcp-app-sandbox?parentOrigin=secret',
        '/mcp-app-sandbox/',
        '/mcp-app-sandbox/%zz?parentOrigin=secret',
    ])('matches %s without decoding or normalization', (rawUrl) => {
        expect(isLiteralMcpAppSandboxRequestUrl(rawUrl)).toBe(true);
    });

    it.each([
        undefined,
        '',
        '/mcp-app-sandbox-evil/%zz',
        '/mcp-app-sandbox%2F%zz',
        '/unrelated/mcp-app-sandbox/%zz',
    ])('does not match %s', (rawUrl) => {
        expect(isLiteralMcpAppSandboxRequestUrl(rawUrl)).toBe(false);
    });
});
