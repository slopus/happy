import * as React from 'react';
import { Text, TextInput, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ExecutionBinding, ServiceGrant } from '@slopus/happy-wire';
import type { CodexAccountProfile } from '@/sync/apiCodexAccounts';
import type { ServiceRecentTurn, ServiceSnapshot } from '@/sync/apiAIServices';
import { AuthorizationChoice, AuthorizationNotice, AuthorizationSection, authorizationStyles as styles } from '@/components/appAuthorization/AppAuthorizationLayout';
import { RoundButton } from '@/components/RoundButton';
import { targetDescription, type ServiceMachine } from './ServiceEditor';

export function ServiceList({ services, selected, grants, apps, turns, bindings, machines, accounts, busy, onSelect, onCreate, onEdit, onMetadata, onRemove, onRevoke }: {
    services: ServiceSnapshot[]; selected: string; grants: ServiceGrant[]; apps: Record<string, string>; turns: ServiceRecentTurn[]; bindings: Record<string, ExecutionBinding>; machines: ServiceMachine[]; accounts: CodexAccountProfile[]; busy: boolean;
    onSelect: (id: string) => void; onCreate: () => void; onEdit: () => void; onMetadata: (metadata: { name?: string; enabled?: boolean }) => Promise<void>; onRemove: () => Promise<void>; onRevoke: (id: string) => Promise<void>;
}) {
    const { theme } = useUnistyles();
    const chosen = services.find(s => s.service.id === selected);
    const [rename, setRename] = React.useState<string | null>(null);
    const [remove, setRemove] = React.useState(false);
    const [revoke, setRevoke] = React.useState('');
    React.useEffect(() => { setRename(null); setRemove(false); setRevoke(''); }, [selected]);
    return <View style={styles.section}>
        <Text style={styles.heading}>AI 服务</Text>
        <Text style={styles.body}>统一管理设备、账号、模型和思考设置。默认值仅影响新对话。原对话继续使用原绑定。</Text>
        <AuthorizationSection title="我的服务" radio>
            {services.map(s => <AuthorizationChoice key={s.service.id} title={s.service.name} subtitle={`${s.service.enabled ? '已启用' : '已停用'} · ${targetDescription(s.revision.config, machines, accounts)}`} selected={selected === s.service.id} disabled={busy} onPress={() => onSelect(s.service.id)} />)}
            {!services.length ? <AuthorizationNotice title="尚无 AI 服务" message="使用已有账号和设备创建服务。已有直接 API 连接仍可使用。" /> : null}
        </AuthorizationSection>
        <RoundButton title="新建服务" disabled={busy} onPress={onCreate} />
        {chosen ? <>
            <View style={styles.card}>
                <Text style={styles.title}>{chosen.service.name}</Text>
                <Text style={styles.body}>{targetDescription(chosen.revision.config, machines, accounts)}</Text>
                <Text style={styles.body}>{`默认模型：${chosen.revision.config.modelId ?? '原生默认'}`}</Text>
                <Text style={styles.body}>{`默认思考设置：${chosen.revision.config.reasoning.mode === 'default' ? '原生默认' : chosen.revision.config.reasoning.value}`}</Text>
                <Text style={styles.small}>配置版本：{chosen.service.revision}</Text>
                {chosen.revision.config.engine === 'claude' ? <Text style={styles.small}>额度：未知</Text> : null}
                <View style={styles.actions}>
                    <RoundButton title="编辑默认配置" disabled={busy} onPress={onEdit} />
                    <RoundButton title={chosen.service.enabled ? '停用服务' : '启用服务'} display="inverted" disabled={busy} onPress={() => void onMetadata({ enabled: !chosen.service.enabled })} />
                    <RoundButton title="重命名" display="inverted" disabled={busy} onPress={() => setRename(chosen.service.name)} />
                </View>
                <Text style={styles.small}>停用后不能继续调用。已有绑定不会切换到其他服务。</Text>
                {rename !== null ? <>
                    <TextInput accessibilityLabel="新服务名称" value={rename} onChangeText={setRename} maxLength={256} editable={!busy} style={{ color: theme.colors.text, borderColor: theme.colors.divider, borderWidth: 1, padding: 12, borderRadius: 8 }} />
                    <RoundButton title="取消重命名" display="inverted" disabled={busy} onPress={() => setRename(null)} />
                    <RoundButton title="保存名称" disabled={busy || !rename.trim()} onPress={() => void onMetadata({ name: rename.trim() })} />
                </> : null}
                <RoundButton title="删除服务" display="inverted" disabled={busy} onPress={() => setRemove(true)} />
                {remove ? <><Text style={styles.body}>删除会停用此服务。依赖它的应用将无法继续调用。</Text><View style={styles.actions}><RoundButton title="取消删除" display="inverted" disabled={busy} onPress={() => setRemove(false)} /><RoundButton title="确认删除" disabled={busy} onPress={() => void onRemove()} /></View></> : null}
            </View>
            <AuthorizationSection title="应用引用与授权">
                {grants.map(g => <View key={g.id} style={styles.card}>
                    <Text style={styles.title}>{apps[g.scope.appId] ?? g.scope.appId}</Text>
                    <Text style={styles.body}>{g.kind === 'personal-grant' ? '个人通道' : '平台通道'} · {g.revokedAt !== null ? '已撤销' : g.scope.expiresAt !== null && g.scope.expiresAt <= Date.now() ? '已过期' : '有效'}</Text>
                    {g.scope.targets.map((target, index) => <Text key={index} style={styles.small}>{targetDescription(target, machines, accounts)}</Text>)}
                    <Text style={styles.small}>{`权限：${g.scope.permissions.includes('images') ? '文字问答、图片输入' : '文字问答'} · 到期：${g.scope.expiresAt === null ? '直到撤销' : new Date(g.scope.expiresAt).toLocaleString()}`}</Text>
                    {g.revokedAt === null ? <RoundButton title={revoke === g.id ? '确认撤销授权' : '撤销授权'} display="inverted" disabled={busy} onPress={() => { if (revoke === g.id) void onRevoke(g.id); else setRevoke(g.id); }} /> : null}
                    {revoke === g.id ? <Text style={styles.small}>撤销将阻止新调用。不能保证撤回上游已接受的任务。</Text> : null}
                </View>)}
                {!grants.length ? <Text style={styles.body}>暂无应用引用。</Text> : null}
            </AuthorizationSection>
            <AuthorizationSection title="最近调用" hint="最多显示 50 次调用。实际配置以设备报告为准。">
                {turns.map(turn => { const binding = bindings[turn.bindingId]; return <View key={turn.id} style={styles.card}>
                    <Text style={styles.title}>{turn.state} · {new Date(turn.createdAt).toLocaleString()}</Text>
                    {binding ? <><Text style={styles.small}>{apps[binding.appId] ?? binding.appId} · 绑定版本 {binding.revision}</Text><Text style={styles.small}>{targetDescription(binding, machines, accounts)}</Text><Text style={styles.body}>{`请求模型：${binding.requestedModel ?? '原生默认'}`}</Text><Text style={styles.body}>{`请求思考设置：${binding.reasoning.mode === 'default' ? '原生默认' : binding.reasoning.value}`}</Text></> : <Text style={styles.small}>绑定详情暂不可用。</Text>}
                    <Text style={styles.body}>{`实际模型：${turn.actual?.modelId ?? '未知'}`}</Text>
                    <Text style={styles.body}>{`实际思考设置：${turn.actual?.reasoning ?? '未知'}`}</Text>
                    {turn.serviceError ? <Text style={styles.small}>错误：{turn.serviceError.code}</Text> : null}
                </View>; })}
                {!turns.length ? <Text style={styles.body}>暂无调用。</Text> : null}
            </AuthorizationSection>
        </> : null}
    </View>;
}
