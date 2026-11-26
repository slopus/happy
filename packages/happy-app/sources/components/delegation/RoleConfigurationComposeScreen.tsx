import * as React from 'react';
import { useRouter } from 'expo-router';
import { ComposeHome } from '@/components/ComposeHome';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { ComposeDraftProvider } from '@/sync/composeDraft';
import { NewSessionDraftProvider } from '@/hooks/useNewSessionDraft';
import { getFirstSubmissionScope, subscribeFirstSubmissionScope } from '@/sync/firstSubmissionScope';
import { readRoleConfiguration } from '@/sync/roleConfigurationHandoff';
import { getRoleConfigurationDraftStores } from './roleConfigurationDrafts';
import { t } from '@/text';

/** Each handoff owns its text/attachments and config controls. Returning to an
 * ordinary /new restores that screen's existing singleton draft unchanged. */
export const RoleConfigurationComposeScreen = React.memo(function RoleConfigurationComposeScreen({ reference }: { reference: string }) {
    const router = useRouter();
    const scope = React.useSyncExternalStore(subscribeFirstSubmissionScope, getFirstSubmissionScope, getFirstSubmissionScope);
    const record = readRoleConfiguration(reference);
    const stores = record && scope ? getRoleConfigurationDraftStores(record, scope) : null;
    if (!stores) return <ItemList><ItemGroup><Item title={t('delegation.configurationUnavailable')} showChevron={false} />
        <Item title={t('common.back')} onPress={() => router.back()} /></ItemGroup></ItemList>;
    return <NewSessionDraftProvider store={stores.config}><ComposeDraftProvider store={stores.compose}>
        <ComposeHome key={reference} variant="screen" roleConfigurationId={reference} />
    </ComposeDraftProvider></NewSessionDraftProvider>;
});
