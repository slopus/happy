import { parseToken } from '@/utils/parseToken';
import { rememberPartyReturn } from '@/components/agentParty/loginReturn';
import * as React from 'react';
import { View, Text, TextInput, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { connectAgentCatalog, type AgentProfile, type AgentInput, type Machine, type Directory } from '@/components/agentParty/api';
import { ROBOT_PRESETS } from '@/components/agentParty/robot-presets';

const models = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'];
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const empty = (): AgentInput => ({ name: '', instructions: '', engine: 'codex', avatarId: 0, model: 'gpt-5.6-luna', effort: 'low' });
type Catalog = Awaited<ReturnType<typeof connectAgentCatalog>>;
function Avatar({ index, size = 48 }: { index: number; size?: number }) {
    const source = ROBOT_PRESETS[index] ?? ROBOT_PRESETS[0];
    return <SvgXml xml={decodeURIComponent(source.slice(source.indexOf(',') + 1))} width={size} height={size}/>;
}
export default function AgentProfiles() {
    const { credentials } = useAuth();
    const router = useRouter();
    const { accountId } = useLocalSearchParams<{ accountId?: string }>();
    let mismatch = false;
    try { mismatch = !!accountId && (!credentials || parseToken(credentials.token) !== accountId); } catch { mismatch = true; }
    const { theme } = useUnistyles();
    const [catalog, setCatalog] = React.useState<Catalog | null>(null);
    const [agents, setAgents] = React.useState<AgentProfile[]>([]);
    const [machines, setMachines] = React.useState<Machine[]>([]);
    const [editing, setEditing] = React.useState<string | null>(null);
    const [draft, setDraft] = React.useState<AgentInput>(empty);
    const [avatars, setAvatars] = React.useState(false);
    const [listing, setListing] = React.useState<Directory | null>(null);
    const [browsing, setBrowsing] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState('');
    const [attempt, setAttempt] = React.useState(0);
    const browseEpoch = React.useRef(0);
    const text = { color: theme.colors.text, fontSize: 16 };
    const input = { ...text, padding: 12, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 10, backgroundColor: theme.colors.surface };
    React.useEffect(() => {
        const controller = new AbortController(); let client: Catalog | null = null;
        setCatalog(null); setAgents([]); setMachines([]); setEditing(null); setError('');
        if (credentials && !mismatch) void (async () => {
            client = await connectAgentCatalog(credentials, controller.signal);
            if (controller.signal.aborted) { client.close(); return; }
            const [profiles, devices] = await Promise.all([client.request<{ agents: AgentProfile[] }>('group-chat/agents'), client.request<{ machines: Machine[] }>('paws/machines')]);
            if (!controller.signal.aborted) { setAgents(profiles.agents); setMachines(devices.machines); setCatalog(client); }
        })().catch(error => { if (!controller.signal.aborted) setError(error.message); });
        return () => { controller.abort(); browseEpoch.current++; client?.close(); };
    }, [credentials, attempt, mismatch]);
    const button = (label: string, action: () => void, selected = false, disabled = false) => <Pressable key={label} accessibilityRole="button" accessibilityState={{ selected, disabled }} disabled={disabled} onPress={action} style={({ pressed }) => ({ minHeight: 44, padding: 12, borderRadius: 10, backgroundColor: selected ? theme.colors.surfaceSelected : pressed ? theme.colors.surfacePressed : theme.colors.surface })}><Text style={{ ...text, opacity: disabled ? 0.5 : 1 }}>{label}</Text></Pressable>;
    const browse = async (path?: string) => {
        if (!catalog || !draft.machineId) return;
        const epoch = ++browseEpoch.current; setBrowsing(true); setListing(null); setError('');
        try {
            const value = await catalog.request<Directory & { success: boolean; error?: string }>(`paws/machines/${encodeURIComponent(draft.machineId)}/directories${path ? `?path=${encodeURIComponent(path)}` : ''}`);
            if (epoch !== browseEpoch.current) return;
            if (!value.success) throw Error(value.error || '无法读取远端目录');
            setListing(value);
        } catch (error) { if (epoch === browseEpoch.current) setError((error as Error).message); }
        finally { if (epoch === browseEpoch.current) setBrowsing(false); }
    };
    const edit = (agent?: AgentProfile) => { browseEpoch.current++; setBrowsing(false); setListing(null); setAvatars(false); setError(''); setDraft(agent ? { ...agent } : empty()); setEditing(agent?.id ?? 'new'); };
    const save = async () => {
        if (!catalog || saving) return;
        setSaving(true); setError('');
        try {
            await catalog.request(`group-chat/agents${editing === 'new' ? '' : `/${encodeURIComponent(editing!)}`}`, { method: editing === 'new' ? 'POST' : 'PATCH', body: JSON.stringify(draft) });
            setAgents((await catalog.request<{ agents: AgentProfile[] }>('group-chat/agents')).agents); setEditing(null);
        } catch (error) { setError((error as Error).message); }
        finally { setSaving(false); }
    };
    if (!credentials) return <View style={{ padding: 24, gap: 16 }}><Text style={text}>登录 Paws 后，管理属于你的 Agent 配置。</Text>{button('登录或创建账号', () => { rememberPartyReturn('/agent-profiles', accountId); router.push('/'); })}</View>;
    if (mismatch) return <View style={{ padding: 24, gap: 16 }}><Text style={text}>此群聊使用的账号与当前 Paws 账号不同。请切换到群聊账号后管理 Agent。</Text>{button('选择 Paws 账号', () => { rememberPartyReturn('/agent-profiles', accountId); router.push('/accounts'); })}</View>;
    return <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1, backgroundColor: theme.colors.surface }} contentContainerStyle={{ padding: 20, gap: 16, maxWidth: 760, width: '100%', alignSelf: 'center', paddingBottom: 48 }}>
        <Text style={{ ...text, fontSize: 24, fontWeight: '600' }}>{editing ? editing === 'new' ? '创建 Agent' : '编辑 Agent' : '我的群聊 Agent'}</Text>
        <Text style={text}>在 Paws 配置一次，独立群聊网站登录同一账号即可选择。已有群聊保留邀请时的配置。</Text>
        {error ? <Text accessibilityRole="alert" style={text}>{error}</Text> : null}
        {!catalog ? <>{!error && <ActivityIndicator color={theme.colors.text}/>} {button('重新连接', () => setAttempt(value => value + 1))}</> : editing ? <>
            {button('返回 Agent 列表', () => { browseEpoch.current++; setEditing(null); }, false, saving)}
            <View style={{ flexDirection: 'row', gap: 16, alignItems: 'center' }}><Avatar index={draft.avatarId}/>{button('选择头像', () => setAvatars(value => !value), avatars, saving)}</View>
            {avatars && <View accessibilityLabel="24 款机器人头像" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{ROBOT_PRESETS.map((_, index) => <Pressable key={index} accessibilityRole="button" accessibilityLabel={`机器人头像 ${index + 1}`} accessibilityState={{ selected: draft.avatarId === index }} onPress={() => { setDraft(value => ({ ...value, avatarId: index })); setAvatars(false); }} style={({ pressed }) => ({ padding: 6, borderRadius: 10, backgroundColor: draft.avatarId === index ? theme.colors.surfaceSelected : pressed ? theme.colors.surfacePressed : theme.colors.surface })}><Avatar index={index}/></Pressable>)}</View>}
            <Text style={text}>Agent 名称</Text><TextInput accessibilityLabel="Agent 名称" editable={!saving} style={input} maxLength={40} value={draft.name} onChangeText={name => setDraft(value => ({ ...value, name }))}/>
            <Text style={text}>角色与关注点</Text><TextInput accessibilityLabel="角色与关注点" editable={!saving} style={[input, { minHeight: 100, textAlignVertical: 'top' }]} multiline maxLength={4000} value={draft.instructions} onChangeText={instructions => setDraft(value => ({ ...value, instructions }))}/>
            <Text style={text}>执行设备</Text>
            {machines.map(machine => button(`${machine.metadata?.displayName || machine.metadata?.host || machine.id}${machine.active ? '' : '（离线）'}`, () => { browseEpoch.current++; setListing(null); setBrowsing(false); setDraft(value => ({ ...value, machineId: machine.id, directory: undefined })); }, draft.machineId === machine.id, saving))}
            {!machines.length && <Text style={text}>暂无设备。可先保存角色，连接设备后再配置目录。</Text>}
            {draft.machineId && !machines.some(machine => machine.id === draft.machineId) && <Text style={text}>已保存设备暂不可用：{draft.machineId}</Text>}
            <Text style={text}>工作目录：{draft.directory || '尚未选择文件夹'}</Text>
            {button(browsing ? '读取目录…' : '选择远端文件夹', () => void browse(draft.directory), false, !draft.machineId || browsing || saving)}
            {listing && <View style={{ gap: 8, padding: 12, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 10 }}><Text style={text}>{listing.path}</Text>{listing.parent && button('↑ 上一级', () => void browse(listing.parent!))}{listing.directories.map(directory => button(`📁 ${directory.name}`, () => void browse(directory.path)))}{button('选择当前目录', () => { setDraft(value => ({ ...value, directory: listing.path })); setListing(null); })}</View>}
            <Text style={text}>Codex 模型</Text><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{Array.from(new Set([draft.model, ...models])).map(model => button(model, () => setDraft(value => ({ ...value, model })), draft.model === model, saving))}</View>
            <Text style={text}>思考强度</Text><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{efforts.map(effort => button(effort, () => setDraft(value => ({ ...value, effort })), draft.effort === effort, saving))}</View>
            {button(saving ? '保存中…' : '保存 Agent', () => void save(), true, saving || !draft.name.trim() || !draft.instructions.trim() || (!!draft.machineId && !draft.directory))}
        </> : <>
            {agents.map(agent => <Pressable key={agent.id} accessibilityRole="button" accessibilityLabel={`编辑 ${agent.name}`} onPress={() => edit(agent)} style={({ pressed }) => ({ padding: 16, borderRadius: 12, flexDirection: 'row', gap: 16, backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceSelected })}><Avatar index={agent.avatarId}/><View style={{ flex: 1, gap: 6 }}><Text style={{ ...text, fontWeight: '600' }}>{agent.name}</Text><Text style={text} numberOfLines={2}>{agent.instructions}</Text><Text style={text}>{agent.model} · {agent.effort}</Text></View></Pressable>)}
            {button('创建 Agent', () => edit(), true)}
            {button('前往独立群聊网站 ↗', () => router.push('/agent-party-access'))}
        </>}
    </ScrollView>;
}
