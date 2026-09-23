import { describe, expect, it } from 'vitest';

import {
    preferredModelKeys,
    preferredPermissionKeys,
    resolveComposerModelModes,
    resolveComposerPermissionModes,
    resolvePermissionStyle,
    resolveSelectedOption,
} from './newSessionModeSelection';
import { getClaudeModelModes } from '@/components/modelModeOptions';
import type { AgentCatalog } from './lastAgentCatalog';

const modes = [
    { key: 'default', name: 'Default' },
    { key: 'yolo', name: 'YOLO' },
];

const translate = ((key: string) => key) as (key: any) => string;

const catalog = (over: Partial<AgentCatalog> = {}): AgentCatalog => ({
    models: [
        { code: 'opencode/muse-spark', value: 'Muse Spark', description: null },
        { code: 'opencode/big-pickle', value: 'Big Pickle', description: null },
    ],
    operatingModes: [
        { code: 'build', value: 'Build', description: null },
        { code: 'plan', value: 'Plan', description: null },
    ],
    currentModelCode: 'opencode/big-pickle',
    currentOperatingModeCode: 'plan',
    ...over,
}) as AgentCatalog;

describe('new session mode selection', () => {
    it('resolves the indexed option and falls back to the first one', () => {
        expect(resolveSelectedOption(modes, 1)).toEqual({ key: 'yolo', name: 'YOLO' });
        expect(resolveSelectedOption(modes, 7)).toEqual({ key: 'default', name: 'Default' });
    });

    it('returns null when a Rig machine publishes no options at all', () => {
        // Rig machines with no `operatingModes` reach the composer with an
        // empty permission catalog; the screen must render without a pick.
        expect(resolveSelectedOption([], 0)).toBeNull();
        expect(resolveSelectedOption([], 3)).toBeNull();
    });

    it('has no permission accent without a selection or for the default mode', () => {
        expect(resolvePermissionStyle(null)).toBeNull();
        expect(resolvePermissionStyle(undefined)).toBeNull();
        expect(resolvePermissionStyle(resolveSelectedOption(modes, 0))).toBeNull();
        expect(resolvePermissionStyle(resolveSelectedOption([], 0))).toBeNull();
    });

    it('accents the permission modes that change agent behaviour', () => {
        expect(resolvePermissionStyle({ key: 'yolo' })?.color).toBe('#F87171');
        expect(resolvePermissionStyle({ key: 'plan' })?.icon).toBe('pause');
        expect(resolvePermissionStyle({ key: 'read-only' })?.icon).toBe('pause');
    });
});

describe('resolveComposerModelModes', () => {
    it('offers what the agent reported rather than the hardcoded fallback', () => {
        const models = resolveComposerModelModes({
            flavor: 'opencode',
            lastCatalog: catalog(),
            configuredModelKey: 'default',
            translate,
        });

        expect(models.map((model) => model.key)).toEqual(['opencode/muse-spark', 'opencode/big-pickle']);
    });

    it('falls back to the flavor list when nothing was reported', () => {
        const models = resolveComposerModelModes({
            flavor: 'opencode',
            lastCatalog: null,
            configuredModelKey: 'default',
            translate,
        });

        expect(models.map((model) => model.key)).toEqual(['default']);
    });

    it('treats an empty reported list as nothing reported', () => {
        // A session can exist and have published no catalog at all; an empty
        // array must not win over the fallback and leave an empty picker.
        const models = resolveComposerModelModes({
            flavor: 'claude',
            lastCatalog: catalog({ models: [] }),
            configuredModelKey: null,
            translate,
        });

        expect(models).toEqual(getClaudeModelModes());
    });
});

describe('resolveComposerPermissionModes', () => {
    it('offers the agent\'s own modes when it has reported them', () => {
        const modes = resolveComposerPermissionModes({
            flavor: 'opencode',
            lastCatalog: catalog(),
            happyCliVersion: '1.0.0',
            translate,
        });

        expect(modes.map((mode) => mode.key)).toEqual(['build', 'plan']);
    });

    it('filters the hardcoded fallback by CLI version, as before', () => {
        const modes = resolveComposerPermissionModes({
            flavor: 'claude',
            lastCatalog: null,
            happyCliVersion: '1.0.0',
            translate,
        });

        // `auto` is only parsed by a newer CLI, so an old one must not see it.
        expect(modes.map((mode) => mode.key)).not.toContain('auto');
    });
});

describe('preferredModelKeys', () => {
    it('lands on the model the agent itself considers current', () => {
        // `default` is not a key in a reported catalog, so without the
        // agent's current model the composer fell through to whichever model
        // happened to be listed first.
        expect(preferredModelKeys(null, catalog(), 'default')).toEqual([
            null,
            'opencode/big-pickle',
            'default',
        ]);
    });

    it('still lets an explicit saved pick win', () => {
        expect(preferredModelKeys('opencode/muse-spark', catalog(), 'default')[0])
            .toBe('opencode/muse-spark');
    });

    it('is inert when no catalog is known', () => {
        expect(preferredModelKeys(null, null, 'claude-opus-5')).toEqual([null, undefined, 'claude-opus-5']);
    });
});

describe('preferredPermissionKeys', () => {
    it('places the reported current mode between the saved pick and the defaults', () => {
        expect(preferredPermissionKeys(null, catalog(), 'default', 'auto')).toEqual([
            null,
            'plan',
            'default',
            'auto',
        ]);
    });
});
