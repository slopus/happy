import { describe, expect, it } from 'vitest';
import {
    getAvailableModels,
    normalizeModelEffortKey,
    getSuggestedModelModes,
    getAvailablePermissionModes,
    getEffortLevelsForModel,
    getCodexModelModes,
    getClaudePermissionModes,
    getGeminiPermissionModes,
    getDefaultEffortKey,
    getDefaultModelKey,
    getDefaultPermissionModeKey,
    mapMetadataOptions,
    resolveCurrentOption,
} from './modelModeOptions';

const translate = (key: string) => `tr:${key}`;

describe('modelModeOptions', () => {
    it('resets stale Claude effort to a supported level or CLI default on the next send', () => {
        const metadata = { models: [{ code: 'small', value: 'Small', supportedEffortLevels: ['low'] }, { code: 'none', value: 'None', supportedEffortLevels: [] }] } as any;
        expect(normalizeModelEffortKey('claude', 'small', 'max', metadata)).toBe('low');
        expect(normalizeModelEffortKey('claude', 'none', 'max', metadata)).toBeNull();
    });
    it('never invents Claude version numbers when a native catalog is unavailable', () => {
        expect(getAvailableModels('claude', null, translate).map(model => model.name)).toEqual(['default model', 'Opus', 'Sonnet', 'Haiku']);
    });
    it('uses each native Claude model effort range, including a new level and an explicit empty range', () => {
        const metadata = { models: [
            { code: 'future', value: 'Future Claude', supportedEffortLevels: ['medium', 'future-effort'] },
            { code: 'fast', value: 'Fast', supportedEffortLevels: [] },
        ] } as any;
        expect(getEffortLevelsForModel('claude', 'future', metadata).map(level => level.key)).toEqual(['medium', 'future-effort']);
        expect(getEffortLevelsForModel('claude', 'fast', metadata)).toEqual([]);
    });
    it('offers only the bound ChatGPT account catalog without adding unsupported suggestions', () => {
        const models = getSuggestedModelModes('codex', {
            codexAccountProfileId: 'account-a',
            models: [{ code: 'gpt-6.1-sol', value: 'Sol' }],
        } as any, translate);
        expect(models.map(model => model.key)).toEqual(['gpt-6.1-sol']);
    });
    it('maps metadata option shape into mode options', () => {
        expect(mapMetadataOptions([
            { code: 'm1', value: 'Model One', description: 'Primary model' },
            { code: 'm2', value: 'Model Two' },
        ])).toEqual([
            { key: 'm1', name: 'Model One', description: 'Primary model' },
            { key: 'm2', name: 'Model Two', description: null },
        ]);
    });

    it('builds claude permission fallbacks with translated names', () => {
        const modes = getClaudePermissionModes(translate);
        expect(modes.map((mode) => mode.key)).toEqual(['default', 'plan', 'dontAsk', 'acceptEdits', 'bypassPermissions']);
        expect(modes[0].name).toBe('tr:agentInput.permissionMode.default');
    });

    it('builds codex model fallbacks', () => {
        const models = getCodexModelModes();
        expect(models.map((model) => model.key)).toEqual([
            'gpt-6-astra',
            'gpt-6.1-sol',
            'gpt-6-sol',
            'gpt-6-luna',
            'gpt-5.6-sol',
            'gpt-5.6-terra',
            'gpt-5.6-luna',
            'gpt-5.5',
            'gpt-5.4',
            'gpt-5.4-mini',
            'gpt-5.3-codex-spark',
        ]);
        expect(models[0].name).toBe('gpt-6-astra');
        expect(models[1].name).toBe('gpt-6.1-sol');
    });

    it('preserves the connection catalog without injecting unsupported newer models', () => {
        const metadata = { models: [
            { code: 'gpt-6-astra', value: 'Astra', description: 'From catalog' },
            { code: 'gpt-5.6-sol', value: 'Older Sol' },
            { code: 'custom-model', value: 'Custom' },
        ] } as any;
        const models = getSuggestedModelModes('codex', metadata, translate);
        expect(models.map((model) => model.key)).toEqual([
            'gpt-6-astra', 'gpt-5.6-sol', 'custom-model',
        ]);
        expect(models[0]).toEqual({ key: 'gpt-6-astra', name: 'Astra', description: 'From catalog' });
        expect(getAvailableModels('codex', metadata, translate).map((model) => model.key))
            .toEqual(['gpt-6-astra', 'gpt-5.6-sol', 'custom-model']);
    });

    it('preserves fresh model descriptions without duplicates or mutating metadata', () => {
        const metadata = { models: [
            { code: 'default', value: 'Default' },
            { code: 'gpt-6-sol', value: 'Sol', description: 'Live description' },
            { code: 'gpt-6-luna', value: 'Luna' },
        ] } as any;
        const original = JSON.stringify(metadata);
        const models = getSuggestedModelModes('codex', metadata, translate);
        expect(models.map((model) => model.key)).toEqual(['gpt-6-sol', 'gpt-6-luna']);
        expect(models[0].description).toBe('Live description');
        expect(JSON.stringify(metadata)).toBe(original);
    });

    it('does not expand a catalog containing only GPT-6.1 Sol', () => {
        const metadata = { models: [{ code: 'gpt-6.1-sol', value: 'GPT-6.1 Sol' }] } as any;
        expect(getSuggestedModelModes('codex', metadata, translate).map((model) => model.key))
            .toEqual(['gpt-6.1-sol']);
    });

    it('leaves custom provider catalogs alone and uses current fallbacks without metadata', () => {
        const metadata = { models: [{ code: 'private-model', value: 'Private' }] } as any;
        for (const flavor of ['codex', 'gemini']) {
            expect(getSuggestedModelModes(flavor, metadata, translate))
                .toEqual(getAvailableModels(flavor, metadata, translate));
        }
        expect(getSuggestedModelModes('codex', null, translate)).toEqual(getCodexModelModes());
    });

    it.each(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna'])('does not inherit Astra-only efforts for %s', (model) => {
        const metadata = { thoughtLevels: [{ code: 'ultra', value: 'ultra' }] } as any;
        expect(getEffortLevelsForModel('codex', model, metadata).map((level) => level.key))
            .toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max']);
    });

    it('respects the live effort catalog when it belongs to the selected new model', () => {
        const metadata = {
            currentModelCode: 'gpt-6-sol',
            thoughtLevels: [{ code: 'high', value: 'High from catalog' }],
        } as any;
        expect(getEffortLevelsForModel('codex', 'gpt-6-sol', metadata)).toEqual([
            { key: 'default', name: 'default effort', description: null },
            { key: 'high', name: 'High from catalog', description: null },
        ]);
    });

    it('only exposes Gemini permission modes that the CLI accepts', () => {
        expect(getGeminiPermissionModes(translate).map((mode) => mode.key)).toEqual(['default', 'yolo']);
        expect(getAvailablePermissionModes('gemini', {
            operatingModes: [
                { code: 'auto_edit', value: 'Auto edit', description: null },
                { code: 'plan', value: 'Plan', description: null },
            ],
        } as any, translate).map((mode) => mode.key)).toEqual(['default', 'yolo']);
    });

    it('uses code defaults for agent defaults', () => {
        expect(getDefaultPermissionModeKey('claude')).toBe('bypassPermissions');
        expect(getDefaultModelKey('claude')).toBe('opus');
        expect(getDefaultEffortKey('claude')).toBe('medium');
        expect(getDefaultPermissionModeKey('codex')).toBe('yolo');
        expect(getDefaultModelKey('codex')).toBe('gpt-6.1-sol');
        expect(getDefaultEffortKey('codex')).toBe('medium');
    });


    it('prefers metadata models over hardcoded fallbacks', () => {
        const models = getAvailableModels('gemini', {
            models: [
                { code: 'custom-gemini', value: 'Gemini Custom', description: 'From metadata' },
            ],
        } as any, translate);

        expect(models).toEqual([
            { key: 'custom-gemini', name: 'Gemini Custom', description: 'From metadata' },
        ]);
    });

    it('offers concrete codex models without a default reset option', () => {
        const models = getAvailableModels('codex', {
            models: [
                { code: 'gpt-5.4', value: 'gpt-5.4', description: 'Latest' },
            ],
        } as any, translate);

        expect(models).toEqual([
            { key: 'gpt-5.4', name: 'gpt-5.4', description: 'Latest' },
        ]);
    });

    it('prefers metadata effort levels for codex when available', () => {
        const levels = getEffortLevelsForModel('codex', 'gpt-5.4', {
            thoughtLevels: [
                { code: 'minimal', value: 'minimal', description: 'Quickest' },
                { code: 'xhigh', value: 'xhigh', description: 'Deepest' },
            ],
        } as any);

        expect(levels).toEqual([
            { key: 'default', name: 'default effort', description: null },
            { key: 'minimal', name: 'minimal', description: 'Quickest' },
            { key: 'xhigh', name: 'xhigh', description: 'Deepest' },
        ]);
    });

    it('keeps codex permission modes hardcoded even when metadata modes exist', () => {
        const modes = getAvailablePermissionModes('codex', {
            operatingModes: [{ code: 'metadata-only', value: 'Metadata Mode', description: null }],
        } as any, translate);

        expect(modes.map((mode) => mode.key)).toEqual(['default', 'read-only', 'acceptEdits', 'safe-yolo', 'yolo']);
    });

    it('applies hacks to metadata-provided operating modes for custom ACP agents', () => {
        const modes = getAvailablePermissionModes('custom-acp', {
            operatingModes: [
                { code: 'build', value: 'build, build', description: 'Do build steps' },
                { code: 'plan', value: 'plan/plan', description: 'Plan first' },
            ],
        } as any, translate);

        expect(modes).toEqual([
            { key: 'build', name: 'Build', description: 'Do build steps' },
            { key: 'plan', name: 'Plan', description: 'Plan first' },
        ]);
    });

    it('resolves the first matching preferred key', () => {
        const options = [
            { key: 'a', name: 'A' },
            { key: 'b', name: 'B' },
        ];

        expect(resolveCurrentOption(options, ['missing', 'b', 'a'])).toEqual({ key: 'b', name: 'B' });
        expect(resolveCurrentOption(options, ['missing'])).toBeNull();
    });
});


describe('Antigravity connection catalog', () => {
    it('uses the default before discovery and the live model catalog afterwards', () => {
        const translate = (key: string) => key;
        expect(getAvailableModels('antigravity', null, translate).map(option => option.key)).toEqual(['default']);
        const metadata = {
            models: [{ code: 'gemini-4-neon', value: 'Gemini 4 Neon' }],
        };
        expect(getAvailableModels('antigravity', metadata as any, translate).map(option => option.key)).toEqual(['gemini-4-neon']);
    });
});
