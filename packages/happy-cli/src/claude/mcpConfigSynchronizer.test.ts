import { describe, expect, it, vi } from 'vitest';
import { McpConfigSynchronizer } from './mcpConfigSynchronizer';
import type { McpConfigMeasure } from './mcpConfigSynchronizer';

it('measures fetch substeps and changed apply without changing identical-config skip', async () => {
    const stages: string[] = [];
    const measure: McpConfigMeasure = async (stage, action) => { stages.push(stage); return action(); };
    const setMcpServers = vi.fn().mockResolvedValue({ added: [], removed: [], errors: {} });
    const synchronizer = new McpConfigSynchronizer({ setMcpServers }, {
        baseServers: {}, initialAplusServers: {},
        fetchAplusServers: async (observe) => {
            await observe!('mcp-grant', async () => undefined);
            return observe!('mcp-fetch', async () => ({ ok: true as const, servers: { svc: { type: 'http' as const, url: 'https://example.com/mcp' } } }));
        },
    });
    await synchronizer.sync(measure); await synchronizer.sync(measure);
    expect(stages).toEqual(['mcp-grant', 'mcp-fetch', 'mcp-compare', 'mcp-apply', 'mcp-grant', 'mcp-fetch', 'mcp-compare']);
    expect(setMcpServers).toHaveBeenCalledTimes(1);
});

const { loggerDebug } = vi.hoisted(() => ({ loggerDebug: vi.fn() }));

vi.mock('@/ui/logger', () => ({
    logger: { debug: loggerDebug },
}));

const baseServers = {
    happy: { type: 'http', url: 'http://127.0.0.1:4000/mcp' },
};
const initialAplusServers = {
    argos: {
        type: 'http' as const,
        url: 'https://argos.test/mcp',
        headers: { Authorization: 'Bearer old-secret', 'X-Project': 'project-1' },
    },
};

describe('McpConfigSynchronizer', () => {
    it('keeps a session-start org MCP server that a later ok response omits', async () => {
        const setMcpServers = vi.fn(async () => ({ added: [], removed: [], errors: {} }));
        const synchronizer = new McpConfigSynchronizer({ setMcpServers } as any, {
            baseServers,
            initialAplusServers,
            floorServerNames: ['argos'],
            fetchAplusServers: vi.fn(async () => ({
                ok: true as const,
                // project scope 를 잃은 응답. argos 가 빠졌지만 200 이다.
                servers: { notion: { type: 'http' as const, url: 'https://gw.test/mcp/connector/notion' } },
            })),
        });

        await synchronizer.sync();

        const applied = (setMcpServers.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
        expect(Object.keys(applied).sort()).toEqual(['argos', 'happy', 'notion']);
        expect(applied.argos).toEqual(initialAplusServers.argos);
    });

    it('still applies additions and header refreshes while holding the floor', async () => {
        const setMcpServers = vi.fn(async () => ({ added: [], removed: [], errors: {} }));
        const synchronizer = new McpConfigSynchronizer({ setMcpServers } as any, {
            baseServers,
            initialAplusServers: {
                ...initialAplusServers,
                notion: { type: 'http' as const, url: 'https://gw.test/mcp/connector/notion', headers: { Authorization: 'Bearer stale' } },
            },
            floorServerNames: ['argos'],
            fetchAplusServers: vi.fn(async () => ({
                ok: true as const,
                servers: {
                    notion: { type: 'http' as const, url: 'https://gw.test/mcp/connector/notion', headers: { Authorization: 'Bearer fresh' } },
                },
            })),
        });

        await synchronizer.sync();

        const applied = (setMcpServers.mock.calls[0] as unknown[])[0] as Record<string, any>;
        // 커넥터는 바닥선이 아니므로 새 헤더가 그대로 반영된다.
        expect(applied.notion.headers.Authorization).toBe('Bearer fresh');
        // 조직 등록 MCP 는 바닥선이라 유지된다.
        expect(applied.argos).toEqual(initialAplusServers.argos);
    });

    it('drops a session-start connector that a later ok response omits', async () => {
        const setMcpServers = vi.fn(async () => ({ added: [], removed: [], errors: {} }));
        const synchronizer = new McpConfigSynchronizer({ setMcpServers } as any, {
            baseServers,
            initialAplusServers: {
                ...initialAplusServers,
                notion: { type: 'http' as const, url: 'https://gw.test/mcp/connector/notion' },
            },
            floorServerNames: ['argos'],
            fetchAplusServers: vi.fn(async () => ({
                ok: true as const,
                servers: initialAplusServers,
            })),
        });

        await synchronizer.sync();

        const applied = (setMcpServers.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
        // 재연결이 필요한 커넥터는 게이트웨이가 거부하므로 유지하지 않는다.
        expect(Object.keys(applied).sort()).toEqual(['argos', 'happy']);
    });

    it('treats an unconfigured A+ source as disabled instead of failed', async () => {
        const onStatus = vi.fn();
        const synchronizer = new McpConfigSynchronizer({ setMcpServers: vi.fn() } as any, {
            baseServers,
            initialAplusServers: {},
            fetchAplusServers: vi.fn(async () => ({
                ok: false as const,
                reason: 'not-configured' as const,
                error: 'mcp-config URL is not configured',
            })),
            onStatus,
        });

        await synchronizer.sync();

        expect(onStatus).not.toHaveBeenCalled();
    });

    it('keeps last-known-good servers when config fetch fails', async () => {
        const setMcpServers = vi.fn();
        const onStatus = vi.fn();
        const synchronizer = new McpConfigSynchronizer({ setMcpServers } as any, {
            baseServers,
            initialAplusServers,
            fetchAplusServers: vi.fn(async () => ({
                ok: false as const,
                reason: 'http-error' as const,
                error: 'mcp-config responded with 503',
            })),
            onStatus,
        });

        await synchronizer.sync();

        expect(setMcpServers).not.toHaveBeenCalled();
        expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({
            name: 'aplus-config',
            status: 'config-fetch-failed',
        }));
    });

    it('reports a persistent expected connector mismatch distinctly', async () => {
        const onStatus = vi.fn();
        const synchronizer = new McpConfigSynchronizer({ setMcpServers: vi.fn() } as any, {
            baseServers,
            initialAplusServers,
            fetchAplusServers: vi.fn(async () => ({
                ok: false as const,
                reason: 'connector-config-missing' as const,
                error: 'Expected connector configuration is missing: knoi',
                expected: ['gmail', 'knoi'],
                configured: ['gmail'],
                missing: ['knoi'],
            })),
            onStatus,
        });

        await synchronizer.sync();

        expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({
            name: 'knoi',
            status: 'connector-config-missing',
        }));
    });

    it('reports a missing runtime MCP service distinctly from a fetch failure', async () => {
        const onStatus = vi.fn();
        const synchronizer = new McpConfigSynchronizer({ setMcpServers: vi.fn() } as any, {
            baseServers,
            initialAplusServers,
            fetchAplusServers: vi.fn(async () => ({
                ok: false as const,
                reason: 'mcp-config-missing' as const,
                error: 'Expected MCP service configuration is missing: argos',
                expected: ['argos'],
                configured: [],
                missing: [{ name: 'argos', reason: 'missing-headers' }],
            })),
            onStatus,
        });

        await synchronizer.sync();

        expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({
            name: 'argos',
            status: 'mcp-config-missing',
        }));
        expect(onStatus).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'aplus-config' }));
    });

    it('preserves connector-specific status from unified MCP readiness', async () => {
        const onStatus = vi.fn();
        const synchronizer = new McpConfigSynchronizer({ setMcpServers: vi.fn() } as any, {
            baseServers,
            initialAplusServers,
            fetchAplusServers: vi.fn(async () => ({
                ok: false as const,
                reason: 'mcp-config-missing' as const,
                error: 'Expected MCP service configuration is missing: gmail',
                expected: ['gmail'],
                configured: [],
                missing: [{ name: 'gmail', reason: 'connector-config-missing' }],
            })),
            onStatus,
        });

        await synchronizer.sync();

        expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({
            name: 'gmail',
            status: 'connector-config-missing',
        }));
    });

    it('keeps last-known-good servers when config fetch throws', async () => {
        const setMcpServers = vi.fn();
        const onStatus = vi.fn();
        const synchronizer = new McpConfigSynchronizer({ setMcpServers } as any, {
            baseServers,
            initialAplusServers,
            fetchAplusServers: vi.fn(async () => {
                throw new Error('network exploded');
            }),
            onStatus,
        });

        await synchronizer.sync();

        expect(setMcpServers).not.toHaveBeenCalled();
        expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({
            name: 'aplus-config',
            status: 'config-fetch-failed',
        }));
    });

    it('does not apply a semantically identical config', async () => {
        const setMcpServers = vi.fn();
        const synchronizer = new McpConfigSynchronizer({ setMcpServers } as any, {
            baseServers,
            initialAplusServers,
            fetchAplusServers: vi.fn(async () => ({
                ok: true as const,
                servers: {
                    argos: {
                        headers: { 'X-Project': 'project-1', Authorization: 'Bearer old-secret' },
                        url: 'https://argos.test/mcp',
                        type: 'http' as const,
                    },
                },
            })),
        });

        await synchronizer.sync();

        expect(setMcpServers).not.toHaveBeenCalled();
    });

    it('applies a changed header once without exposing it in status', async () => {
        const setMcpServers = vi.fn(async () => ({ added: [], removed: [], errors: {} }));
        const onApplied = vi.fn();
        const onStatus = vi.fn();
        const changed = {
            argos: {
                ...initialAplusServers.argos,
                headers: { ...initialAplusServers.argos.headers, Authorization: 'Bearer new-secret' },
            },
        };
        const fetchAplusServers = vi.fn(async () => ({ ok: true as const, servers: changed }));
        const synchronizer = new McpConfigSynchronizer({ setMcpServers } as any, {
            baseServers,
            initialAplusServers,
            fetchAplusServers,
            onApplied,
            onStatus,
        });

        await synchronizer.sync();
        await synchronizer.sync();

        expect(setMcpServers).toHaveBeenCalledOnce();
        expect(setMcpServers).toHaveBeenCalledWith({ ...baseServers, ...changed });
        expect(onApplied).toHaveBeenCalledWith({ ...baseServers, ...changed }, changed);
        expect(JSON.stringify(onStatus.mock.calls)).not.toContain('new-secret');
    });

    it('logs only added and removed server names when applying config', async () => {
        loggerDebug.mockClear();
        const setMcpServers = vi.fn(async () => ({
            added: ['slack'],
            removed: ['argos'],
            errors: {},
        }));
        const synchronizer = new McpConfigSynchronizer({ setMcpServers } as any, {
            baseServers,
            initialAplusServers,
            fetchAplusServers: vi.fn(async () => ({
                ok: true as const,
                servers: {
                    slack: {
                        type: 'http' as const,
                        url: 'https://slack.test/mcp',
                        headers: { Authorization: 'Bearer must-not-leak' },
                    },
                },
            })),
        });

        await synchronizer.sync();

        expect(loggerDebug).toHaveBeenCalledWith(
            '[MCP CONFIG] Applied server changes added=slack removed=argos',
        );
        expect(JSON.stringify(loggerDebug.mock.calls)).not.toContain('must-not-leak');
    });
});
