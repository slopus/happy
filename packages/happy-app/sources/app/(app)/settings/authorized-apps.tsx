import * as React from 'react';
import { Stack, useFocusEffect } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { Item } from '@/components/Item';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { AppAuthorizationLayout, AuthorizationNotice, authorizationStyles } from '@/components/appAuthorization/AppAuthorizationLayout';
import { Modal } from '@/modal';
import { useAllMachines } from '@/sync/storage';
import { appAuthorizationRequest, type AppAuthorizationGrant, isAppGrantActive } from '@/sync/apiAppDelegation';

export default function AuthorizedApps() {
    const { credentials } = useAuth();
    const { theme } = useUnistyles();
    const styles = authorizationStyles;
    const machines = useAllMachines({ includeOffline: true });
    const [grants, setGrants] = React.useState<AppAuthorizationGrant[]>([]);
    const [error, setError] = React.useState('');
    const [loaded, setLoaded] = React.useState(false);
    const [revokingId, setRevokingId] = React.useState<string | null>(null);
    const revokeLock = React.useRef(false);
    const refresh = React.useCallback(async () => {
        if (!credentials) return;
        try { const result = await appAuthorizationRequest<{ grants: AppAuthorizationGrant[] }>(credentials.token, ''); setGrants(result.grants); setError(''); setLoaded(true); }
        catch (e) { setError(e instanceof Error ? e.message : t('appAuthorization.loadFailed')); }
    }, [credentials]);
    useFocusEffect(React.useCallback(() => { void refresh(); }, [refresh]));
    const revoke = async (grant: AppAuthorizationGrant) => {
        if (!credentials || revokeLock.current) return;
        revokeLock.current = true;
        try {
            if (!await Modal.confirm(t('appAuthorization.revokeConfirmTitle'), t('appAuthorization.revokeConfirmMessage'), { confirmText: t('appAuthorization.revoke'), destructive: true })) return;
            setRevokingId(grant.id);
            await appAuthorizationRequest(credentials.token, `/${grant.id}`, undefined, 'DELETE');
            await refresh();
        } catch (e) { setError(e instanceof Error ? e.message : t('appAuthorization.revokeFailed')); }
        finally { revokeLock.current = false; setRevokingId(null); }
    };
    return <AppAuthorizationLayout><Stack.Screen options={{ title: t('appAuthorization.listTitle') }} />
        <Text style={styles.body}>{t('appAuthorization.listDescription')}</Text>
        {error ? <Item title={t('appAuthorization.retryHint')} subtitle={error} onPress={() => void refresh()} /> : null}
        {!loaded && !error ? <AuthorizationNotice title={t('appAuthorization.loading')} /> : null}
        {loaded && !grants.length ? <AuthorizationNotice title={t('appAuthorization.emptyTitle')} message={t('appAuthorization.emptyHint')} /> : null}
        {grants.map(grant => {
            const machine = machines.find(m => m.id === grant.machineId);
            const active = isAppGrantActive(grant);
            const isRevoking = revokingId === grant.id;
            return <View key={grant.id} style={styles.card} testID={`authorization-grant-${grant.id}`}>
                <View style={styles.row}>
                    <View style={styles.textColumn}>
                        <Text style={styles.title}>{grant.appId === 'relationship-advisor' ? t('appAuthorization.advisorName') : grant.appId}</Text>
                        {grant.appId === 'relationship-advisor' ? <Text style={styles.small}>advisor.paws.rodeo</Text> : null}
                    </View>
                    <Text style={[styles.status, active && styles.activeStatus]}>{t(active ? 'appAuthorization.active' : grant.state === 'revoked' ? 'appAuthorization.revoked' : 'appAuthorization.expired')}</Text>
                </View>
                <View style={styles.row}>
                    <Ionicons name="desktop-outline" size={20} color={theme.colors.textSecondary} />
                    <View style={styles.textColumn}>
                        <Text style={styles.body}>{machine?.metadata?.displayName || machine?.metadata?.host || grant.machineId || t('appAuthorization.deviceRemoved')}</Text>
                        <Text style={styles.small}>{t('appAuthorization.chatOnly')}</Text>
                        {active ? <Text style={styles.small}>{grant.expiresAt === null ? t('appConversations.permanent') : t('appAuthorization.expiresAt', { date: new Date(grant.expiresAt).toLocaleString() })}</Text> : null}
                    </View>
                </View>
                {active ? <><View style={styles.divider} /><Item title={t(isRevoking ? 'appAuthorization.revoking' : 'appAuthorization.revoke')}
                    onPress={() => void revoke(grant)} disabled={revokingId !== null} loading={isRevoking} destructive showChevron={false}
                    icon={<Ionicons name="unlink-outline" size={18} color={theme.colors.textDestructive} />}
                    style={{ paddingHorizontal: 0, paddingVertical: 6, minHeight: 40 }} /></> : null}
            </View>;
        })}
    </AppAuthorizationLayout>;
}
