import { describe, expect, it } from 'vitest';
import {
    getAvailableModels,
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
            'default',
            'gpt-6-astra',
            'gpt-5.6-sol',
            'gpt-5.6-terra',
            'gpt-5.6-luna',
            'gpt-5.5',
            'gpt-5.4',
            'gpt-5.4-mini',
            'gpt-5.3-codex-spark',
        ]);
        expect(models[0].name).toBe('default model');
        expect(models[1].name).toBe('gpt-6-astra');
        expect(models[2].name).toBe('gpt-5.6-sol');
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
        expect(getDefaultPermissionModeKey('ask')).toBe('default');
        expect(getDefaultModelKey('ask')).toBe('deepseek/deepseek-v4-flash');
        expect(getDefaultEffortKey('ask')).toBeNull();
        expect(getDefaultPermissionModeKey('codex')).toBe('yolo');
        expect(getDefaultModelKey('codex')).toBe('default');
        expect(getDefaultEffortKey('codex')).toBeNull();
    });

    it('keeps ask mode as provider-backed chat with DeepSeek strength choices', () => {
        const models = getAvailableModels('ask', null, translate);
        expect(models).toEqual([
            { key: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: 'fast answers' },
            { key: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', description: 'stronger answers' },
        ]);
        expect(getEffortLevelsForModel('ask', 'deepseek/deepseek-v4-pro')).toEqual([]);
        expect(getAvailablePermissionModes('ask', null, translate)).toEqual([
            { key: 'default', name: 'tr:agentInput.permissionMode.default', description: null },
        ]);
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

        expect(modes.map((mode) => mode.key)).toEqual(['default', 'read-only', 'safe-yolo', 'yolo']);
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
