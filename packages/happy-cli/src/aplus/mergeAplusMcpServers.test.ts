import { describe, expect, it } from 'vitest'

import {
    bridgeAplusMcpServers,
    mergeAplusMcpServers,
    mergeMcpServers,
    type StdioMcpServerEntry,
} from './mergeAplusMcpServers'

describe('mergeAplusMcpServers', () => {
    it('keeps the agent bridge and appends A+ MCP servers', () => {
        const result = mergeAplusMcpServers(
            {
                happy: {
                    command: '/repo/bin/happy-mcp.mjs',
                    args: ['--url', 'http://127.0.0.1:58164/'],
                },
            },
            {
                'aplus-common': {
                    type: 'http',
                    url: 'http://localhost:5174/mcp/common',
                    headers: { Authorization: 'Bearer token' },
                },
            },
        )

        expect(result).toEqual({
            happy: {
                command: '/repo/bin/happy-mcp.mjs',
                args: ['--url', 'http://127.0.0.1:58164/'],
            },
            'aplus-common': {
                type: 'http',
                url: 'http://localhost:5174/mcp/common',
                headers: { Authorization: 'Bearer token' },
            },
        })
    })

    it('converts A+ HTTP MCP servers into stdio bridge entries for command-only agents', () => {
        const result = bridgeAplusMcpServers(
            {
                'aplus-common': {
                    type: 'http',
                    url: 'http://localhost:5174/mcp/common',
                    headers: { Authorization: 'Bearer token' },
                },
            },
            {
                bridgeCommand: '/repo/bin/happy-mcp.mjs',
                nodeExecPath: '/usr/local/bin/node',
            },
        )

        expect(result).toEqual({
            'aplus-common': {
                command: '/usr/local/bin/node',
                args: [
                    '--no-warnings',
                    '--no-deprecation',
                    '/repo/bin/happy-mcp.mjs',
                    '--url',
                    'http://localhost:5174/mcp/common',
                ],
                env: {
                    HAPPY_HTTP_MCP_HEADERS: JSON.stringify({ Authorization: 'Bearer token' }),
                },
            },
        })
    })

    it('merges stdio MCP entries while preserving the base entry type', () => {
        const result = mergeMcpServers<StdioMcpServerEntry>(
            {
                happy: {
                    command: '/repo/bin/happy-mcp.mjs',
                    args: ['--url', 'http://127.0.0.1:58164/'],
                },
            },
            {
                'aplus-common': {
                    command: '/repo/bin/happy-mcp.mjs',
                    args: ['--url', 'http://localhost:5174/mcp/common'],
                },
            },
        )

        expect(result['aplus-common'].command).toBe('/repo/bin/happy-mcp.mjs')
    })
})
