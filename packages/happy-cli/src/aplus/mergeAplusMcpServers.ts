import type { AplusMcpServersMap } from './fetchAplusMcpServers'

export type McpServersMap<T = unknown> = Record<string, T>

export type StdioMcpServerEntry = {
    command: string
    args?: string[]
    env?: Record<string, string>
}

export function mergeAplusMcpServers(
    baseMcpServers: McpServersMap,
    aplusMcpServers: AplusMcpServersMap,
): McpServersMap {
    return {
        ...baseMcpServers,
        ...aplusMcpServers,
    }
}

export function bridgeAplusMcpServers(
    aplusMcpServers: AplusMcpServersMap,
    opts: {
        bridgeCommand: string
        nodeExecPath?: string
    },
): McpServersMap<StdioMcpServerEntry> {
    const result: McpServersMap<StdioMcpServerEntry> = {}
    for (const [name, config] of Object.entries(aplusMcpServers)) {
        const args = opts.nodeExecPath
            ? ['--no-warnings', '--no-deprecation', opts.bridgeCommand, '--url', config.url]
            : ['--url', config.url]
        result[name] = {
            command: opts.nodeExecPath ?? opts.bridgeCommand,
            args,
            env: config.headers ? { HAPPY_HTTP_MCP_HEADERS: JSON.stringify(config.headers) } : undefined,
        }
    }
    return result
}

export function mergeMcpServers<TEntry>(
    baseMcpServers: McpServersMap<TEntry>,
    extraMcpServers: McpServersMap<TEntry>,
): McpServersMap<TEntry> {
    return {
        ...baseMcpServers,
        ...extraMcpServers,
    }
}
