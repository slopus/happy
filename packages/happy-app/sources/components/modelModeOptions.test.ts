import { describe, expect, it } from 'vitest';
import {
    getAgyModelModes,
    getAvailableModels,
    getAvailablePermissionModes,
    getCodexModelModes,
    getClaudeModelModes,
    getClaudePermissionModes,
    getDefaultEffortKey,
    getDefaultModelKey,
    getDefaultPermissionModeKey,
    mapMetadataOptions,
    resolveCurrentOption,
} from './modelModeOptions';
import { rigMetadataFixture } from '@/sync/__testdata__/rigMetadata';

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
            'gpt-5.6-sol',
            'gpt-5.6-terra',
            'gpt-5.6-luna',
            'gpt-5.5',
            'gpt-5.4',
            'gpt-5.3-codex',
            'gpt-5.2-codex',
            'gpt-5.1-codex-max',
            'gpt-5.2',
            'gpt-5.1-codex-mini',
        ]);
        expect(models[0].name).toBe('default model');
        expect(models[1].name).toBe('gpt-5.6 sol');
    });

    it('builds claude model fallbacks with fable 5', () => {
        const models = getClaudeModelModes();
        expect(models.map((model) => model.key)).toEqual([
            'default',
            'opus',
            'fable',
            'sonnet',
            'haiku',
        ]);
        expect(models.find((model) => model.key === 'fable')).toEqual({
            key: 'fable',
            name: 'fable 5',
            description: null,
        });
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
        expect(modes.find((mode) => mode.key === 'safe-yolo')?.description).toBe('tr:agentInput.codexPermissionMode.safeYoloDescription');
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

    it('gives agy its own models, not the claude fallback', () => {
        const models = getAvailableModels('agy', null, translate);
        // must be agy's own list, not claude's opus/sonnet/haiku
        expect(models).toEqual(getAgyModelModes());
        const keys = models.map((m) => m.key);
        // the agentDefaults agy default must be selectable
        expect(keys).toContain('Gemini 3.1 Pro (High)');
        expect(getDefaultModelKey('agy')).toBe('Gemini 3.1 Pro (High)');
        // no 'default' entry — agy would receive the literal string "default" as --model
        expect(keys).not.toContain('default');
        // not the claude list
        expect(keys).not.toContain('opus');
        expect(keys).not.toContain('sonnet');
    });

    it('resolves the first matching preferred key', () => {
        const options = [
            { key: 'a', name: 'A' },
            { key: 'b', name: 'B' },
        ];

        expect(resolveCurrentOption(options, ['missing', 'b', 'a'])).toEqual({ key: 'b', name: 'B' });
        expect(resolveCurrentOption(options, ['missing'])).toBeNull();
    });

    it('builds the Rig catalog dynamically with provider-qualified keys', () => {
        const models = getAvailableModels('codex', rigMetadataFixture, translate);
        expect(models.map((model) => [model.key, model.name, model.providerName])).toEqual([
            ['codex:shared-model', 'GPT Shared', 'OpenAI Codex'],
            ['claude:shared-model', 'Claude Shared', 'Anthropic Claude'],
        ]);
        expect(models.some((model) => model.key === 'default')).toBe(false);
    });

    it('renders all native Rig permission codes and semantic kinds without flavor fallbacks', () => {
        const modes = getAvailablePermissionModes('codex', rigMetadataFixture, translate);
        expect(modes.map((mode) => [mode.key, mode.name, mode.semanticKind])).toEqual([
            ['auto', 'Auto', 'safe-yolo'],
            ['workspace_write', 'Workspace write', 'default'],
            ['read_only', 'Read only', 'read-only'],
            ['full_access', 'Full access', 'yolo'],
        ]);
    });

    it('shows a missing current Rig model as unavailable instead of selecting another model', () => {
        const metadata = {
            ...rigMetadataFixture,
            currentModelProviderId: 'custom-provider',
            currentModelCode: 'temporarily-missing',
        };
        const models = getAvailableModels('codex', metadata, translate);
        expect(models[0]).toMatchObject({
            key: 'custom-provider:temporarily-missing',
            unavailable: true,
            disabled: true,
        });
    });

    it('retains flavor-based catalogs before the Rig metadata extension', () => {
        const metadata = {
            path: '/tmp/rig',
            host: 'host',
            flavor: 'codex',
            client: { id: 'rig', name: 'Rig', version: '0.9.0' },
        } as any;

        expect(getAvailableModels('codex', metadata, translate)).toEqual(getCodexModelModes());
        expect(getAvailablePermissionModes('codex', metadata, translate).map((mode) => mode.key)).toEqual([
            'default', 'read-only', 'safe-yolo', 'yolo',
        ]);
    });
});
