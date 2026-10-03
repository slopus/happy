import * as React from 'react';
import { t } from '@/text';
import { ActivityIndicator, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { getRandomBytes } from 'expo-crypto';
import { useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
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
        if (!credentials || !id || !/^[0-9a-f-]{36}$/.test(id)) { setError('无效的应用授权请求'); return; }
        void Promise.all([
            appAuthorizationRequest<AppAuthorizationRequest>(credentials.token, `/requests/${id}`),
            appAuthorizationRequest<{ workers: { machineId: string; protocol?: number }[] }>(credentials.token, '/workers'),
        ]).then(([data, available]) => { if (!disposed) { setRequest(data); setWorkers(available.workers); } }).catch(e => { if (!disposed) setError(e.message); });
        return () => { disposed = true; };
    }, [id, credentials]);
    const permanentAvailable = request?.supportsPermanent === true && workers.some(worker => worker.machineId === selected && worker.protocol === 2);
    const canApprove = !!selected && (days !== null || permanentAvailable);
    const approve = async () => {
        if (!request || request.id !== id || !credentials || !canApprove || lock.current) return;
        lock.current = true; setBusy(true); setError('');
        try {
            const encryption = sync.encryption.getMachineEncryption(selected);
            if (!encryption) throw new Error('设备加密信息尚未加载，请稍后重试');
            const expiresAt = days === null ? null : new Date(Date.now() + days * 86400_000 - 30_000).toISOString();
            const envelope = { v: 1, grantId: request.id, appId: request.app.id, machineId: selected, scope: 'codex:chat', expiresAt, key: encodeBase64(getRandomBytes(32)) };
            const appEnvelope = encodeBase64(encryptBox(new TextEncoder().encode(JSON.stringify(envelope)), decodeBase64(request.publicKey)));
            const machineEnvelope = await encryption.encryptRaw(envelope);
            await appAuthorizationRequest(credentials.token, `/requests/${request.id}/approve`, { machineId: selected, expiresAt, appEnvelope, machineEnvelope });
            setApproved(true);
        } catch (e) { setError(e instanceof Error ? e.message : '授权失败，请重试'); }
        finally { lock.current = false; setBusy(false); }
    };
    return <ItemList>
        <Stack.Screen options={{ title: '授权应用' }} />
        {error ? <Item title="暂时无法授权" subtitle={error} showChevron={false} /> : null}
        {!request && !error ? <ActivityIndicator /> : null}
        {approved ? <ItemGroup title="已授权"><Item title="可以返回狗头军师继续" subtitle="你可以随时在设置 → 已授权应用中撤销访问。" showChevron={false} /><Item title="查看已授权应用" onPress={() => router.replace('/settings/authorized-apps' as never)} /></ItemGroup> : request ? <>
            <ItemGroup title="只扫描你自己在 advisor.paws.rodeo 打开的二维码">
                <Item title={request.app.name} subtitle={request.app.origin} showChevron={false} />
                <Item title="只允许该应用的文字和图片对话" subtitle="使用所选设备绑定的 Codex 账号。应用无法读取其他 Paws 对话、恢复码、本机文件，也不能执行命令。" showChevron={false} />
            </ItemGroup>
            <ItemGroup title="选择执行设备">
                {machines.filter(machine => workers.some(worker => worker.machineId === machine.id)).map(machine => <Item key={machine.id} title={machine.metadata?.displayName || machine.metadata?.host || machine.id} subtitle={selected === machine.id ? '已选择' : '使用此设备绑定的 Codex 账号'} onPress={() => setSelected(machine.id)} showChevron={false} />)}
                {!workers.length ? <Item title="没有可用设备" subtitle="请先在设置 → 设备环境绑定 Codex 账号，并在电脑上更新、启动支持应用授权的 Paws，随后重新打开此页面。" showChevron={false} /> : null}
            </ItemGroup>
            <ItemGroup title="授权有效期">{[1, 7].map(value => <Item key={value} title={`${value} 天`} subtitle={days === value ? '已选择' : undefined} onPress={() => setDays(value)} showChevron={false} />)}{request.supportsPermanent ? <Item title={t('appConversations.permanent')} subtitle={days === null ? '已选择' : t('appConversations.permanentHint')} onPress={() => setDays(null)} showChevron={false} /> : null}</ItemGroup>
            <View style={{ padding: 20, gap: 12 }}>
                <Text style={{ color: theme.colors.textSecondary }}>撤销后，新请求和后续回复立即被阻止；设备会在连接检查时停止正在生成的回答。已发出的内容无法收回。</Text>
                {!selected ? <Text style={{ color: theme.colors.textSecondary }}>{t('appConversations.selectDevice')}</Text> : days === null && !permanentAvailable ? <Text style={{ color: theme.colors.textSecondary }}>{t('appConversations.permanentUnavailable')}</Text> : null}
                <RoundButton title="允许连接" style={{ opacity: !canApprove || busy ? 0.5 : 1 }} disabled={!canApprove || busy || request.id !== id} loading={busy} onPress={() => void approve()} />
                <RoundButton title="取消" disabled={busy} onPress={() => router.back()} />
            </View>
        </> : null}
    </ItemList>;
}
