import { expect, it } from 'vitest';
import { ClaudeModelCatalogRequestSchema, ClaudeModelCatalogSchema } from './claudeModelCatalog';

it('accepts new model/effort identifiers while stripping unrelated native account data', () => {
    expect(ClaudeModelCatalogSchema.parse({ source: 'claude-native', observedAt: 1, account: 'private', models: [
        { code: 'future/model', value: 'Future', supportedEffortLevels: ['future-effort'], account: 'private' },
    ] })).toEqual({ source: 'claude-native', observedAt: 1, models: [{ code: 'future/model', value: 'Future', supportedEffortLevels: ['future-effort'] }] });
});
it('bounds catalogs and limits machine requests to a directory instead of arbitrary launch options', () => {
    expect(() => ClaudeModelCatalogSchema.parse({ source: 'claude-native', observedAt: 1, models: [] })).toThrow();
    expect(() => ClaudeModelCatalogRequestSchema.parse({ directory: '/work', env: { ANTHROPIC_BASE_URL: 'other' } })).toThrow();
});
