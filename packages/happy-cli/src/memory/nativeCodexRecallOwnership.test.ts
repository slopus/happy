import { describe, expect, it } from 'vitest';
import { nativeCodexRecallOwnershipOverrides } from './nativeCodexRecallOwnership';
import { RECALL_OWNER_ENV } from './recallOwnerMarker';

describe('native Codex MCP recall ownership', () => {
    it('never forwards normalized native null fields or native environment contents', () => {
        const native = { memoryAlias: {
            command: 'claude-memory-layer-mcp', args: [], env: { NATIVE_SETTING: 'native-value' },
            startup_timeout_sec: null, tool_timeout_sec: null, enabled_tools: null, disabled_tools: null,
        } };
        expect(nativeCodexRecallOwnershipOverrides(native)).toEqual({
            'mcp_servers.memoryAlias.env.CLAUDE_MEMORY_RECALL_OWNER': 'host',
        });
    });

    it('uses the complete server map for dotted, spaced, and escaped aliases', () => {
        const server = { command: 'claude-memory-layer-mcp' };
        expect(nativeCodexRecallOwnershipOverrides({
            'memory-alias_1': server,
            'memory.with.dot': server,
            'memory space': server,
            'memory"quoted\\alias': server,
        })).toEqual({
            mcp_servers: {
                'memory-alias_1': { ...server, env: { [RECALL_OWNER_ENV]: 'host' } },
                'memory.with.dot': { ...server, env: { [RECALL_OWNER_ENV]: 'host' } },
                'memory space': { ...server, env: { [RECALL_OWNER_ENV]: 'host' } },
                'memory"quoted\\alias': { ...server, env: { [RECALL_OWNER_ENV]: 'host' } },
            },
        });
    });

    it('preserves native siblings and aliased CML settings when a runtime map replaces the native map', () => {
        const native = {
            projectMemory: {
                command: '/opt/cml/bin/claude-memory-layer-mcp',
                args: ['--fixture'],
                cwd: '/repo',
                env: { NATIVE_SETTING: 'native-value', SHARED_SETTING: 'native', [RECALL_OWNER_ENV]: 'host-worker' },
                env_vars: ['INHERITED_SETTING'],
                startup_timeout_sec: 15,
                tool_timeout_sec: 30,
                enabled_tools: ['mem-source-ref'],
            },
            otherNative: { command: 'other-mcp', env: { NATIVE_SETTING: 'unrelated' } },
        };
        const runtime = {
            projectMemory: { env: { RUNTIME_SETTING: 'runtime-value', SHARED_SETTING: 'runtime' }, tool_timeout_sec: 45 },
            gateway: { url: 'https://connector.invalid/mcp', http_headers: { 'X-Fixture': 'header-value' } },
        };
        const nativeBefore = structuredClone(native);
        const runtimeBefore = structuredClone(runtime);
        expect(nativeCodexRecallOwnershipOverrides(native, runtime)).toEqual({
            mcp_servers: {
                ...native,
                ...runtime,
                projectMemory: {
                    ...native.projectMemory,
                    ...runtime.projectMemory,
                    env: {
                        NATIVE_SETTING: 'native-value', SHARED_SETTING: 'runtime', RUNTIME_SETTING: 'runtime-value',
                        [RECALL_OWNER_ENV]: 'host',
                    },
                },
            },
        });
        expect(native).toEqual(nativeBefore);
        expect(runtime).toEqual(runtimeBefore);
    });

    it('adds ownership to a runtime-only CML server without replacing unrelated connectors', () => {
        const other = { command: 'other-mcp', env: { OTHER_SETTING: 'value' } };
        const runtime = { cmlAlias: { command: 'claude-memory-layer-mcp', args: [] }, other };
        const result = nativeCodexRecallOwnershipOverrides(undefined, runtime);
        expect(result).toEqual({ mcp_servers: { ...runtime, cmlAlias: { ...runtime.cmlAlias, env: { [RECALL_OWNER_ENV]: 'host' } } } });
        expect(runtime.other).toBe(other);
        expect(runtime.cmlAlias).not.toHaveProperty('env');
    });

    it('does not mark a disabled native CML server when runtime settings omit enabled', () => {
        const native = { memoryAlias: { command: 'claude-memory-layer-mcp', enabled: false, env: { NATIVE_SETTING: 'value' } } };
        const runtime = { memoryAlias: { env: { RUNTIME_SETTING: 'value' } } };
        expect(nativeCodexRecallOwnershipOverrides(native, runtime)).toEqual({});
        expect(nativeCodexRecallOwnershipOverrides(native)).toEqual({});
    });

    it('honors an explicit runtime disable and an explicit runtime command replacement', () => {
        const native = { memory: { command: 'claude-memory-layer-mcp', enabled: true } };
        for (const memory of [{ enabled: false }, { command: 'other-mcp' }]) {
            const runtime = { memory };
            expect(nativeCodexRecallOwnershipOverrides(native, runtime)).toEqual({});
        }
        expect(nativeCodexRecallOwnershipOverrides(
            { memory: { command: 'other-mcp' } },
            { memory: { command: 'claude-memory-layer-mcp' } },
        )).toEqual({ mcp_servers: { memory: { command: 'claude-memory-layer-mcp', env: { [RECALL_OWNER_ENV]: 'host' } } } });
    });

    it('leaves HTTP configurations unchanged even when their aliases or command resemble CML', () => {
        const runtime = {
            'claude-memory-layer': { url: 'https://memory.invalid/mcp' },
            ambiguous: { command: 'claude-memory-layer-mcp', url: 'https://memory.invalid/mcp' },
        };
        expect(nativeCodexRecallOwnershipOverrides({}, runtime)).toEqual({});
    });

    it.each([
        'claude-memory-layer-mcp',
        '/opt/cml/claude-memory-layer-mcp',
        'C:\\tools\\claude-memory-layer-mcp.cmd',
        'C:\\tools\\CLAUDE-MEMORY-LAYER-MCP.EXE',
    ])('recognizes the exact stdio executable %s regardless of server alias', (command) => {
        expect(nativeCodexRecallOwnershipOverrides({ arbitraryAlias: { command } })).toEqual({
            'mcp_servers.arbitraryAlias.env.CLAUDE_MEMORY_RECALL_OWNER': 'host',
        });
    });

    it.each([
        { command: 'node', args: ['/opt/cml/dist/mcp/index.js'] },
        { command: 'npx', args: ['claude-memory-layer-mcp'] },
        { command: 'sh', args: ['-c', 'claude-memory-layer-mcp'] },
        { command: 'unrelated-claude-memory-layer-mcp' },
        { command: 'claude-memory-layer-mcp --fixture' },
        { command: 42 },
        {},
    ])('does not infer ownership from wrappers, misleading command strings, or invalid configurations %#', (server) => {
        expect(nativeCodexRecallOwnershipOverrides({ 'claude-memory-layer': server })).toEqual({});
    });

    it('does not reinterpret invalid runtime entries as inherited native CML settings', () => {
        const native = { alias: { command: 'claude-memory-layer-mcp' } };
        for (const invalid of [null, undefined, false, [], 'invalid']) {
            const runtime = { alias: invalid };
            expect(nativeCodexRecallOwnershipOverrides(native, runtime)).toEqual({});
        }
        expect(nativeCodexRecallOwnershipOverrides(['invalid'])).toEqual({});
    });

    it('does not mutate reusable native or runtime configuration objects', () => {
        const nativeServer = Object.freeze({
            command: 'claude-memory-layer-mcp',
            args: Object.freeze(['--fixture']),
            env: Object.freeze({ NATIVE_SETTING: 'value' }),
        });
        const native = Object.freeze({ memory: nativeServer });
        const runtimeServer = Object.freeze({ env: Object.freeze({ RUNTIME_SETTING: 'value' }) });
        const runtime = Object.freeze({ memory: runtimeServer });
        const result = nativeCodexRecallOwnershipOverrides(native, runtime);
        expect(result).not.toEqual({});
        expect(nativeServer.env).toEqual({ NATIVE_SETTING: 'value' });
        expect(runtimeServer.env).toEqual({ RUNTIME_SETTING: 'value' });
        expect(result).toEqual({ mcp_servers: { memory: {
            ...nativeServer,
            env: { NATIVE_SETTING: 'value', RUNTIME_SETTING: 'value', [RECALL_OWNER_ENV]: 'host' },
        } } });
    });

    it('removes normalized native nulls from full-map overrides without losing sibling settings', () => {
        const native = {
            memory: {
                command: 'claude-memory-layer-mcp', args: [], tool_timeout_sec: null,
                env: { NATIVE_SETTING: 'value' }, enabled_tools: null,
            },
            sibling: {
                url: 'https://sibling.invalid/mcp', http_headers: { 'X-Fixture': 'value' },
                enabled_tools: null, disabled_tools: null,
            },
        };
        const runtime = { gateway: { command: 'fixture-gateway', env: { RUNTIME_SETTING: 'value' } } };
        expect(nativeCodexRecallOwnershipOverrides(native, runtime)).toEqual({ mcp_servers: {
            memory: { command: 'claude-memory-layer-mcp', args: [], env: { NATIVE_SETTING: 'value', [RECALL_OWNER_ENV]: 'host' } },
            sibling: { url: 'https://sibling.invalid/mcp', http_headers: { 'X-Fixture': 'value' } },
            gateway: runtime.gateway,
        } });
        expect(native.memory.tool_timeout_sec).toBeNull();
        expect(native.sibling.disabled_tools).toBeNull();
    });

    it('supports a valid alias named __proto__ without treating it as an object prototype', () => {
        const native = Object.fromEntries([['__proto__', { command: 'claude-memory-layer-mcp' }]]);
        expect(nativeCodexRecallOwnershipOverrides(native)).toEqual({
            'mcp_servers.__proto__.env.CLAUDE_MEMORY_RECALL_OWNER': 'host',
        });
    });
});
