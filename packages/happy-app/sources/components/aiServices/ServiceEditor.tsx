import * as React from 'react';
import { Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { CapabilityCatalog, ServiceConfig, ServiceGrant, ServiceTarget } from '@slopus/happy-wire';
import type { CodexAccountProfile } from '@/sync/apiCodexAccounts';
import { AIServiceAPIError, type AIServicesAPI, type AIServiceWorker, type ServiceSnapshot } from '@/sync/apiAIServices';
import { AuthorizationChoice, AuthorizationNotice, AuthorizationSection, authorizationStyles as styles } from '@/components/appAuthorization/AppAuthorizationLayout';
import { RoundButton } from '@/components/RoundButton';

export type ServiceMachine = { id: string; name: string };
export function sameTarget(a: ServiceTarget, b: ServiceTarget) {
    return a.machineId === b.machineId && a.engine === b.engine && a.accountRef.kind === b.accountRef.kind &&
        (a.accountRef.kind === 'codex-profile' && b.accountRef.kind === 'codex-profile' ? a.accountRef.id === b.accountRef.id :
            a.accountRef.kind === 'device-identity' && b.accountRef.kind === 'device-identity' && a.accountRef.identityId === b.accountRef.identityId);
}
export function targetOf(config: ServiceConfig): ServiceTarget {
    return { machineId: config.machineId, engine: config.engine, accountRef: config.accountRef } as ServiceTarget;
}
export function targetDescription(target: ServiceTarget, machines: ServiceMachine[], accounts: CodexAccountProfile[]) {
    const machine = machines.find(m => m.id === target.machineId)?.name ?? target.machineId;
    const ref = target.accountRef;
    const account = ref.kind === 'codex-profile' ? accounts.find(a => a.id === ref.id)?.displayName ?? ref.id : `本机登录 ${ref.identityId.slice(0, 19)}…`;
    return `${machine} · ${target.engine === 'codex' ? 'Codex' : 'Claude'} · ${account}`;
}
const editorStyles = StyleSheet.create(theme => ({ input: { color: theme.colors.text, backgroundColor: theme.colors.surface, borderColor: theme.colors.divider, borderWidth: 1, borderRadius: 12, padding: 14, fontSize: 16 } }));
export function ServiceEditor({ snapshot, api, workers, accounts, machines, grants, onSaved, onClose, onManageAccounts, onManageDevices }: {
    snapshot: ServiceSnapshot | null; api: AIServicesAPI; workers: AIServiceWorker[]; accounts: CodexAccountProfile[]; machines: ServiceMachine[]; grants: ServiceGrant[];
    onSaved: () => void | Promise<void>; onClose: () => void; onManageAccounts: () => void; onManageDevices: () => void;
}) {
    const { theme } = useUnistyles();
    const [name, setName] = React.useState(snapshot?.service.name ?? '');
    const [draft, setDraft] = React.useState<ServiceConfig | null>(snapshot?.revision.config ?? null);
    const [revision, setRevision] = React.useState(snapshot?.service.revision ?? 0);
    const [catalog, setCatalog] = React.useState<CapabilityCatalog | null>(null);
    const [catalogError, setCatalogError] = React.useState('');
    const [refresh, setRefresh] = React.useState(0);
    const [error, setError] = React.useState('');
    const [conflict, setConflict] = React.useState(false);
    const [confirmed, setConfirmed] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const lock = React.useRef(false);
    const targetKey = draft ? JSON.stringify(targetOf(draft)) : '';
    React.useEffect(() => {
        let live = true; setCatalog(null); setCatalogError('');
        if (draft) void api.capabilities(targetOf(draft)).then(result => { if (live && sameTarget(result.catalog, draft)) setCatalog(result.catalog); })
            .catch(e => { if (live) setCatalogError(e instanceof Error ? e.message : '读取能力失败。'); });
        return () => { live = false; };
    }, [api, targetKey, refresh]);
    const options: ServiceTarget[] = workers.flatMap<ServiceTarget>(worker => [
        ...accounts.filter(a => a.status !== 'invalid').map(a => ({ machineId: worker.machineId, engine: 'codex' as const, accountRef: { kind: 'codex-profile' as const, id: a.id } })),
        ...(worker.serviceClaudeIdentity && worker.serviceClaudeObservedAt ? [{ machineId: worker.machineId, engine: 'claude' as const, accountRef: { kind: 'device-identity' as const, machineId: worker.machineId, identityId: worker.serviceClaudeIdentity } }] : []),
    ]);
    if (draft && !options.some(t => sameTarget(t, draft))) options.unshift(targetOf(draft));
    const scopeChanged = !!draft && grants.some(g => g.revokedAt === null && (g.scope.expiresAt === null || g.scope.expiresAt > Date.now()) && !g.scope.targets.some(t => sameTarget(t, draft)));
    const model = catalog?.models.find(m => m.id === (draft?.modelId ?? catalog.defaultModelId));
    const valid = !!draft && !!catalog && sameTarget(catalog, draft) && catalog.availability === 'online' && !!model &&
        (draft.reasoning.mode === 'default' ? model.reasoning.supportsDefault : model.reasoning.values.includes(draft.reasoning.value));
    async function save() {
        if (!draft || !valid || (scopeChanged && !confirmed) || lock.current || conflict) return;
        lock.current = true; setBusy(true); setError('');
        try {
            if (snapshot) await api.update(snapshot.service.id, revision, draft);
            else await api.create(name.trim(), draft);
            await onSaved();
        } catch (e) {
            setConflict(e instanceof AIServiceAPIError && e.code === 'revision-conflict');
            setError(e instanceof Error ? e.message : '保存失败。输入已保留。');
        } finally { lock.current = false; setBusy(false); }
    }
    async function rebase() {
        if (!snapshot || lock.current) return;
        lock.current = true; setBusy(true);
        try {
            const latest = await api.read(snapshot.service.id); setRevision(latest.service.revision); setConflict(false);
            setError(`已读取版本 ${latest.service.revision}。服务器当前配置：${targetDescription(latest.revision.config, machines, accounts)}；模型 ${latest.revision.config.modelId ?? '原生默认'}。草稿已保留。请核对后保存。`);
        } catch (e) { setError(e instanceof Error ? e.message : '读取失败。'); }
        finally { lock.current = false; setBusy(false); }
    }
    return <View style={styles.section}>
        <Text style={styles.heading}>{snapshot ? `编辑 ${snapshot.service.name}` : '新建 AI 服务'}</Text>
        <Text style={styles.body}>默认配置仅影响新对话。原对话继续使用原绑定。账号凭据更新仍使用同一账号的最新版本。</Text>
        {!snapshot ? <TextInput accessibilityLabel="服务名称" placeholder="服务名称" placeholderTextColor={theme.colors.textSecondary} value={name} onChangeText={setName} maxLength={256} editable={!busy} style={editorStyles.input} /> : <Text style={styles.small}>当前编辑版本：{revision}</Text>}
        <AuthorizationSection title="设备、引擎与账号" hint="选择已有账号。此操作不会修改设备的默认账号。" radio>
            {options.map(target => <AuthorizationChoice key={JSON.stringify(target)} testID={`target-${target.engine}-${target.machineId}${target.accountRef.kind === 'codex-profile' ? `-${target.accountRef.id}` : ''}`}
                title={targetDescription(target, machines, accounts)} selected={!!draft && sameTarget(target, draft)} disabled={busy}
                onPress={() => { setDraft({ ...target, modelId: null, reasoning: { mode: 'default' } }); setConfirmed(false); }} />)}
            {!options.length ? <AuthorizationNotice title="暂无可用设备或账号" message="请先在设备环境中连接设备并完成账号登录，再刷新此页面。" /> : null}
        </AuthorizationSection>
        <View style={styles.actions}><RoundButton title="管理账号" display="inverted" onPress={onManageAccounts} /><RoundButton title="管理设备" display="inverted" onPress={onManageDevices} /></View>
        {draft ? <>
            <Text style={styles.small}>额度：{draft.engine === 'claude' ? '未知' : (() => { const accountId = draft.accountRef.kind === 'codex-profile' ? draft.accountRef.id : ''; const quota = accounts.find(a => a.id === accountId)?.quota; return quota?.state === 'current' && quota.remainingPercent !== null ? `${quota.remainingPercent}%` : '未知'; })()}</Text>
            {catalogError ? <AuthorizationNotice title="无法读取能力" message={catalogError} error /> : null}
            <RoundButton title="刷新能力目录" display="inverted" disabled={busy} onPress={() => setRefresh(n => n + 1)} />
            {!catalog && !catalogError ? <Text style={styles.body}>正在读取设备能力…</Text> : null}
            {catalog ? <>
                <AuthorizationSection title="模型" hint={catalog.completeness === 'limited' ? '能力信息有限。未验证的选项不可用。' : '使用设备当前返回的模型目录。'} radio>
                    <AuthorizationChoice title="原生默认" subtitle={catalog.defaultModelId ?? '默认模型未知，无法验证'} selected={draft.modelId === null} disabled={busy || !catalog.defaultModelId} onPress={() => setDraft({ ...draft, modelId: null, reasoning: { mode: 'default' } })} />
                    {catalog.models.map(m => <AuthorizationChoice key={m.id} testID={`model-${m.id}`} title={m.name} subtitle={m.id} selected={draft.modelId === m.id} disabled={busy} onPress={() => setDraft({ ...draft, modelId: m.id, reasoning: { mode: 'default' } })} />)}
                </AuthorizationSection>
                {model ? <AuthorizationSection title="思考设置" radio>
                    <AuthorizationChoice title="原生默认思考设置" selected={draft.reasoning.mode === 'default'} disabled={busy || !model.reasoning.supportsDefault} onPress={() => setDraft({ ...draft, reasoning: { mode: 'default' } })} />
                    {model.reasoning.values.map(value => <AuthorizationChoice key={value} title={value} selected={draft.reasoning.mode === 'explicit' && draft.reasoning.value === value} disabled={busy} onPress={() => setDraft({ ...draft, reasoning: { mode: 'explicit', value } })} />)}
                    <Text style={styles.small}>图片输入：{model.supportsImages ? '支持，仍需应用授权' : '未验证或不支持'}</Text>
                </AuthorizationSection> : <AuthorizationNotice title="当前模型未验证" message="请选择已验证的模型。无法保存未知默认模型。" />}
            </> : null}
        </> : null}
        {scopeChanged ? <AuthorizationSection title="需要补充授权" hint="部分应用未获授权使用此设备、账号或引擎。保存不会扩大这些应用的权限。">
            <AuthorizationChoice testID="confirm-new-scope" title="我会让受影响的应用重新发起授权" selected={confirmed} disabled={busy} onPress={() => setConfirmed(v => !v)} />
        </AuthorizationSection> : null}
        {error ? <AuthorizationNotice title={conflict ? '版本冲突' : '保存提示'} message={error} error={conflict} /> : null}
        {conflict ? <RoundButton title="读取最新版本并保留输入" disabled={busy} onPress={() => void rebase()} /> : null}
        <View style={styles.actions}>
            <RoundButton title="返回服务列表" display="inverted" disabled={busy} onPress={onClose} />
            <RoundButton title={snapshot ? '保存默认配置' : '创建服务'} disabled={busy || !valid || conflict || (!snapshot && !name.trim()) || (scopeChanged && !confirmed)} loading={busy} onPress={() => void save()} />
        </View>
    </View>;
}
