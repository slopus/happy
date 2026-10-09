import * as React from 'react';
import { ActivityIndicator } from 'react-native';
import { Stack, useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { t } from '@/text';
import { AppAuthorizationLayout, AuthorizationNotice, authorizationStyles } from '@/components/appAuthorization/AppAuthorizationLayout';
import { RoundButton } from '@/components/RoundButton';
import { useAllMachines } from '@/sync/storage';
import { appAuthorizationProtocol, sealServiceConsent } from '@/sync/apiAppDelegation';

import { createAIServicesAPI, type AIServiceWorker, type ServicePairing, type ServiceSnapshot } from '@/sync/apiAIServices';
import { listCodexAccounts, type CodexAccountProfile } from '@/sync/apiCodexAccounts';
import { ServiceConsent } from '@/components/aiServices/ServiceConsent';
import { createServiceAuthorizationLogin, serviceAuthorizationLoginParams } from '@/auth/serviceAuthorizationLogin';

export default function AuthorizeApp() {
    const { protocol, id } = useLocalSearchParams<{ protocol?: string; id: string }>();
    const kind = appAuthorizationProtocol(protocol);
    if (kind === 'unsupported') return <AppAuthorizationLayout><AuthorizationNotice title={t('connectedApps.unsupported')} message={t('connectedApps.reconnect')} error /></AppAuthorizationLayout>;
    return <AuthorizeService key={id} id={id} />;
}

function AuthorizeService({ id }: { id: string }) {
    const { credentials } = useAuth();
    const router = useRouter();
    const machines = useAllMachines({ includeOffline: true }).map(m => ({ id: m.id, name: m.metadata?.displayName || m.metadata?.host || m.id }));
    const api = React.useMemo(() => credentials ? createAIServicesAPI(credentials.token) : null, [credentials?.token]);
    const [data, setData] = React.useState<{ pairing: ServicePairing; services: ServiceSnapshot[]; workers: AIServiceWorker[]; accounts: CodexAccountProfile[] } | null>(null);
    const prepared = React.useRef<ServiceSnapshot | null>(null);
    const [error, setError] = React.useState('');
    React.useEffect(() => { prepared.current = null; }, [api, id]);
    useFocusEffect(React.useCallback(() => {
        let live = true; setData(null); setError('');
        if (!createServiceAuthorizationLogin(id)) { setError('授权链接无效。请回原应用重新连接。'); return; }
        if (!api || !credentials) return;
        void Promise.all([api.pairing(id), api.list().then(r => Promise.all(r.services.map(s => api.read(s.id)))), api.workers(), listCodexAccounts(credentials)])
            .then(([pairing, services, workers, accounts]) => { if (live) setData({ pairing, services, workers: workers.workers, accounts: accounts.profiles }); })
            .catch(e => { if (live) setError(e.message); });
        return () => { live = false; };
    }, [api, id]));
    return <AppAuthorizationLayout>
        <Stack.Screen options={{ title: t('appAuthorization.authorizeTitle') }} />
        {!credentials && !error ? <>
            <AuthorizationNotice title="登录 Paws 后确认授权" message="请登录已有的 Paws 账号。登录成功后会返回此授权请求，供你核对并确认。" />
            <RoundButton title="登录 Paws" style={authorizationStyles.button} textStyle={authorizationStyles.buttonText} onPress={() => {
                const intent = createServiceAuthorizationLogin(id);
                if (intent) router.push({ pathname: '/restore', params: serviceAuthorizationLoginParams(intent) } as never);
            }} />
            <RoundButton title="取消" display="inverted" onPress={() => router.replace('/')} />
        </> : null}
        {error ? <AuthorizationNotice title="无法读取授权请求" message={error} error /> : null}
        {credentials && !data && !error ? <ActivityIndicator accessibilityLabel="正在读取授权请求" /> : null}
        {data && api ? <ServiceConsent pairing={data.pairing} workers={data.workers} accounts={data.accounts} machines={machines} api={api}
            onManage={() => router.push('/settings/device-environment' as never)}
            onApprove={async (config, requestedScope) => {
                // Reuse only this application's identical configuration; never change another connection's defaults.
                const sameConfig = (value: ServiceSnapshot) => value.service.enabled && JSON.stringify(value.revision.config) === JSON.stringify(config);
                let service = prepared.current && sameConfig(prepared.current) ? prepared.current : null;
                if (!service) {
                    const { grants } = await api.grants();
                    const linked = new Set(grants.filter(g => g.scope.appId === data.pairing.app.appId).map(g => g.scope.serviceId));
                    service = data.services.find(s => linked.has(s.service.id) && sameConfig(s)) ?? null;
                    if (!service) {
                        const created = await api.create(data.pairing.app.name, config);
                        service = await api.read(created.service.id);
                    }
                    prepared.current = service;
                }
                const [latest, workers] = await Promise.all([api.read(service.service.id), api.workers()]);
                if (latest.service.revision !== service.service.revision || !sameConfig(latest)) {
                    prepared.current = null;
                    throw new Error(t('connectedApps.configurationChanged'));
                }
                const scope = { ...requestedScope, serviceId: latest.service.id };
                const envelopes = await sealServiceConsent({ pairing: data.pairing, service: latest.service, scope, workers: workers.workers });
                await api.approve(data.pairing.id, envelopes);
            }} /> : null}
    </AppAuthorizationLayout>;
}
