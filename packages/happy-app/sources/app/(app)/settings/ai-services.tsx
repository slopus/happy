import * as React from 'react';
import { ActivityIndicator } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { useAllMachines } from '@/sync/storage';
import { createAIServicesAPI, type ServiceSnapshot, type AIServiceWorker, type ServiceRecentTurn } from '@/sync/apiAIServices';
import { listCodexAccounts, type CodexAccountProfile } from '@/sync/apiCodexAccounts';
import type { ExecutionBinding, ServiceGrant } from '@slopus/happy-wire';
import { AppAuthorizationLayout, AuthorizationNotice } from '@/components/appAuthorization/AppAuthorizationLayout';
import { RoundButton } from '@/components/RoundButton';
import { ServiceList } from '@/components/aiServices/ServiceList';
import { ServiceEditor } from '@/components/aiServices/ServiceEditor';

export default function AIServicesSettings() {
    const { credentials } = useAuth();
    const router = useRouter();
    const machines = useAllMachines({ includeOffline: true }).map(m => ({ id: m.id, name: m.metadata?.displayName || m.metadata?.host || m.id }));
    const api = React.useMemo(() => credentials ? createAIServicesAPI(credentials.token) : null, [credentials?.token]);
    const [services, setServices] = React.useState<ServiceSnapshot[]>([]);
    const [workers, setWorkers] = React.useState<AIServiceWorker[]>([]);
    const [accounts, setAccounts] = React.useState<CodexAccountProfile[]>([]);
    const [selected, setSelected] = React.useState('');
    const [editor, setEditor] = React.useState<'new' | 'edit' | null>(null);
    const [grants, setGrants] = React.useState<ServiceGrant[]>([]);
    const [turns, setTurns] = React.useState<ServiceRecentTurn[]>([]);
    const [bindings, setBindings] = React.useState<Record<string, ExecutionBinding>>({});
    const [apps, setApps] = React.useState<Record<string, string>>({});
    const [error, setError] = React.useState('');
    const [loading, setLoading] = React.useState(true);
    const [detailsLoading, setDetailsLoading] = React.useState(false);
    const [detailsReady, setDetailsReady] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [generation, setGeneration] = React.useState(0);
    const operation = React.useRef(false);
    React.useEffect(() => {
        let live = true; setLoading(true); setError('');
        if (!api || !credentials) { setLoading(false); return; }
        void Promise.all([api.list().then(r => Promise.all(r.services.map(s => api.read(s.id)))), api.workers(), listCodexAccounts(credentials)]).then(([list, w, a]) => {
            if (!live) return; setServices(list); setWorkers(w.workers); setAccounts(a.profiles); setSelected(id => list.some(s => s.service.id === id) ? id : list[0]?.service.id ?? '');
        }).catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setLoading(false); });
        return () => { live = false; };
    }, [api, generation]);
    React.useEffect(() => {
        let live = true; setGrants([]); setTurns([]); setBindings({}); setApps({}); setDetailsReady('');
        if (!api || !selected) return;
        setDetailsLoading(true);
        void Promise.all([api.authorizations(selected), api.turns(selected)]).then(async ([g, t]) => {
            const [b, a] = await Promise.all([
                Promise.all([...new Set(t.turns.map(turn => turn.bindingId))].map(id => api.binding(id))),
                Promise.all([...new Set(g.grants.map(grant => grant.scope.appId))].map(id => api.application(id))),
            ]);
            if (!live) return;
            setGrants(g.grants); setTurns(t.turns); setBindings(Object.fromEntries(b.map(x => [x.binding.id, x.binding]))); setApps(Object.fromEntries(a.map(x => [x.app.appId, x.app.name]))); setDetailsReady(selected);
        }).catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setDetailsLoading(false); });
        return () => { live = false; };
    }, [api, selected, generation]);
    const chosen = services.find(s => s.service.id === selected);
    const refresh = () => setGeneration(n => n + 1);
    async function mutate(action: () => Promise<unknown>) {
        if (operation.current) return;
        operation.current = true; setBusy(true); setError('');
        try { await action(); refresh(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败。'); }
        finally { operation.current = false; setBusy(false); }
    }
    return <AppAuthorizationLayout>
        <Stack.Screen options={{ title: 'AI 服务' }} />
        {!credentials ? <AuthorizationNotice title="请先登录 Paws" /> : null}
        {error ? <AuthorizationNotice title="服务提示" message={error} error /> : null}
        {loading ? <ActivityIndicator accessibilityLabel="正在读取 AI 服务" /> : null}
        {api && !loading ? editor ? <ServiceEditor key={editor === 'new' ? 'new' : chosen?.service.id} snapshot={editor === 'new' ? null : chosen ?? null} api={api} workers={workers} accounts={accounts} machines={machines} grants={editor === 'new' ? [] : grants} onSaved={() => { setEditor(null); refresh(); }} onClose={() => setEditor(null)} onManageAccounts={() => router.push('/settings/device-environment' as never)} onManageDevices={() => router.push('/settings/device-environment' as never)} /> : <>
            {detailsLoading ? <ActivityIndicator accessibilityLabel="正在读取应用与调用" /> : null}
            <ServiceList services={services} selected={selected} grants={grants} apps={apps} turns={turns} bindings={bindings} machines={machines} accounts={accounts} busy={busy || detailsLoading || (!!chosen && detailsReady !== selected)} onSelect={setSelected} onCreate={() => setEditor('new')} onEdit={() => setEditor('edit')}
                onMetadata={metadata => mutate(() => api.metadata(selected, chosen!.service.revision, metadata))}
                onRemove={() => mutate(() => api.remove(selected, chosen!.service.revision))} onRevoke={id => mutate(() => api.revoke(id))} />
            <RoundButton title="刷新服务" display="inverted" disabled={busy} onPress={refresh} />
        </> : null}
    </AppAuthorizationLayout>;
}
