import * as React from 'react';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { Text, View } from 'react-native';
import type { AppPolicy, ServiceGrant } from '@slopus/happy-wire';
import { useAuth } from '@/auth/AuthContext';
import { t } from '@/text';
import { AppAuthorizationLayout, AuthorizationNotice, authorizationStyles as styles } from '@/components/appAuthorization/AppAuthorizationLayout';
import { Modal } from '@/modal';
import { RoundButton } from '@/components/RoundButton';
import { useAllMachines } from '@/sync/storage';
import { createAIServicesAPI, type ServiceSnapshot, type AIServiceWorker } from '@/sync/apiAIServices';
import { listCodexAccounts, type CodexAccountProfile } from '@/sync/apiCodexAccounts';
import { ServiceEditor, targetDescription } from '@/components/aiServices/ServiceEditor';

type Directory = { grants: ServiceGrant[]; services: ServiceSnapshot[]; apps: AppPolicy[]; workers: AIServiceWorker[]; accounts: CodexAccountProfile[] };

export default function AuthorizedApps() {
    const { credentials } = useAuth();
    const token = credentials?.token;
    const router = useRouter();
    const api = React.useMemo(() => token ? createAIServicesAPI(token) : null, [token]);
    const machines = useAllMachines({ includeOffline: true }).map(m => ({ id: m.id, name: m.metadata?.displayName || m.metadata?.host || m.id }));
    const [snapshot, setSnapshot] = React.useState<{ token: string; data: Directory } | null>(null);
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [editing, setEditing] = React.useState<string | null>(null);
    const [revision, refresh] = React.useReducer(n => n + 1, 0);
    const lock = React.useRef(false);
    const [now, setNow] = React.useState(Date.now());
    const owner = React.useRef(token); owner.current = token;
    const data = snapshot && snapshot.token === token ? snapshot.data : null;
    useFocusEffect(React.useCallback(() => {
        let live = true;
        setError(''); setEditing(null); setSnapshot(null);
        if (!api || !credentials || !token) return;
        void Promise.allSettled([api.grants(), api.list(), api.workers(), listCodexAccounts(credentials)]).then(async ([g, s, w, a]) => {
            if (g.status === 'rejected') throw g.reason;
            const [serviceResults, appResults] = await Promise.all([
                Promise.allSettled((s.status === 'fulfilled' ? s.value.services : []).map(service => api.read(service.id))),
                Promise.allSettled([...new Set(g.value.grants.map(grant => grant.scope.appId))].map(id => api.application(id))),
            ]);
            const services = serviceResults.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
            const apps = appResults.flatMap(result => result.status === 'fulfilled' ? [result.value.app] : []);
            if (live) setSnapshot({ token, data: { grants: g.value.grants, services, apps,
                workers: w.status === 'fulfilled' ? w.value.workers : [], accounts: a.status === 'fulfilled' ? a.value.profiles : [] } });
        }).catch(e => { if (live) setError(e.message); });
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => { live = false; clearInterval(timer); };
    }, [api, token, revision]));
    const mutate = async (action: () => Promise<unknown>, confirm = false) => {
        if (lock.current || !token) return;
        lock.current = true;
        try {
            if (confirm && !await Modal.confirm(t('appAuthorization.revokeConfirmTitle'), t('appAuthorization.revokeConfirmMessage'), { confirmText: t('appAuthorization.revoke'), destructive: true })) return;
            if (owner.current !== token) return;
            setBusy(true); setError('');
            await action();
            if (owner.current === token) refresh();
        } catch (e) { if (owner.current === token) setError(e instanceof Error ? e.message : t('appAuthorization.revokeFailed')); }
        finally { lock.current = false; setBusy(false); }
    };
    const chosen = data?.services.find(s => s.service.id === editing);
    const manageDevices = () => router.push('/settings/device-environment' as never);
    return <AppAuthorizationLayout><Stack.Screen options={{ title: t('appAuthorization.listTitle') }} />
        <Text style={styles.body}>{t('connectedApps.connectionHint')}</Text>
        {error ? <><AuthorizationNotice title={t('appAuthorization.loadFailed')} message={error} error /><RoundButton title={t('appConversations.refresh')} onPress={refresh} /></> : null}
        {!data && !error ? <AuthorizationNotice title={t('connectedApps.loading')} /> : null}
        {data && chosen && api ? <>
            <Text style={styles.body}>{t('connectedApps.sharedDefaultsHint')}</Text>
            <ServiceEditor snapshot={chosen} api={api} workers={data.workers} accounts={data.accounts} machines={machines}
                grants={data.grants.filter(g => g.scope.serviceId === chosen.service.id)} onSaved={refresh} onClose={() => setEditing(null)} onManageAccounts={manageDevices} onManageDevices={manageDevices} />
        </> : data ? <>
            {!data.grants.length ? <AuthorizationNotice title={t('appAuthorization.emptyTitle')} message={t('connectedApps.emptyHint')} /> : null}
            {data.grants.map(grant => {
                const service = data.services.find(s => s.service.id === grant.scope.serviceId);
                const app = data.apps.find(a => a.appId === grant.scope.appId);
                const expired = grant.scope.expiresAt !== null && grant.scope.expiresAt <= now;
                const active = grant.revokedAt === null && !expired;
                return <View key={grant.id} style={styles.card} testID={`authorization-grant-${grant.id}`}>
                    <Text style={styles.title}>{app?.name ?? grant.scope.appId}</Text>
                    <Text style={styles.small}>{app?.origins.join('\n')}</Text>
                    <Text style={styles.body}>{t(grant.revokedAt !== null ? 'appAuthorization.revoked' : expired ? 'appAuthorization.expired' : service?.service.enabled === false ? 'connectedApps.disabled' : 'appAuthorization.active')}</Text>
                    {grant.scope.targets.map((target, index) => <Text key={index} style={styles.body}>{targetDescription(target, machines, data.accounts)}</Text>)}
                    <Text style={styles.small}>{grant.scope.permissions.map(p => t(p === 'images' ? 'connectedApps.images' : p === 'tools' ? 'connectedApps.tools' : 'connectedApps.chat')).join(' · ')}</Text>
                    <Text style={styles.small}>{grant.scope.expiresAt === null ? t('appConversations.permanent') : t('appAuthorization.expiresAt', { date: new Date(grant.scope.expiresAt).toLocaleString() })}</Text>
                    {service ? <>
                        <Text style={styles.small}>{t('connectedApps.defaultModel')}：{service.revision.config.modelId ?? t('connectedApps.nativeDefault')}</Text>
                        <Text style={styles.small}>{t('connectedApps.reasoning')}：{service.revision.config.reasoning.mode === 'default' ? t('connectedApps.nativeDefault') : service.revision.config.reasoning.value}</Text>
                        {active ? <RoundButton title={t('connectedApps.editConfiguration')} display="inverted" disabled={busy} onPress={() => setEditing(service.service.id)} /> : null}
                        {active && !service.service.enabled ? <RoundButton title={t('connectedApps.enable')} disabled={busy} onPress={() => void mutate(() => api!.metadata(service.service.id, service.service.revision, { enabled: true }))} /> : null}
                    </> : null}
                    {active ? <RoundButton title={t('appAuthorization.revoke')} display="inverted" disabled={busy} onPress={() => void mutate(() => api!.revoke(grant.id), true)} /> : null}
                </View>;
            })}
        </> : null}
    </AppAuthorizationLayout>;
}
