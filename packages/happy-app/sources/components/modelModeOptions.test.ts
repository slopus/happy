import { describe, expect, it } from 'vitest';
import {
    filterPermissionModesForCli,
    modeSupportedByCli,
    permissionModeSupportedByCli,
    getAgyModelModes,
    getAgyPermissionModes,
    getAvailableModels,
    getAvailablePermissionModes,
    getCodexModelModes,
    getCodexPermissionModes,
    getClaudeModelModes,
    getClaudePermissionModes,
    getGeminiPermissionModes,
    getDefaultEffortKey,
    getDefaultModelKey,
    getEffortLevelsForModel,
    getDefaultPermissionModeKey,
    groupModelModesByProvider,
    includeConfiguredModel,
    getOpenClawPermissionModes,
    mapMetadataOptions,
    resolveCurrentOption,
} from './modelModeOptions';
import { sortPermissionModes } from '@/utils/permissionModeLabels';
import { rigMetadataFixture } from '@/sync/__testdata__/rigMetadata';

const translate = (key: string) => `tr:${key}`;

describe('modelModeOptions', () => {
    it('groups models by provider without sorting providers or rows', () => {
        const groups = groupModelModesByProvider([
            { key: 'codex:sol', name: 'Sol', providerId: 'codex', providerName: 'OpenAI Codex' },
            { key: 'claude:opus', name: 'Opus', providerId: 'claude', providerName: 'Anthropic Claude' },
            { key: 'codex:terra', name: 'Terra', providerId: 'codex', providerName: 'OpenAI Codex' },
        ]);

        expect(groups.map((group) => [
            group.key,
            group.title,
            group.models.map((model) => model.key),
        ])).toEqual([
            ['codex', 'OpenAI Codex', ['codex:sol', 'codex:terra']],
            ['claude', 'Anthropic Claude', ['claude:opus']],
        ]);
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

    it('names claude permission modes with one word each, most-used first', () => {
        const modes = getClaudePermissionModes(translate);
        expect(modes.map((mode) => [mode.key, mode.name])).toEqual([
            ['auto', 'Auto'],
            ['acceptEdits', 'Edits'],
            ['plan', 'Plan'],
            ['bypassPermissions', 'Yolo'],
            ['default', 'Default'],
        ]);
        expect(modes[0].description).toBe('tr:agentInput.permissionMode.auto');
    });

    // auto belongs to the Agent SDK's own PermissionMode union and is carried
    // by MessageMetaSchema. dontAsk is in neither, so sending it fails
    // UserMessageSchema.safeParse and drops the whole prompt.
    it('offers auto and still drops dontAsk, which the CLI rejects', () => {
        const keys = getClaudePermissionModes(translate).map((mode) => mode.key);
        expect(keys).toContain('auto');
        expect(keys).not.toContain('dontAsk');
    });

    it('leads both shipped harnesses with Auto', () => {
        expect(getClaudePermissionModes(translate)[0].key).toBe('auto');
        expect(getCodexPermissionModes(translate)[0].key).toBe('auto');
    });

    it('never calls a harness default Auto, which is a reviewed mode and not a default', () => {
        const named = (modes: { key: string; name: string }[]) => modes.find((mode) => mode.key === 'default')?.name;
        expect(named(getClaudePermissionModes(translate))).toBe('Default');
        expect(named(getCodexPermissionModes(translate))).toBe('Default');
        expect(named(getAgyPermissionModes(translate))).toBe('Default');
        expect(named(getGeminiPermissionModes(translate))).toBe('Default');
    });

    // The hardcoded catalogs are written in order rather than sorted, so this
    // is what stops them drifting out of step with the rank table.
    it.each([
        ['claude', getClaudePermissionModes],
        ['codex', getCodexPermissionModes],
        ['gemini', getGeminiPermissionModes],
        ['openclaw', getOpenClawPermissionModes],
    ] as const)('lists %s modes in the shared rank order', (_flavor, build) => {
        const modes = build(translate);
        expect(modes.map((mode) => mode.key)).toEqual(sortPermissionModes(modes).map((mode) => mode.key));
    });

    it('leads agy with Default, the one harness where Default is the safe mode', () => {
        // Deliberately against the shared ranking: agy --print cannot prompt, so
        // its Default is the sandboxed launch default rather than "ask me first".
        expect(getAgyPermissionModes(translate).map((mode) => mode.key)).toEqual([
            'default',
            'bypassPermissions',
        ]);
        expect(getDefaultPermissionModeKey('agy')).toBe('default');
    });

    it('only offers gemini modes runGemini actually honours', () => {
        // auto_edit is absent from MessageMetaSchema and would drop the whole
        // message; plan passes the schema but runGemini ignores it.
        const keys = getGeminiPermissionModes(translate).map((mode) => mode.key);
        expect(keys).not.toContain('auto_edit');
        expect(keys).not.toContain('plan');
    });

    it('only offers the curated codex harness models, most capable first', () => {
        const models = getCodexModelModes();
        expect(models.map((model) => model.key)).toEqual([
            'gpt-6-astra',
            'gpt-5.6-sol',
            'gpt-5.6-terra',
            'gpt-5.6-luna',
        ]);
        expect(models[0].name).toBe('GPT-6 Astra');
    });

    it('adds a configured custom codex model without expanding the shared catalog', () => {
        const models = getCodexModelModes();
        const withCustom = includeConfiguredModel('codex', models, 'my-workspace-model');

        expect(withCustom.map((model) => model.key)).toEqual([
            'gpt-6-astra',
            'gpt-5.6-sol',
            'gpt-5.6-terra',
            'gpt-5.6-luna',
            'my-workspace-model',
        ]);
        expect(models).toHaveLength(4);
        expect(includeConfiguredModel('claude', models, 'my-workspace-model')).toBe(models);
    });

    it('only offers the current-generation claude models', () => {
        const models = getClaudeModelModes();
        expect(models.map((model) => model.key)).toEqual([
            'claude-fable-5-1',
            'claude-fable-5',
            'claude-opus-5',
            'claude-opus-5[1m]',
            'claude-sonnet-5',
        ]);
        expect(models.map((model) => model.name)).toEqual([
            'Fable 5.1',
            'Fable 5',
            'Opus 5',
            'Opus 5 [1M]',
            'Sonnet 5',
        ]);
        // No `default model` row, and no alias keys: an alias would silently
        // resolve to an older model than the row claims.
        expect(models.some((model) => model.key === 'default')).toBe(false);
        expect(models.some((model) => ['opus', 'sonnet', 'fable', 'haiku'].includes(model.key))).toBe(false);
    });

    it('offers every codex model the levels its own registry publishes', () => {
        // Straight from Codex's model registry: astra, sol, and terra publish
        // ultra, luna does not. The difference is the whole point of asking
        // per model rather than per flavor.
        expect(getEffortLevelsForModel('codex', 'gpt-6-astra').map((level) => level.key))
            .toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
        expect(getEffortLevelsForModel('codex', 'gpt-5.6-sol').map((level) => level.key))
            .toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
        expect(getEffortLevelsForModel('codex', 'gpt-5.6-terra').map((level) => level.key))
            .toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
        expect(getEffortLevelsForModel('codex', 'gpt-5.6-luna').map((level) => level.key))
            .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    });

    it('falls back to the conservative codex range for an unknown model', () => {
        const keys = getEffortLevelsForModel('codex', 'my-workspace-model').map((level) => level.key);
        expect(keys).toEqual(['low', 'medium', 'high', 'xhigh']);
    });

    it('offers claude the SDK effort union for every model', () => {
        // Claude's scale belongs to the SDK, not the model: an unreachable level
        // is silently downgraded, so every model gets the same list.
        for (const model of ['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5']) {
            const keys = getEffortLevelsForModel('claude', model).map((level) => level.key);
            expect(keys).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
            // Claude's floor is `low`; there is no off.
            expect(keys).not.toContain('off');
        }
    });

    it('uses code defaults for agent defaults', () => {
        expect(getDefaultPermissionModeKey('claude')).toBe('auto');
        expect(getDefaultModelKey('claude')).toBe('claude-opus-5');
        expect(getDefaultEffortKey('claude')).toBe('medium');
        expect(getDefaultPermissionModeKey('codex')).toBe('auto');
        expect(getDefaultModelKey('codex')).toBe('gpt-5.6-sol');
        expect(getDefaultEffortKey('codex')).toBe('medium');
        expect(getDefaultPermissionModeKey('agy')).toBe('default');
        expect(getDefaultModelKey('agy')).toBe('Gemini 3.8 Flash');
        expect(getDefaultEffortKey('agy')).toBe('medium');
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

        expect(modes.map((mode) => [mode.key, mode.name])).toEqual([
            ['auto', 'Auto'],
            ['safe-yolo', 'Workspace'],
            ['read-only', 'Read'],
            ['yolo', 'Yolo'],
            ['default', 'Default'],
        ]);
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
            { key: 'plan', name: 'Plan', description: 'Plan first' },
            { key: 'build', name: 'Build', description: 'Do build steps' },
        ]);
    });

    it('gives agy its own models, not the claude fallback', () => {
        const models = getAvailableModels('agy', null, translate);
        // must be agy's own list, not claude's opus/sonnet/haiku
        expect(models).toEqual(getAgyModelModes());
        const keys = models.map((m) => m.key);
        // the agentDefaults agy default must be selectable
        expect(keys).toContain('Gemini 3.8 Flash');
        expect(getDefaultModelKey('agy')).toBe('Gemini 3.8 Flash');
        expect(keys.filter((key) => key.startsWith('Gemini '))).toEqual(['Gemini 3.8 Flash']);
        expect(getEffortLevelsForModel('agy', 'Gemini 3.8 Flash').map((level) => level.key))
            .toEqual(['low', 'medium', 'high']);
        // no 'default' entry — agy would receive the literal string "default" as --model
        expect(keys).not.toContain('default');
        // not the claude list
        expect(keys).not.toContain('opus');
        expect(keys).not.toContain('sonnet');
    });

    it('keeps a saved legacy agy model selectable without restoring it to the catalog', () => {
        const models = getAvailableModels('agy', null, translate, 'Gemini 3.6 Flash (High)');

        expect(models.map((model) => model.key)).toEqual([
            ...getAgyModelModes().map((model) => model.key),
            'Gemini 3.6 Flash (High)',
        ]);
        expect(models.at(-1)?.description).toBe('saved model');
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

    it('renders all native Happy permission codes and semantic kinds without flavor fallbacks', () => {
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
        expect(models.at(-1)).toMatchObject({
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
            'auto', 'safe-yolo', 'read-only', 'yolo', 'default',
        ]);
    });

    // `auto` is tagged sinceCliVersion 1.2.1-beta.2. compareVersions cannot see
    // prerelease numbers, so beta.1 vs beta.2 is the case that matters most.
    // No version stays permissive: it means the client is not happy-cli.
    it('gates a tagged mode on the CLI version that has to parse it', () => {
        const auto = { sinceCliVersion: '1.2.1-beta.2' };
        expect(modeSupportedByCli(auto, '1.2.1-beta.2')).toBe(true);
        expect(modeSupportedByCli(auto, '1.2.1')).toBe(true);
        expect(modeSupportedByCli(auto, '1.3.0')).toBe(true);
        expect(modeSupportedByCli(auto, '1.2.1-beta.1')).toBe(false);
        expect(modeSupportedByCli(auto, '1.2.0')).toBe(false);
        expect(modeSupportedByCli(auto, '0.11.2')).toBe(false);
        expect(modeSupportedByCli(auto, undefined)).toBe(true);
        expect(modeSupportedByCli(auto, null)).toBe(true);
        // Build metadata is ignored, as semver requires.
        expect(modeSupportedByCli(auto, '1.2.1-beta.2+local')).toBe(true);
        expect(modeSupportedByCli(auto, '1.2.0+local')).toBe(false);
        // A present-but-mangled version hides tagged modes: more likely old than new.
        expect(modeSupportedByCli(auto, 'not-a-version')).toBe(false);
        // Untagged modes are offered to every CLI, however old.
        expect(modeSupportedByCli({}, '0.9.0')).toBe(true);
        expect(modeSupportedByCli({}, 'not-a-version')).toBe(true);
    });

    // The outbound-message side of the same gate: the send path asks this
    // before serializing a saved key, and refuses loudly on false rather than
    // substituting a different mode.
    it('answers whether the session CLI can parse a saved mode key', () => {
        expect(permissionModeSupportedByCli('auto', '1.2.1-beta.1')).toBe(false);
        expect(permissionModeSupportedByCli('auto', '1.2.0')).toBe(false);
        expect(permissionModeSupportedByCli('auto', '1.2.1-beta.2')).toBe(true);
        expect(permissionModeSupportedByCli('auto', undefined)).toBe(true);
        expect(permissionModeSupportedByCli('plan', '1.2.0')).toBe(true);
        expect(permissionModeSupportedByCli(undefined, '1.2.0')).toBe(true);
        expect(permissionModeSupportedByCli(null, '1.2.0')).toBe(true);
    });

    it('hides auto from session pickers when the session CLI is too old', () => {
        const oldCli = { path: '/tmp', host: 'host', version: '1.2.0' } as any;
        expect(getAvailablePermissionModes('claude', oldCli, translate).map((mode) => mode.key)).toEqual([
            'acceptEdits', 'plan', 'bypassPermissions', 'default',
        ]);
        expect(getAvailablePermissionModes('codex', oldCli, translate).map((mode) => mode.key)).toEqual([
            'safe-yolo', 'read-only', 'yolo', 'default',
        ]);
    });

    it('drops only auto when filtering for an old CLI, and nothing when new', () => {
        const modes = getClaudePermissionModes(translate);
        expect(filterPermissionModesForCli(modes, '1.2.0').map((mode) => mode.key)).toEqual([
            'acceptEdits', 'plan', 'bypassPermissions', 'default',
        ]);
        expect(filterPermissionModesForCli(modes, '1.2.1-beta.2')).toEqual(modes);
        expect(filterPermissionModesForCli(modes, undefined)).toEqual(modes);
    });
});
