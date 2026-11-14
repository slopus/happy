import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import type { Metadata } from '@/api/types';
import { applyClaudeModelCatalog, resolveClaudeModelCode } from './modelCatalog';

const metadata: Metadata = {
    path: '/project', host: 'test-machine', homeDir: '/home/test',
    happyHomeDir: '/home/test/.happy', happyLibDir: '/happy', happyToolsDir: '/happy/tools',
    flavor: 'claude', summary: { text: 'existing session', updatedAt: 1 },
};
const catalog: ModelInfo[] = [
    { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5' },
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5' },
];

describe('Claude session model catalogs', () => {
    it('pins concrete family aliases to runtime-resolved IDs while retaining capabilities', () => {
        const next = applyClaudeModelCatalog(metadata, catalog, 'opus');
        expect(next.models?.map(model => model.code)).toEqual(['default', 'claude-opus-5-5', 'claude-sonnet-5']);
        expect(next.models?.[1]).toEqual({ code: 'claude-opus-5-5', value: 'Opus', description: 'Opus 5.5', id: 'claude-opus-5-5', thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'] });
        expect(next.currentModelCode).toBe('claude-opus-5-5');
        expect(next.summary).toBe(metadata.summary);
        expect(metadata.models).toBeUndefined();
    });

    it.each(['claude-opus-5-5', 'claude-opus-5-5[1m]', 'custom-provider-model'])(
        'retains an explicit selection not advertised as a catalog code: %s', current => {
            const next = applyClaudeModelCatalog(metadata, catalog, current);
            expect(next.models?.map(model => model.code)).toContain(current);
            expect(next.currentModelCode).toBe(current);
        },
    );

    it('does not invent a 1M variant', () => {
        const next = applyClaudeModelCatalog(metadata, catalog);
        expect(next.models?.map(model => model.code)).toEqual(['default', 'claude-opus-5-5', 'claude-sonnet-5']);
        expect(next.currentModelCode).toBeUndefined();
    });

    it('keeps the SDK-provided version visible in menus that hide descriptions', () => {
        const next = applyClaudeModelCatalog(metadata, [
            { ...catalog[1], description: 'Opus 5.5 · Best for everyday tasks' },
        ]);
        expect(next.models?.[0]).toMatchObject({ code: 'claude-opus-5-5', value: 'Opus 5.5' });
    });

    it('uses the SDK display name when the description has no structured model label', () => {
        const next = applyClaudeModelCatalog(metadata, [
            { ...catalog[1], description: 'Best for everyday tasks' },
        ]);
        expect(next.models?.[0]?.value).toBe('Opus');
    });

    it('keeps Default and behavioral aliases intact, including unknown aliases on older SDKs', () => {
        const next = applyClaudeModelCatalog(metadata, [
            catalog[0],
            { value: 'opusplan', resolvedModel: 'claude-sonnet-5', displayName: 'Opus plan', description: 'Automatic switch' },
            { value: 'opus', displayName: 'Opus', description: 'Legacy SDK without resolvedModel' },
        ]);
        expect(next.models?.map(model => model.code)).toEqual(['default', 'opusplan', 'opus']);
    });

    it('preserves context suffixes of catalog-provided aliases', () => {
        const next = applyClaudeModelCatalog(metadata, [
            { ...catalog[1], value: 'opus[1m]' },
        ], 'opus[1m]');
        expect(next.models?.map(model => model.code)).toEqual(['claude-opus-5-5[1m]']);
        expect(next.currentModelCode).toBe('claude-opus-5-5[1m]');
    });

    it('keeps the latest selection when delayed discovery completes', () => {
        const changed = applyClaudeModelCatalog(metadata, undefined, 'sonnet');
        const next = applyClaudeModelCatalog(changed, catalog);
        expect(next.currentModelCode).toBe('claude-sonnet-5');
        expect(next.models).toHaveLength(3);
    });

    it('keeps a catalog intact when updating only the active selection', () => {
        const initial = applyClaudeModelCatalog(metadata, catalog, 'opus');
        const next = applyClaudeModelCatalog(initial, undefined, 'claude-sonnet-5');
        expect(next.models).toEqual(initial.models);
        expect(next.currentModelCode).toBe('claude-sonnet-5');
        expect(initial.currentModelCode).toBe('claude-opus-5-5');
    });

    it('deduplicates model codes and ignores empty SDK entries', () => {
        const next = applyClaudeModelCatalog(metadata, [...catalog, catalog[1], { value: '', displayName: '', description: '' }]);
        expect(next.models).toHaveLength(3);
    });

    it('replaces a local catalog with the active remote runtime catalog', () => {
        const local = applyClaudeModelCatalog(metadata, catalog, 'opus');
        const remote = applyClaudeModelCatalog(local, [catalog[2]], 'sonnet');
        expect(remote.models?.map(model => model.code)).toEqual(['claude-sonnet-5']);
        expect(remote.currentModelCode).toBe('claude-sonnet-5');
    });

    it('preserves a Default reset as a selection, not a model-version guess', () => {
        const next = applyClaudeModelCatalog(metadata, catalog, 'default');
        expect(next.currentModelCode).toBe('default');
        expect(next.models).toHaveLength(3);
    });
});

describe('observed Claude models', () => {
    it('uses the observed full ID instead of a runtime-dependent alias', () => {
        expect(resolveClaudeModelCode('opus', 'claude-opus-5-5')).toBe('claude-opus-5-5');
    });
    it('preserves an explicitly requested context suffix', () => {
        expect(resolveClaudeModelCode('claude-opus-5-5[1m]', 'claude-opus-5-5')).toBe('claude-opus-5-5[1m]');
    });
    it('does not erase a context suffix explicitly reported by the runtime', () => {
        expect(resolveClaudeModelCode('opus', 'claude-opus-5-5[1m]')).toBe('claude-opus-5-5[1m]');
    });
    it('does not label a fallback model as the requested model', () => {
        expect(resolveClaudeModelCode('opus', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    });
    it('reports the observed model without an explicit override', () => {
        expect(resolveClaudeModelCode(undefined, 'claude-opus-5-5')).toBe('claude-opus-5-5');
    });
    it('does not mistake a Default choice for a confirmed active model', () => {
        expect(resolveClaudeModelCode('default', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    });
});
