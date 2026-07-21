import { describe, expect, it } from 'vitest';
import { MetadataSchema } from './storageTypes';
import { rigMetadataFixture } from './__testdata__/rigMetadata';
import {
    getProviderIconKind,
    getRigActivityIndicators,
    getRigIdentity,
    getRigModels,
    getRigReasoningLevels,
    getRigSelectedModelKey,
    isRigMetadata,
    isRigModelSelectionEnabled,
    isRigPermissionSelectionEnabled,
    rigCanAbort,
    rigCanBrowseFiles,
    rigCanSearchFiles,
    rigCanUseShell,
    rigCanWriteFiles,
    usesControlledSessionUi,
} from './rig';

describe('Rig metadata', () => {
    it('recognizes Rig by client id rather than provider flavor', () => {
        expect(isRigMetadata(rigMetadataFixture)).toBe(true);
        expect(isRigMetadata({ ...rigMetadataFixture, client: { id: 'other', name: 'Other', version: '1' } })).toBe(false);
        expect(getRigIdentity(rigMetadataFixture)).toMatchObject({
            clientName: 'Rig',
            providerName: 'OpenAI Codex',
            modelName: 'GPT Shared',
        });
        expect(usesControlledSessionUi(rigMetadataFixture)).toBe(false);
    });

    it('maps known provider kinds and gives unknown providers a neutral fallback', () => {
        expect(['codex', 'claude', 'grok', 'kimi', 'custom'].map(getProviderIconKind)).toEqual([
            'codex', 'claude', 'grok', 'kimi', 'generic',
        ]);
    });

    it('keeps duplicate model ids distinct by provider', () => {
        const models = getRigModels(rigMetadataFixture);
        expect(models.map((model) => model.key)).toEqual(['codex:shared-model', 'claude:shared-model']);
        expect(getRigSelectedModelKey(rigMetadataFixture)).toBe('codex:shared-model');
    });

    it('recomputes reasoning levels from the selected provider-qualified model', () => {
        expect(getRigReasoningLevels(rigMetadataFixture, 'codex:shared-model')).toEqual(['low', 'medium', 'high']);
        expect(getRigReasoningLevels(rigMetadataFixture, 'claude:shared-model')).toEqual(['low', 'high', 'max']);
    });

    it('uses capabilities and advertised RPC methods together', () => {
        expect(rigCanAbort(rigMetadataFixture)).toBe(true);
        expect(rigCanBrowseFiles(rigMetadataFixture)).toBe(true);
        expect(rigCanWriteFiles(rigMetadataFixture)).toBe(true);
        expect(rigCanSearchFiles(rigMetadataFixture)).toBe(true);
        expect(rigCanUseShell(rigMetadataFixture)).toBe(true);

        const refreshed = {
            ...rigMetadataFixture,
            capabilities: {
                ...rigMetadataFixture.capabilities!,
                files: { ...rigMetadataFixture.capabilities!.files, write: false },
                rpcMethods: ['abort', 'bash', 'readFile'],
            },
        };
        expect(rigCanWriteFiles(refreshed)).toBe(false);
        expect(rigCanSearchFiles(refreshed)).toBe(false);
    });

    it('disables selectors immediately when Rig locks or removes a capability', () => {
        expect(isRigModelSelectionEnabled(rigMetadataFixture)).toBe(true);
        expect(isRigModelSelectionEnabled({
            ...rigMetadataFixture,
            session: { ...rigMetadataFixture.session!, modelLocked: true },
        })).toBe(false);
        expect(isRigPermissionSelectionEnabled({
            ...rigMetadataFixture,
            capabilities: { ...rigMetadataFixture.capabilities!, permissionModeSelection: false },
        })).toBe(false);
    });

    it('preserves activity metadata and derives only nonzero indicators', () => {
        const parsed = MetadataSchema.parse({ ...rigMetadataFixture, futureRigField: { retained: true } });
        expect(parsed.activity).toEqual(rigMetadataFixture.activity);
        expect((parsed as any).futureRigField).toEqual({ retained: true });
        expect(getRigActivityIndicators(parsed).map((item) => item.key)).toEqual([
            'subagents', 'workflows', 'processes', 'tasks',
        ]);
    });

    it('retains legacy metadata behavior when the Rig extension is absent', () => {
        const legacy = MetadataSchema.parse({ path: '/tmp/legacy', host: 'legacy', flavor: 'claude' });
        expect(isRigMetadata(legacy)).toBe(false);
        expect(rigCanWriteFiles(legacy)).toBe(true);

        const brandedBeforeV1 = MetadataSchema.parse({
            ...legacy,
            client: { id: 'rig', name: 'Rig', version: '0.9.0' },
        });
        expect(isRigMetadata(brandedBeforeV1)).toBe(true);
        expect(rigCanAbort(brandedBeforeV1)).toBe(true);
        expect(rigCanWriteFiles(brandedBeforeV1)).toBe(true);
    });
});
