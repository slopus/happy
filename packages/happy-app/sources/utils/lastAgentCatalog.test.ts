import { describe, expect, it } from 'vitest';
import { findLastAgentCatalog } from './lastAgentCatalog';

const session = (over: Record<string, unknown>) => ({
    id: String(over.id ?? 's'),
    updatedAt: Number(over.updatedAt ?? 0),
    metadata: over.metadata,
}) as never;

const opencode = (models: string[]) => ({
    flavor: 'opencode',
    machineId: 'm1',
    models: models.map((value) => ({ value, name: value })),
    operatingModes: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }],
    currentModelCode: models[0],
    currentOperatingModeCode: 'build',
});

describe('findLastAgentCatalog', () => {
    it('returns the catalog the agent reported most recently', () => {
        const catalog = findLastAgentCatalog({
            old: session({ id: 'old', updatedAt: 10, metadata: opencode(['opencode/older']) }),
            new: session({ id: 'new', updatedAt: 20, metadata: opencode(['opencode/big-pickle']) }),
        }, 'opencode', 'm1');

        expect(catalog?.models?.map((m) => m.value)).toEqual(['opencode/big-pickle']);
        expect(catalog?.currentModelCode).toBe('opencode/big-pickle');
        expect(catalog?.operatingModes?.map((m) => m.value)).toEqual(['build', 'plan']);
    });

    it('ignores another agent, so OpenCode never inherits Claude\'s models', () => {
        const catalog = findLastAgentCatalog({
            claude: session({ id: 'c', updatedAt: 99, metadata: { flavor: 'claude', machineId: 'm1', models: [{ value: 'opus', name: 'Opus' }] } }),
        }, 'opencode', 'm1');

        expect(catalog).toBeNull();
    });

    it('ignores a catalog from another computer, which may not run those models', () => {
        const catalog = findLastAgentCatalog({
            elsewhere: session({ id: 'e', updatedAt: 99, metadata: { ...opencode(['opencode/big-pickle']), machineId: 'm2' } }),
        }, 'opencode', 'm1');

        expect(catalog).toBeNull();
    });

    it('skips sessions that never reported a catalog', () => {
        const catalog = findLastAgentCatalog({
            empty: session({ id: 'x', updatedAt: 99, metadata: { flavor: 'opencode', machineId: 'm1' } }),
            real: session({ id: 'y', updatedAt: 1, metadata: opencode(['opencode/big-pickle']) }),
        }, 'opencode', 'm1');

        expect(catalog?.models?.map((m) => m.value)).toEqual(['opencode/big-pickle']);
    });

    it('is null when nothing is known yet', () => {
        expect(findLastAgentCatalog({}, 'opencode', 'm1')).toBeNull();
        expect(findLastAgentCatalog(null, 'opencode', 'm1')).toBeNull();
        expect(findLastAgentCatalog({}, undefined, 'm1')).toBeNull();
    });
});
