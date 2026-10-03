import * as React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { getRandomBytes } from 'expo-crypto';
import { useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { Ionicons } from '@expo/vector-icons';
import { t } from '@/text';
import { AppAuthorizationLayout, AuthorizationChoice, AuthorizationNotice, AuthorizationSection, authorizationStyles } from '@/components/appAuthorization/AppAuthorizationLayout';
import { RoundButton } from '@/components/RoundButton';
import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import { encryptBox } from '@/encryption/libsodium';
import { sync } from '@/sync/sync';
import { useAllMachines } from '@/sync/storage';
import { appAuthorizationRequest, type AppAuthorizationRequest } from '@/sync/apiAppDelegation';

export default function AuthorizeApp() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const { credentials } = useAuth();
    const machines = useAllMachines({ includeOffline: true });
    const { theme } = useUnistyles();
    const router = useRouter();
    const styles = authorizationStyles;
    const [request, setRequest] = React.useState<AppAuthorizationRequest | null>(null);
    const [workers, setWorkers] = React.useState<{ machineId: string; protocol?: number }[]>([]);
    const [selected, setSelected] = React.useState('');
    const [days, setDays] = React.useState<number | null>(1);
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [approved, setApproved] = React.useState(false);
    const lock = React.useRef(false);
    React.useEffect(() => {
        let disposed = false;
        setRequest(null); setSelected(''); setApproved(false); setWorkers([]); setError('');
        if (!credentials || !id || !/^[0-9a-f-]{36}$/.test(id)) { setError(t('appAuthorization.invalidRequest')); return; }
        void Promise.all([
            appAuthorizationRequest<AppAuthorizationRequest>(credentials.token, `/requests/${id}`),
            appAuthorizationRequest<{ workers: { machineId: string; protocol?: number }[] }>(credentials.token, '/workers'),
        ]).then(([data, available]) => { if (!disposed) { setRequest(data); setWorkers(available.workers); } }).catch(e => { if (!disposed) setError(e.message); });
        return () => { disposed = true; };
    }, [id, credentials]);
    const availableMachines = machines.filter(machine => workers.some(worker => worker.machineId === machine.id && (worker.protocol ?? 1) >= (request?.app.protocol ?? 1)));
    const selectedMachine = availableMachines.find(machine => machine.id === selected);
    const permanentAvailable = request?.supportsPermanent === true && workers.some(worker => worker.machineId === selected && (worker.protocol ?? 1) >= 2);
    const canApprove = !!selectedMachine && (days !== null || permanentAvailable);
    const approve = async () => {
        if (!request || request.id !== id || !credentials || !canApprove || lock.current) return;
        lock.current = true; setBusy(true); setError('');
        try {
            const encryption = sync.encryption.getMachineEncryption(selected);
            if (!encryption) throw new Error(t('appAuthorization.encryptionUnavailable'));
            const expiresAt = days === null ? null : new Date(Date.now() + days * 86400_000 - 30_000).toISOString();
            const envelope = { v: 1, grantId: request.id, appId: request.app.id, machineId: selected, scope: request.app.scope, ...(request.app.protocol >= 3 ? { protocol: 3 } : {}), expiresAt, key: encodeBase64(getRandomBytes(32)) };
            const appEnvelope = encodeBase64(encryptBox(new TextEncoder().encode(JSON.stringify(envelope)), decodeBase64(request.publicKey)));
            const machineEnvelope = await encryption.encryptRaw(envelope);
            await appAuthorizationRequest(credentials.token, `/requests/${request.id}/approve`, { machineId: selected, expiresAt, appEnvelope, machineEnvelope, ...(request.app.protocol >= 3 ? { protocol: 3 } : {}) });
            setApproved(true);
        } catch (e) { setError(e instanceof Error ? e.message : t('appAuthorization.authorizationFailed')); }
        finally { lock.current = false; setBusy(false); }
    };
    return <AppAuthorizationLayout>
        <Stack.Screen options={{ title: t('appAuthorization.authorizeTitle') }} />
        {error ? <AuthorizationNotice title={t('appAuthorization.unavailable')} message={error} error /> : null}
        {!request && !error ? <ActivityIndicator accessibilityLabel={t('appAuthorization.loading')} color={theme.colors.accent} /> : null}
        {approved ? <>
            <AuthorizationNotice title={t('appAuthorization.approvedTitle')} message={t('appAuthorization.approvedMessage')} />
            <Text style={styles.body}>{t('appAuthorization.approvedHint')}</Text>
            <RoundButton title={t('appAuthorization.viewAuthorizedApps')} style={styles.button} textStyle={styles.buttonText} onPress={() => router.replace('/settings/authorized-apps' as never)} />
        </> : request ? <>
            <View style={styles.card}>
                <View style={styles.row}>
                    <View style={styles.icon}><Ionicons name="shield-checkmark-outline" size={23} color={theme.colors.accent} /></View>
                    <View style={styles.textColumn}>
                        <Text style={styles.title}>{request.app.name}</Text>
                        <Text style={styles.small}>{request.app.origin}</Text>
                    </View>
                </View>
                <View style={styles.divider} />
                <View style={{ gap: 5 }}>
                    <Text style={styles.title}>{t('appAuthorization.scopeTitle')}</Text>
                    <Text style={styles.body}>{request.app.scope === 'agent:chat' ? t('appAuthorization.multiEngineScopeDescription') : t('appAuthorization.scopeDescription')}</Text>
                </View>
                <Text style={styles.small}>{t('appAuthorization.scanHint', { origin: request.app.origin })}</Text>
            </View>
            <AuthorizationSection title={t('appAuthorization.chooseDevice')} hint={t('appAuthorization.chooseDeviceHint')} radio>
                {availableMachines.map(machine => <AuthorizationChoice key={machine.id}
                    title={machine.metadata?.displayName || machine.metadata?.host || machine.id}
                    subtitle={selected === machine.id ? t('appAuthorization.selected') : t('appAuthorization.selectDevice')}
                    icon="desktop-outline" selected={selected === machine.id} disabled={busy}
                    onPress={() => setSelected(machine.id)} testID={`authorization-device-${machine.id}`} />)}
                {!availableMachines.length ? <AuthorizationNotice title={t('appAuthorization.noDevices')} message={t('appAuthorization.noDevicesHint')} /> : null}
            </AuthorizationSection>
            <AuthorizationSection title={t('appAuthorization.durationTitle')} radio>
                <View style={styles.actions}>
                    {[1, 7].map(value => <View key={value} style={styles.action}><AuthorizationChoice
                        title={t(value === 1 ? 'appAuthorization.oneDay' : 'appAuthorization.sevenDays')}
                        selected={days === value} disabled={busy} onPress={() => setDays(value)} testID={`authorization-days-${value}`} /></View>)}
                    {request.supportsPermanent ? <View style={styles.action}><AuthorizationChoice
                        title={t('appConversations.permanent')} subtitle={t('appConversations.permanentHint')}
                        selected={days === null} disabled={busy} onPress={() => setDays(null)} testID="authorization-days-permanent" /></View> : null}
                </View>
            </AuthorizationSection>
            <View style={styles.section}>
                <Text style={styles.small}>{t('appAuthorization.revocationHint')}</Text>
                <View style={styles.actions}>
                    <View style={styles.action}><RoundButton title={t('common.cancel')} display="inverted" disabled={busy} style={styles.secondaryButton} textStyle={styles.buttonText} onPress={() => router.back()} /></View>
                    <View style={styles.action}><RoundButton title={busy ? t('appAuthorization.authorizing') : t('appAuthorization.allowConnection')}
                        disabled={!canApprove || busy || request.id !== id} loading={busy} style={styles.button} textStyle={styles.buttonText} onPress={() => void approve()} /></View>
                </View>
                {!selectedMachine ? <Text style={styles.hint} accessibilityLiveRegion="polite">{t('appAuthorization.selectDeviceRequired')}</Text> : null}
                {selectedMachine && days === null && !permanentAvailable ? <Text style={styles.hint} accessibilityLiveRegion="polite">{t('appConversations.permanentUnavailable')}</Text> : null}
                {busy ? <Text style={styles.hint} accessibilityLiveRegion="polite">{t('appAuthorization.authorizing')}</Text> : null}
            </View>
        </> : null}
    </AppAuthorizationLayout>;
}
