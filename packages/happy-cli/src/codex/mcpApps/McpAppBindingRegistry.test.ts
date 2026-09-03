import { describe, expect, it } from 'vitest';
import type { McpAppResultV1 } from '@slopus/happy-wire';
import { McpAppBindingRegistry } from './McpAppBindingRegistry';

const availableResult = {
    version: 1,
    state: 'available',
    content: [{ type: 'text', text: 'done' }],
} satisfies McpAppResultV1;

function bindConnectorCall(registry: McpAppBindingRegistry): void {
    registry.bindStarted({
        callId: 'call-1',
        threadId: 'thread-1',
        server: 'demo',
        resourceUri: 'ui://demo/index.html',
        input: { period: 'week' },
        connectorId: 'connector-1',
        appName: 'Demo App',
        actionName: 'Show dashboard',
    });
}

describe('McpAppBindingRegistry', () => {
    it('retains an immutable started binding and treats matching replay as idempotent', () => {
        const registry = new McpAppBindingRegistry();
        bindConnectorCall(registry);
        bindConnectorCall(registry);

        const binding = registry.get('call-1');
        expect(binding).toEqual({
            callId: 'call-1',
            threadId: 'thread-1',
            server: 'demo',
            resourceUri: 'ui://demo/index.html',
            input: { period: 'week' },
            connectorId: 'connector-1',
            appName: 'Demo App',
            actionName: 'Show dashboard',
        });
        const authorityMutations = [
            ['callId', 'call-2'],
            ['threadId', 'thread-2'],
            ['server', 'other'],
            ['resourceUri', 'ui://other/index.html'],
        ] as const;
        for (const [field, value] of authorityMutations) {
            expect(() => {
                (binding as unknown as Record<string, unknown>)[field] = value;
            }).toThrow(TypeError);
        }
        expect(registry.get('call-1')).toMatchObject({
            callId: 'call-1',
            threadId: 'thread-1',
            server: 'demo',
            resourceUri: 'ui://demo/index.html',
        });
    });

    it('clones and deeply freezes caller-owned input and completed result values', () => {
        const registry = new McpAppBindingRegistry();
        const sourceInput = {
            filters: [{ period: 'week' }],
        };
        const sourceResult = {
            version: 1 as const,
            state: 'available' as const,
            content: [{ type: 'text', text: 'original' }],
            structuredContent: { rows: [{ count: 1 }] },
        } satisfies McpAppResultV1;
        registry.bindStarted({
            callId: 'call-cloned',
            threadId: 'thread-1',
            server: 'demo',
            resourceUri: 'ui://demo/index.html',
            input: sourceInput,
            connectorId: 'connector-1',
        });
        registry.complete('call-cloned', sourceResult, true);

        sourceInput.filters[0].period = 'month';
        sourceResult.content[0].text = 'mutated';
        sourceResult.structuredContent.rows[0].count = 2;

        const stored = registry.get('call-cloned');
        expect(stored.input).toEqual({ filters: [{ period: 'week' }] });
        expect(stored.result).toEqual({
            version: 1,
            state: 'available',
            content: [{ type: 'text', text: 'original' }],
            structuredContent: { rows: [{ count: 1 }] },
        });
        expect(() => {
            (stored.input.filters as Array<{ period: string }>)[0].period = 'year';
        }).toThrow(TypeError);
        expect(() => {
            const result = stored.result as typeof sourceResult;
            result.structuredContent.rows[0].count = 3;
        }).toThrow(TypeError);

        expect(() => registry.complete('call-cloned', {
            version: 1,
            state: 'available',
            content: [{ type: 'text', text: 'original' }],
            structuredContent: { rows: [{ count: 1 }] },
        }, true)).not.toThrow();
    });

    it.each([
        ['threadId', { threadId: 'thread-2' }],
        ['server', { server: 'other' }],
        ['resourceUri', { resourceUri: 'ui://other/index.html' }],
    ])('rejects replay that changes immutable %s authority', (_field, change) => {
        const registry = new McpAppBindingRegistry();
        bindConnectorCall(registry);

        expect(() => registry.bindStarted({
            callId: 'call-1',
            threadId: 'thread-1',
            server: 'demo',
            resourceUri: 'ui://demo/index.html',
            input: { period: 'week' },
            connectorId: 'connector-1',
            ...change,
        })).toThrowError(expect.objectContaining({ code: 'MCP_APP_ORIGIN_MISMATCH' }));
    });

    it('does not trust an origin before a connector call succeeds', () => {
        const registry = new McpAppBindingRegistry();
        bindConnectorCall(registry);

        expect(registry.get('call-1').trustedOriginCallId).toBeUndefined();
        registry.complete('call-1', availableResult, false);

        expect(registry.get('call-1')).toMatchObject({
            result: availableResult,
        });
        expect(registry.get('call-1').trustedOriginCallId).toBeUndefined();
    });

    it('derives the trusted origin from a successful connector call', () => {
        const registry = new McpAppBindingRegistry();
        bindConnectorCall(registry);

        registry.complete('call-1', availableResult, true);

        expect(registry.get('call-1')).toMatchObject({
            result: availableResult,
            trustedOriginCallId: 'call-1',
        });
    });

    it('treats an identical terminal completion replay as a no-op', () => {
        const registry = new McpAppBindingRegistry();
        bindConnectorCall(registry);
        registry.complete('call-1', availableResult, true);
        const completed = registry.get('call-1');

        registry.complete('call-1', { ...availableResult }, true);

        expect(registry.get('call-1')).toBe(completed);
    });

    it('rejects promotion of a failed connector completion to trusted', () => {
        const registry = new McpAppBindingRegistry();
        bindConnectorCall(registry);
        registry.complete('call-1', availableResult, false);
        const failed = registry.get('call-1');

        expect(() => registry.complete('call-1', availableResult, true)).toThrowError(
            expect.objectContaining({ code: 'MCP_APP_ORIGIN_MISMATCH' }),
        );
        expect(registry.get('call-1')).toBe(failed);
        expect(registry.get('call-1').trustedOriginCallId).toBeUndefined();
    });

    it('rejects overwriting the result of a terminal completion', () => {
        const registry = new McpAppBindingRegistry();
        bindConnectorCall(registry);
        registry.complete('call-1', availableResult, true);
        const completed = registry.get('call-1');
        const replacement = {
            version: 1,
            state: 'available',
            content: [{ type: 'text', text: 'replacement' }],
        } satisfies McpAppResultV1;

        expect(() => registry.complete('call-1', replacement, true)).toThrowError(
            expect.objectContaining({ code: 'MCP_APP_ORIGIN_MISMATCH' }),
        );
        expect(registry.get('call-1')).toBe(completed);
        expect(registry.get('call-1').result).toEqual(availableResult);
    });

    it('keeps an ordinary configured MCP binding thread-scoped after success', () => {
        const registry = new McpAppBindingRegistry();
        registry.bindStarted({
            callId: 'call-configured',
            threadId: 'thread-1',
            server: 'configured-demo',
            resourceUri: 'ui://configured-demo/index.html',
            input: {},
        });

        registry.complete('call-configured', availableResult, true);

        expect(registry.get('call-configured').result).toEqual(availableResult);
        expect(registry.get('call-configured').trustedOriginCallId).toBeUndefined();
    });

    it('rejects unknown call IDs for lookup and completion', () => {
        const registry = new McpAppBindingRegistry();

        expect(() => registry.get('missing')).toThrowError(expect.objectContaining({
            code: 'MCP_APP_ORIGIN_MISMATCH',
        }));
        expect(() => registry.complete('missing', availableResult, true)).toThrowError(expect.objectContaining({
            code: 'MCP_APP_ORIGIN_MISMATCH',
        }));
    });

    it('removes bindings and terminal completion state when the session is cleared', () => {
        const registry = new McpAppBindingRegistry();
        bindConnectorCall(registry);
        registry.complete('call-1', availableResult, false);

        registry.clear();

        expect(() => registry.get('call-1')).toThrowError(expect.objectContaining({
            code: 'MCP_APP_ORIGIN_MISMATCH',
        }));
        bindConnectorCall(registry);
        expect(() => registry.complete('call-1', availableResult, true)).not.toThrow();
        expect(registry.get('call-1').trustedOriginCallId).toBe('call-1');
    });
});
