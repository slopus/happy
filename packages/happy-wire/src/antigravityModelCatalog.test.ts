import { expect, it } from 'vitest';
import { AntigravityModelCatalogRequestSchema, AntigravityModelCatalogSchema } from './antigravityModelCatalog';

it('retains actual native model and effort identifiers while excluding unrelated account details', () => {
    const snapshot = {
        source: 'antigravity-native',
        observedAt: 1,
        currentModelCode: 'future/model',
        account: 'private',
        models: [
            { code: 'future/model', value: 'Future', supportedEffortLevels: ['future-effort'], account: 'private' },
        ],
    };
    expect(AntigravityModelCatalogSchema.parse(snapshot)).toEqual({
        source: 'antigravity-native',
        observedAt: 1,
        currentModelCode: 'future/model',
        models: [{ code: 'future/model', value: 'Future', supportedEffortLevels: ['future-effort'] }],
    });
});
it('distinguishes a confirmed empty catalog from unavailable discovery and rejects ambiguous duplicate IDs', () => {
    expect(
        AntigravityModelCatalogSchema.parse({ source: 'antigravity-native', observedAt: 1, models: [] }).models,
    ).toEqual([]);
    expect(() => AntigravityModelCatalogSchema.parse({ source: 'antigravity-native', observedAt: 1 })).toThrow();
    expect(() =>
        AntigravityModelCatalogSchema.parse({
            source: 'antigravity-native',
            observedAt: 1,
            models: [
                { code: 'same', value: 'A' },
                { code: 'same', value: 'B' },
            ],
        }),
    ).toThrow(/Duplicate/);
});
it('bounds catalog size and restricts machine requests to the working directory', () => {
    expect(() =>
        AntigravityModelCatalogRequestSchema.parse({ directory: '/work', command: 'other', env: {} }),
    ).toThrow();
    expect(() =>
        AntigravityModelCatalogSchema.parse({
            source: 'antigravity-native',
            observedAt: 1,
            models: Array.from({ length: 1025 }, (_, id) => ({ code: String(id), value: String(id) })),
        }),
    ).toThrow();
    expect(() =>
        AntigravityModelCatalogSchema.parse({
            source: 'antigravity-native',
            observedAt: 1,
            models: [{ code: 'native', value: 'Native', supportedEffortLevels: Array(33).fill('high') }],
        }),
    ).toThrow();
});
