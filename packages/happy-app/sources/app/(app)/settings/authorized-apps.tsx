import { t } from '@/text';
import * as React from 'react';
import { Stack, useFocusEffect } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { useAllMachines } from '@/sync/storage';
import { appAuthorizationRequest, type AppAuthorizationGrant, isAppGrantActive } from '@/sync/apiAppDelegation';

export default function AuthorizedApps() {
    const { credentials } = useAuth();
    const machines = useAllMachines({ includeOffline: true });
    const [grants, setGrants] = React.useState<AppAuthorizationGrant[]>([]);
    const [error, setError] = React.useState('');
    const [loaded, setLoaded] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const refresh = React.useCallback(async () => {
        if (!credentials) return;
        try { const result = await appAuthorizationRequest<{ grants: AppAuthorizationGrant[] }>(credentials.token, ''); setGrants(result.grants); setError(''); setLoaded(true); }
        catch (e) { setError(e instanceof Error ? e.message : '加载失败'); }
    }, [credentials]);
    useFocusEffect(React.useCallback(() => { void refresh(); }, [refresh]));
    const revoke = async (grant: AppAuthorizationGrant) => {
        if (!credentials || busy || !await Modal.confirm('撤销应用授权', '这将停止该连接正在运行的回答，并阻止它继续访问对话。', { confirmText: '撤销', destructive: true })) return;
        setBusy(true);
        try { await appAuthorizationRequest(credentials.token, `/${grant.id}`, undefined, 'DELETE'); await refresh(); }
        catch (e) { setError(e instanceof Error ? e.message : '撤销失败'); }
        finally { setBusy(false); }
    };
    return <ItemList><Stack.Screen options={{ title: '已授权应用' }} />
        {error ? <Item title="加载或操作失败，点此重试" subtitle={error} onPress={() => void refresh()} /> : null}
        {!loaded && !error ? <Item title="正在加载已授权应用…" showChevron={false} /> : null}
        {loaded && !grants.length ? <Item title="尚未授权任何应用" subtitle="从狗头军师的“连接我的 Paws”开始。" showChevron={false} /> : null}
        {grants.map(grant => {
            const machine = machines.find(m => m.id === grant.machineId);
            const active = isAppGrantActive(grant);
            return <ItemGroup key={grant.id} title={grant.appId === 'relationship-advisor' ? '狗头军师 · advisor.paws.rodeo' : grant.appId}>
                <Item title={machine?.metadata?.displayName || machine?.metadata?.host || grant.machineId || '设备已移除'} subtitle={`仅文字和图片对话 · ${active ? grant.expiresAt === null ? t('appConversations.permanent') : '有效至 ' + new Date(grant.expiresAt).toLocaleString() : grant.state === 'revoked' ? '已撤销' : '已过期'}`} showChevron={false} />
                {active ? <Item title={busy ? '正在处理…' : '撤销授权'} onPress={() => void revoke(grant)} disabled={busy} /> : null}
            </ItemGroup>;
        })}
    </ItemList>;
}
