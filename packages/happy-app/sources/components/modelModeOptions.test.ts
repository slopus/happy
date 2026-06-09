import { describe, expect, it } from 'vitest';
import {
    getAvailableModels,
    getAvailablePermissionModes,
    getClaudeModelModes,
    getCodexModelModes,
    getClaudePermissionModes,
    getDefaultEffortKey,
    getDefaultModelKey,
    getDefaultPermissionModeKey,
    getEffortLevelsForModel,
    mapMetadataOptions,
    resolveCurrentOption,
} from './modelModeOptions';

const translate = (key: string) => `tr:${key}`;

describe('modelModeOptions', () => {
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

    it('builds claude model fallbacks including fable 5 and the 1M opus variant', () => {
        const models = getClaudeModelModes();
        expect(models.map((model) => model.key)).toEqual([
            'default',
            'claude-fable-5',
            'opus',
            'claude-opus-4-8[1m]',
            'sonnet',
            'haiku',
        ]);
        // Fable 5 and the 1M variant are new entries with no short alias, so the
        // picker sends the full model id; the CLI passes it through unchanged.
        expect(models.find((model) => model.key === 'claude-fable-5')?.name).toBe('fable 5');
        expect(models.find((model) => model.key === 'claude-opus-4-8[1m]')?.name).toBe('opus 4.8 (1M)');
    });

    it('gates claude effort levels per model', () => {
        const keys = (modelKey: string) => getEffortLevelsForModel('claude', modelKey).map((l) => l.key);
        // Fable 5 / Opus 4.8 (+ 1M variant) / the opus alias: full set incl. xhigh + max.
        expect(keys('claude-fable-5')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
        expect(keys('opus')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
        expect(keys('claude-opus-4-8[1m]')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
        // Sonnet 4.6 and Opus 4.6: max but no xhigh.
        expect(keys('sonnet')).toEqual(['low', 'medium', 'high', 'max']);
        expect(keys('claude-opus-4-6')).toEqual(['low', 'medium', 'high', 'max']);
        // Opus 4.5: neither xhigh nor max.
        expect(keys('claude-opus-4-5')).toEqual(['low', 'medium', 'high']);
        // Haiku exposes no effort parameter.
        expect(keys('haiku')).toEqual([]);
        // Unknown/custom models keep the full set (can't infer narrower support).
        expect(keys('some-gateway-model')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    });

    it('builds codex model fallbacks', () => {
        const models = getCodexModelModes();
        expect(models.map((model) => model.key)).toEqual([
            'default',
            'gpt-5.5',
            'gpt-5.4',
            'gpt-5.3-codex',
            'gpt-5.2-codex',
            'gpt-5.1-codex-max',
            'gpt-5.2',
            'gpt-5.1-codex-mini',
        ]);
        expect(models[0].name).toBe('default model');
        expect(models[1].name).toBe('gpt-5.5');
    });

    it('uses code defaults for agent defaults', () => {
        expect(getDefaultPermissionModeKey('claude')).toBe('bypassPermissions');
        expect(getDefaultModelKey('claude')).toBe('opus');
        expect(getDefaultEffortKey('claude')).toBe('medium');
        expect(getDefaultPermissionModeKey('codex')).toBe('yolo');
        expect(getDefaultModelKey('codex')).toBe('gpt-5.5');
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

    it('adds codex default model option when metadata models are present', () => {
        const models = getAvailableModels('codex', {
            models: [
                { code: 'gpt-5.4', value: 'gpt-5.4', description: 'Latest' },
            ],
        } as any, translate);

        expect(models).toEqual([
            { key: 'default', name: 'default model', description: null },
            { key: 'gpt-5.4', name: 'gpt-5.4', description: 'Latest' },
        ]);
    });

    it('keeps codex permission modes hardcoded even when metadata modes exist', () => {
        const modes = getAvailablePermissionModes('codex', {
            operatingModes: [{ code: 'metadata-only', value: 'Metadata Mode', description: null }],
        } as any, translate);

        expect(modes.map((mode) => mode.key)).toEqual(['default', 'read-only', 'safe-yolo', 'yolo']);
    });

    it('applies hacks to metadata-provided operating modes', () => {
        const modes = getAvailablePermissionModes('gemini', {
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
