import * as React from 'react';
import { t } from '@/text';
import { View, Text, Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { subscribeWebStorage, getWebStorageStatus, retryWebStorageWrites, downloadWebStorageRecovery } from './deviceStorage.web';
/** A write in memory is never presented as a saved draft. This surface is
 * outside individual editors so navigation cannot hide an unsaved record. */
export function WebStorageStatus() {
    const state = React.useSyncExternalStore(subscribeWebStorage, getWebStorageStatus, getWebStorageStatus);
    const { theme } = useUnistyles();
    if (!state.failed && !state.pending && !state.recovery && !state.externalUpdates) return null;
    const action = (title: string, run: () => Promise<unknown>) => <Pressable accessibilityRole="button" onPress={() => { void run().catch(() => {}); }} style={{ padding: 8, backgroundColor: theme.colors.surface }}><Text style={{ color: theme.colors.textLink }}>{title}</Text></Pressable>;
    return <View accessibilityRole="alert" style={{ padding: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, backgroundColor: theme.colors.surfaceHigh }}>
        <Text style={{ color: state.failed ? theme.colors.textDestructive : theme.colors.textSecondary }}>
            {state.failed ? (state.conflict ? t('webStorage.conflict') : t('webStorage.failed')) : state.pending ? t('webStorage.saving') : state.recovery ? t('webStorage.recovery') : t('webStorage.externalUpdates')}
        </Text>
        {!!state.externalUpdates && !state.failed && !state.pending && action(t('webStorage.reload'), async () => { window.location.reload(); })}
        {!!state.failed && !state.conflict && action(t('webStorage.retry'), retryWebStorageWrites)}
        {!!(state.failed || state.recovery) && action(t('webStorage.export'), async () => { if (window.confirm(t('webStorage.privateExport'))) await downloadWebStorageRecovery(); })}
    </View>;
}
