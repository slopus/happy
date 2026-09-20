import { describe, expect, it } from 'vitest';
import { MetadataSchema } from './storageTypes';
import { rigMetadataFixture } from './__testdata__/rigMetadata';
import {
    getProviderIconKind,
    getRigActivityIndicators,
    getRigComposerState,
    getRigGitSummary,
    getRigIdentity,
    getRigModels,
    getRigReasoningLevels,
    getRigReasoningSelection,
    getRigSelectedModelKey,
    isRigMetadata,
    isRigModelSelectionEnabled,
    isRigPermissionSelectionEnabled,
    rigCanAbort,
    rigCanBrowseFiles,
    rigCanSearchFiles,
    rigCanUseShell,
    rigCanWriteFiles,
    rigSendsMessageReceipts,
    usesControlledSessionUi,
} from './rig';

describe('Rig metadata', () => {
    it('holds messages only when a Happy Agent daemon explicitly advertises receipts', () => {
        const supported = MetadataSchema.parse({
            ...rigMetadataFixture,
            capabilities: { ...rigMetadataFixture.capabilities!, messageReceipts: true },
        });
        expect(rigSendsMessageReceipts(supported)).toBe(true);
        expect(rigSendsMessageReceipts(rigMetadataFixture)).toBe(false);
        expect(rigSendsMessageReceipts({
            ...supported,
            capabilities: { ...supported.capabilities!, messageReceipts: false },
        })).toBe(false);
        expect(rigSendsMessageReceipts({
            ...supported,
            client: { id: 'other', name: 'Other', version: '1' },
        })).toBe(false);
        expect(rigSendsMessageReceipts(null)).toBe(false);
    });

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

    it('reads Git counts only from Rig metadata', () => {
        const git = {
            changedFiles: 7,
            insertions: 123,
            deletions: 45,
            countsExact: true,
        };
        const parsed = MetadataSchema.parse({ ...rigMetadataFixture, git });

        expect(getRigGitSummary(parsed)).toEqual(git);
        expect(getRigGitSummary({
            path: '/tmp/legacy',
            host: 'legacy',
            git,
        })).toBeNull();
    });

    it('initializes the composer from draft, then lastMode, then the deprecated display fields', () => {
        const lastMode = { providerId: 'claude', modelId: 'shared-model', effort: 'low', serviceTier: null, permissionMode: 'read_only' };
        const draft = { ...lastMode, providerId: 'codex', effort: 'medium', serviceTier: 'fast', permissionMode: 'full_access', text: '  keep  ' };

        const fromDraft = MetadataSchema.parse({ ...rigMetadataFixture, draft, draftUpdatedAt: 5, lastMode });
        expect(getRigComposerState(fromDraft)).toEqual({
            text: '  keep  ', modelMode: 'codex:shared-model', effortLevel: 'medium', permissionMode: 'full_access', serviceTier: 'fast',
        });
        expect(getRigSelectedModelKey(fromDraft)).toBe('codex:shared-model');
        expect(getRigReasoningSelection(fromDraft, 'codex:shared-model')).toBe('medium');

        const fromLastMode = MetadataSchema.parse({ ...rigMetadataFixture, draft: null, draftUpdatedAt: 6, lastMode });
        expect(getRigComposerState(fromLastMode)).toEqual({
            text: null, modelMode: 'claude:shared-model', effortLevel: 'low', permissionMode: 'read_only', serviceTier: null,
        });
        expect(getRigSelectedModelKey(fromLastMode)).toBe('claude:shared-model');
        expect(getRigReasoningSelection(fromLastMode, 'claude:shared-model')).toBe('low');

        // Never edited and never sent: the pickers fall through to the deprecated mirrors.
        const defaults = MetadataSchema.parse({ ...rigMetadataFixture, draft: null, draftUpdatedAt: null, lastMode: null });
        expect(getRigComposerState(defaults)).toEqual({
            text: null, modelMode: null, effortLevel: null, permissionMode: null, serviceTier: undefined,
        });
        expect(getRigSelectedModelKey(defaults)).toBe('codex:shared-model');
        expect(getRigReasoningSelection(defaults, 'codex:shared-model')).toBe('high');

        // A daemon that no longer publishes the deprecated nested selection still parses.
        const { permissionMode: _mode, ...session } = rigMetadataFixture.session!;
        expect(MetadataSchema.parse({ ...rigMetadataFixture, session }).session?.permissionMode).toBeUndefined();
        // A malformed draft degrades to "no draft" rather than failing the session.
        expect(MetadataSchema.parse({ ...rigMetadataFixture, draft: { text: 1 }, draftUpdatedAt: -1 })).toMatchObject({
            draft: undefined, draftUpdatedAt: undefined,
        });
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
