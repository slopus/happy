import { describe, expect, it } from 'vitest';
import { inferToolNameForRendering } from './toolNameInference';

describe('inferToolNameForRendering', () => {
    const known = ['read', 'write', 'edit', 'bash', 'execute', 'TodoWrite', 'TodoRead'];

    it('prefers toolInput.toolName when tool name is unknown', () => {
        const result = inferToolNameForRendering({
            toolName: 'unknown',
            toolInput: { toolName: 'read', filepath: '/etc/hosts' },
            toolDescription: null,
            knownToolKeys: known,
        });
        expect(result).toEqual({ normalizedToolName: 'read', source: 'toolInputToolName' });
    });

    it('falls back to toolInput.permission.toolName when present', () => {
        const result = inferToolNameForRendering({
            toolName: 'unknown',
            toolInput: { permission: { toolName: 'write' } },
            toolDescription: null,
            knownToolKeys: known,
        });
        expect(result).toEqual({ normalizedToolName: 'write', source: 'toolInputPermissionToolName' });
    });

    it('uses _acp.kind when present and non-unknown', () => {
        const result = inferToolNameForRendering({
            toolName: 'Run echo hello',
            toolInput: { _acp: { kind: 'execute' } },
            toolDescription: 'Run echo hello',
            knownToolKeys: known,
        });
        expect(result).toEqual({ normalizedToolName: 'execute', source: 'acpKind' });
    });

    it('can derive from toolDescription when it is a stable key', () => {
        const result = inferToolNameForRendering({
            toolName: 'unknown',
            toolInput: {},
            toolDescription: 'read',
            knownToolKeys: known,
        });
        expect(result).toEqual({ normalizedToolName: 'read', source: 'toolDescription' });
    });

    it('normalizes todoread to TodoRead via known tool keys', () => {
        const result = inferToolNameForRendering({
            toolName: 'todoread',
            toolInput: {},
            toolDescription: null,
            knownToolKeys: known,
        });
        expect(result).toEqual({ normalizedToolName: 'TodoRead', source: 'original' });
    });
});
