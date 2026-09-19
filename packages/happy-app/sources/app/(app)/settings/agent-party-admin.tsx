import * as React from 'react';
import { ActivityIndicator, ScrollView, Switch, Text, View } from 'react-native';
import { useAuth } from '@/auth/AuthContext';
import { getServerUrl } from '@/sync/serverConfig';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

type Policy = { enabled: boolean; tokenLimit: number | null; allowImages: boolean; allowAutoDebate: boolean; maxConcurrentVisitors: number };
type Dashboard = { visitors: { total: number; active24h: number }; usage: { estimatedTokens: number; note: string }; policy: Policy; guestExecutorReady: boolean };
const quotaOptions = [2_000, 20_000, 50_000, 200_000, null] as const;

function endpoint(path: string): string { return new URL(`/agent-party/api/admin/${path}`, getServerUrl()).toString(); }

export default function AgentPartyAdminScreen() {
    const { credentials } = useAuth();
    const { theme } = useUnistyles();
    const [dashboard, setDashboard] = React.useState<Dashboard | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const load = React.useCallback(async () => {
        if (!credentials) return;
        setLoading(true);
        try {
            const response = await fetch(endpoint('dashboard'), { headers: { Authorization: `Bearer ${credentials.token}` }, signal: AbortSignal.timeout(10_000) });
            if (!response.ok) throw new Error(response.status === 401 ? '当前 Paws 账号不是 AgentParty 管理员。' : '管理后台暂时不可用。');
            setDashboard(await response.json() as Dashboard); setError(null);
        } catch (cause) { setError((cause as Error).message); } finally { setLoading(false); }
    }, [credentials]);
    React.useEffect(() => { void load(); }, [load]);
    const update = async (patch: Partial<Policy>) => {
        if (!credentials || !dashboard || saving) return;
        const previous = dashboard;
        const optimistic = { ...dashboard, policy: { ...dashboard.policy, ...patch } };
        setDashboard(optimistic); setSaving(true);
        try {
            const response = await fetch(endpoint('policy'), { method: 'PATCH', headers: { Authorization: `Bearer ${credentials.token}`, 'content-type': 'application/json' }, body: JSON.stringify(optimistic.policy), signal: AbortSignal.timeout(10_000) });
            if (!response.ok) throw new Error('保存策略失败。');
            const saved = await response.json() as Policy;
            setDashboard(current => current ? { ...current, policy: saved } : current);
        } catch (cause) { setDashboard(previous); setError((cause as Error).message); } finally { setSaving(false); }
    };
    if (loading && !dashboard) return <View style={styles.center}><ActivityIndicator color={theme.colors.accent} /></View>;
    return <ScrollView contentContainerStyle={styles.content} refreshControl={undefined}><ItemGroup title="访问概览"><Item title="累计访客" detail={String(dashboard?.visitors.total ?? 0)} showChevron={false}/><Item title="近 24 小时访问" detail={String(dashboard?.visitors.active24h ?? 0)} showChevron={false}/><Item title="估算 Token" detail={(dashboard?.usage.estimatedTokens ?? 0).toLocaleString()} showChevron={false}/></ItemGroup><ItemGroup title="访客模式" footer={dashboard?.guestExecutorReady ? '访客执行器已配置。' : '访客执行器尚未配置。开启策略不会把访客请求发送到你的 Paws 设备、群聊或 Agent。'}><ToggleItem title="允许访客模式" value={dashboard?.policy.enabled ?? false} disabled={!dashboard || saving} onChange={value => void update({ enabled: value })}/><Item title="每位访客 Token 配额" subtitle="点按切换：2 千、2 万、5 万、20 万、不限额" detail={formatQuota(dashboard?.policy.tokenLimit ?? 200_000)} onPress={() => void update({ tokenLimit: nextQuota(dashboard?.policy.tokenLimit ?? 200_000) })}/><ToggleItem title="允许上传图片" value={dashboard?.policy.allowImages ?? false} disabled={!dashboard || saving} onChange={value => void update({ allowImages: value })}/><ToggleItem title="允许自动辩论" value={dashboard?.policy.allowAutoDebate ?? false} disabled={!dashboard || saving} onChange={value => void update({ allowAutoDebate: value })}/></ItemGroup><ItemGroup title="说明" footer={dashboard?.usage.note}><Item title="刷新管理数据" onPress={() => void load()} loading={loading}/></ItemGroup>{error && <Text style={[styles.error, { color: theme.colors.textDestructive }]}>{error}</Text>}</ScrollView>;
}

function formatQuota(value: number | null): string { return value === null ? '不限额' : `${value.toLocaleString()} Token`; }
function nextQuota(value: number | null): number | null {
    const index = quotaOptions.findIndex(option => option === value);
    return quotaOptions[(index + 1 + quotaOptions.length) % quotaOptions.length]!;
}
function ToggleItem({ title, value, disabled, onChange }: { title: string; value: boolean; disabled: boolean; onChange(value: boolean): void }) { const { theme } = useUnistyles(); return <Item title={title} rightElement={<Switch value={value} disabled={disabled} onValueChange={onChange} trackColor={{ true: theme.colors.accent }}/>} showChevron={false}/>; }
const styles = StyleSheet.create((theme) => ({ content: { paddingBottom: 32 }, center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surface }, error: { paddingHorizontal: 24, paddingTop: 8 } }));
