import { createComposeDraftStore, registerComposeDraftAttachmentSource } from '@/sync/composeDraft';
import { createNewSessionDraftStore } from '@/hooks/useNewSessionDraft';
import { getFirstSubmissionScope, subscribeFirstSubmissionScope } from '@/sync/firstSubmissionScope';
import { roleConfigurationCurrent, updateRoleConfiguration, type RoleConfigurationHandoff } from '@/sync/roleConfigurationHandoff';

type Owner = NonNullable<ReturnType<typeof getFirstSubmissionScope>>;
type Entry = {
    revision: number;
    sourceFingerprint: string | undefined;
    compose: ReturnType<typeof createComposeDraftStore>;
    config: ReturnType<typeof createNewSessionDraftStore>;
};
let owner: Owner | null = null;
// One current revision per persisted handoff (the handoff store is bounded).
// File/blob references survive navigation, but never an account-scope change.
const drafts = new Map<string, Entry>();
subscribeFirstSubmissionScope(() => {
    if (getFirstSubmissionScope() !== owner) {
        drafts.clear();
        owner = null;
    }
});
registerComposeDraftAttachmentSource(() => Array.from(drafts.values()).some(entry => entry.compose.getState().images.length > 0));

export function getRoleConfigurationDraftStores(record: RoleConfigurationHandoff, scope: Owner) {
    if (!roleConfigurationCurrent(record, scope)) return null;
    if (owner !== scope) {
        drafts.clear();
        owner = scope;
    }
    const existing = drafts.get(record.id);
    if (existing?.revision === record.revision) return existing;
    const sourceFingerprint = record.draft ? JSON.stringify(record.draft) : undefined;
    const retainedImages = sourceFingerprint && existing?.sourceFingerprint === sourceFingerprint ? existing.compose.getState().images : [];
    const entry: Entry = {
        revision: record.revision, sourceFingerprint,
        compose: createComposeDraftStore({ text: record.input, discussing: record.discussing }, value => {
            if (roleConfigurationCurrent(record, scope)) updateRoleConfiguration(record.id, { input: value.text, discussing: value.discussing }, record.revision);
        }),
        config: createNewSessionDraftStore(record.config, config => {
            if (roleConfigurationCurrent(record, scope)) updateRoleConfiguration(record.id, { config }, record.revision);
        }),
    };
    if (retainedImages.length) entry.compose.getState().setImages(retainedImages);
    drafts.set(record.id, entry);
    return entry;
}
