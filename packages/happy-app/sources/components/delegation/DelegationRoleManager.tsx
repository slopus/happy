import * as React from 'react';
import { Pressable, Switch, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { DelegationRoleCreateInputSchema, type DelegationRole } from '@slopus/happy-wire';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Typography } from '@/constants/Typography';
import { useAllMachines, useAllSessions } from '@/sync/storage';
import type { Machine } from '@/sync/storageTypes';
import { getFirstSubmissionScope, subscribeFirstSubmissionScope } from '@/sync/firstSubmissionScope';
import { getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { createMachineDelegationRole, updateMachineDelegationRole, deleteMachineDelegationRole } from '@/sync/apiDelegation';
import { useMachineDelegationRoles } from '@/hooks/useMachineDelegationRoles';
import { useMagpieModelCatalog } from '@/hooks/useMagpieModelCatalog';
import { Modal } from '@/modal';
import { t } from '@/text';
import { CodingAgentIcon } from '@/components/codingAgents/CodingAgentIcon';

type Draft = { name: string; description: string; agent: 'codex' | 'antigravity'; model: string; effort: string; autoDelegate: boolean };
type DraftCache = { selectedId: string | null; drafts: Map<string | null, Draft> };
type Model = { code: string; value: string; supportedEffortLevels?: string[] };
const newDraft = (): Draft => ({ name: '', description: '', agent: 'antigravity', model: '', effort: '', autoDelegate: false });
const fromRole = (role: DelegationRole): Draft => ({ name: role.name, description: role.description, agent: role.agent,
    model: role.model ?? '', effort: role.effort ?? '', autoDelegate: role.autoDelegate });
const errorText = (failure: unknown) => failure instanceof Error ? failure.message : t('delegation.requestFailed');
const agentLabel = (agent: string) => agent === 'codex' ? 'Codex' : 'Antigravity';

/** Shared native/Web role settings; no active session and no task-dispatch action. */
export const DelegationRoleManager = React.memo(function DelegationRoleManager({ initialMachineId }: { initialMachineId?: string }) {
    const machines = useAllMachines({ includeOffline: true });
    const account = React.useSyncExternalStore(subscribeFirstSubmissionScope, getFirstSubmissionScope, getFirstSubmissionScope);
    const selection = getRuntimeAccountSelection();
    const owner = JSON.stringify([selection?.key, selection?.generation, selection?.serverUrl]);
    const caches = React.useMemo(() => new Map<string, DraftCache>(), [account, owner]);
    const [selectedId, setSelectedId] = React.useState<string | null>(initialMachineId ?? null);
    const [choosing, setChoosing] = React.useState(false);
    React.useEffect(() => { if (initialMachineId) setSelectedId(initialMachineId); }, [initialMachineId]);
    React.useEffect(() => {
        if (!selectedId && machines.length) setSelectedId(machines.find(machine => machine.active && machine.metadata?.delegationRoles === 1)?.id ?? machines[0].id);
    }, [selectedId, machines]);
    const machine = machines.find(item => item.id === selectedId);
    return <ItemList keyboardShouldPersistTaps="handled" testID="delegation-role-settings">
        <ItemGroup title={t('delegation.machine')} footer={t('delegation.saveOnlyHint')}>
            <Item title={machine?.metadata?.displayName ?? machine?.metadata?.host ?? t('delegation.chooseMachine')}
                subtitle={!machines.length ? t('delegation.noMachines') : machine && !machine.active ? t('delegation.offline') : undefined}
                onPress={() => setChoosing(value => !value)} aria-expanded={choosing} testID="delegation-machine-picker" />
            {choosing ? machines.map(item => <Item key={item.id} title={item.metadata?.displayName ?? item.metadata?.host ?? item.id}
                subtitle={!item.active ? t('delegation.offline') : item.metadata?.delegationRoles !== 1 ? t('delegation.rolesProtocolHint') : undefined}
                onPress={() => { setSelectedId(item.id); setChoosing(false); }} selected={item.id === selectedId}
                accessibilityRole="radio" aria-checked={item.id === selectedId} showChevron={false} testID={`delegation-machine-${item.id}`} />) : null}
        </ItemGroup>
        {machine && account ? <RoleEditor key={`${owner}:${machine.id}`} machine={machine} caches={caches} /> : null}
    </ItemList>;
});

const RoleEditor = React.memo(function RoleEditor({ machine, caches }: { machine: Machine; caches: Map<string, DraftCache> }) {
    const { theme } = useUnistyles();
    const machineReady = machine.active && machine.metadata?.delegationRoles === 1;
    const controller = useMachineDelegationRoles(machine.id, machineReady);
    const canManage = machineReady && controller.connected;
    const sessions = useAllSessions();
    const cache = React.useMemo(() => {
        let value = caches.get(machine.id);
        if (!value) { value = { selectedId: null, drafts: new Map() }; caches.set(machine.id, value); }
        return value;
    }, [caches, machine.id]);
    const [selectedId, setSelectedId] = React.useState(cache.selectedId);
    const [draft, setDraft] = React.useState<Draft>(() => cache.drafts.get(cache.selectedId) ?? newDraft());
    const [failure, setFailure] = React.useState<string | null>(null);
    const [notice, setNotice] = React.useState<string | null>(null);
    const [operation, setOperation] = React.useState<typeof controller.scope | null>(null);
    const [catalogOperation, setCatalogOperation] = React.useState<typeof controller.scope | null>(null);
    const [showModels, setShowModels] = React.useState(false);
    const scope = React.useRef<typeof controller.scope | null>(controller.scope);
    scope.current = controller.scope;
    React.useEffect(() => () => { scope.current = null; }, []);
    const busy = operation === controller.scope;
    const catalogBusy = catalogOperation === controller.scope;
    const current = (token: typeof controller.scope) => scope.current === token && controller.isCurrent();
    const saved = controller.roles.find(role => role.id === selectedId);
    const dirty = JSON.stringify(draft) !== JSON.stringify(saved ? fromRole(saved) : newDraft());
    const parsed = DelegationRoleCreateInputSchema.safeParse({ ...draft, model: draft.model.trim() || undefined, effort: draft.effort.trim() || undefined });
    const catalog = useMagpieModelCatalog(machine.id, machine.metadata?.homeDir ?? null,
        canManage && draft.agent === 'codex' && machine.metadata?.magpieModelCatalog === 1);
    const models = React.useMemo(() => {
        const known = new Map<string, Model>();
        for (const session of sessions) {
            if (session.metadata?.machineId !== machine.id || session.metadata.flavor !== draft.agent) continue;
            for (const model of session.metadata.models ?? []) if (!known.has(model.code)) known.set(model.code, model);
        }
        if (draft.agent === 'codex') for (const model of catalog.catalog?.models ?? []) known.set(model.code, model);
        return [...known.values()];
    }, [sessions, machine.id, draft.agent, catalog.catalog]);
    const model = models.find(item => item.code === draft.model);
    const edit = (patch: Partial<Draft>) => {
        const next = { ...draft, ...patch };
        cache.drafts.set(selectedId, next); setDraft(next); setNotice(null);
    };
    const choose = (roleId: string | null) => {
        cache.drafts.set(selectedId, draft); cache.selectedId = roleId;
        setSelectedId(roleId); setDraft(cache.drafts.get(roleId) ?? (controller.roles.find(role => role.id === roleId) ? fromRole(controller.roles.find(role => role.id === roleId)!) : newDraft()));
        setFailure(null); setNotice(null); setShowModels(false);
    };
    const save = async () => {
        if (busy || controller.loading || !canManage) return;
        if (!parsed.success) { setFailure(t('delegation.invalidRole')); return; }
        const token = controller.scope;
        setOperation(token); setFailure(null); setNotice(null);
        try {
            const result = selectedId === null
                ? await createMachineDelegationRole(machine.id, parsed.data)
                : await updateMachineDelegationRole(machine.id, selectedId, { ...parsed.data, model: parsed.data.model ?? null, effort: parsed.data.effort ?? null });
            if (!current(token)) return;
            controller.apply(result.roles);
            const next = fromRole(result.role);
            if (selectedId === null) cache.drafts.delete(null);
            cache.selectedId = result.role.id; cache.drafts.set(result.role.id, next);
            setSelectedId(result.role.id); setDraft(next); setNotice(t('delegation.saved'));
        } catch (error) { if (current(token)) setFailure(errorText(error)); }
        finally { if (current(token)) setOperation(null); }
    };
    const remove = async () => {
        if (busy || controller.loading || !canManage || !saved) return;
        const token = controller.scope;
        setOperation(token); setFailure(null); setNotice(null);
        try {
            const approved = await Modal.confirm(t('delegation.deleteTitle'), [t('delegation.deleteHint'), dirty ? t('delegation.discardOnDelete') : ''].filter(Boolean).join('\n\n'),
                { destructive: true, confirmText: t('common.delete') });
            if (!approved || !current(token)) return;
            const roles = await deleteMachineDelegationRole(machine.id, saved.id);
            if (!current(token)) return;
            controller.apply(roles); cache.drafts.delete(saved.id); cache.selectedId = null;
            setSelectedId(null); setDraft(cache.drafts.get(null) ?? newDraft()); setNotice(t('delegation.roleDeleted'));
        } catch (error) { if (current(token)) setFailure(errorText(error)); }
        finally { if (current(token)) setOperation(null); }
    };
    const refreshModels = async () => {
        if (catalogBusy || !canManage) return;
        const token = controller.scope; setCatalogOperation(token); setFailure(null);
        try { await catalog.refresh(); if (current(token)) setShowModels(true); }
        catch (error) { if (current(token)) setFailure(errorText(error)); }
        finally { if (current(token)) setCatalogOperation(null); }
    };
    return <>
        <ItemGroup title={t('delegation.rolesTitle')} footer={!machineReady ? machine.active ? t('delegation.rolesProtocolHint') : t('delegation.offline') : t('delegation.snapshotHint')}>
            {controller.roles.map(role => <Item key={role.id} title={role.name} subtitle={`${agentLabel(role.agent)} · ${role.model ?? t('delegation.nativeDefault')}`}
                icon={<CodingAgentIcon agent={role.agent} size={24} />} selected={selectedId === role.id} onPress={() => choose(role.id)} disabled={busy}
                testID={`delegation-settings-role-${role.id}`} />)}
            {!controller.loading && !controller.roles.length ? <Item title={t('delegation.noRoles')} showChevron={false} /> : null}
            <Item title={t('delegation.newRole')} icon={<Ionicons name="add-outline" size={24} color={theme.colors.text} />}
                onPress={() => choose(null)} disabled={busy} selected={selectedId === null} testID="delegation-settings-new" />
            <Item title={t('delegation.refresh')} loading={controller.loading} disabled={busy || controller.loading || !canManage} onPress={() => { setFailure(null); void controller.refresh(); }} showChevron={false} testID="delegation-settings-refresh" />
        </ItemGroup>
        {(failure ?? controller.error) ? <ItemGroup><Text style={styles.error} accessibilityRole="alert" testID="delegation-settings-error">{failure ?? controller.error}</Text></ItemGroup> : null}
        {notice ? <ItemGroup><Text style={styles.notice} testID="delegation-settings-notice">{notice}</Text></ItemGroup> : null}
        <ItemGroup title={selectedId === null ? t('delegation.newRole') : draft.name}>
            <Item title={t('delegation.roleId')} subtitle={selectedId === null ? t('delegation.idGenerated') : selectedId}
                copy={selectedId === null ? false : selectedId} showChevron={false} testID="delegation-settings-id" />
            <Field label={t('delegation.name')}><TextInput accessibilityLabel={t('delegation.name')} testID="delegation-settings-name" value={draft.name} onChangeText={name => edit({ name })} editable={!busy} maxLength={100} style={styles.input} /></Field>
            <Field label={t('delegation.description')}><TextInput accessibilityLabel={t('delegation.description')} testID="delegation-settings-description" value={draft.description} onChangeText={description => edit({ description })} editable={!busy} maxLength={10000} multiline style={[styles.input, styles.multiline]} /></Field>
            <View style={styles.choices} accessibilityRole="radiogroup" accessibilityLabel={t('delegation.agent')}>
                {(['codex', 'antigravity'] as const).map(agent => <Choice key={agent} label={agentLabel(agent)} selected={draft.agent === agent} disabled={busy}
                    onPress={() => { if (draft.agent !== agent) { edit({ agent, model: '', effort: '' }); setShowModels(false); } }} testID={`delegation-settings-agent-${agent}`} />)}
            </View>
            <Field label={`${t('delegation.model')} · ${t('common.optional')}`}><TextInput accessibilityLabel={t('delegation.model')} testID="delegation-settings-model" value={draft.model} placeholder={t('delegation.nativeDefault')} placeholderTextColor={theme.colors.textSecondary}
                onChangeText={value => edit({ model: value })} editable={!busy} autoCapitalize="none" autoCorrect={false} maxLength={256} style={styles.input} />
                <Text style={styles.hint}>{models.length ? t('delegation.catalogHint') : t('delegation.manualModelHint')}</Text>
                <View style={styles.choices}>{models.length ? <Choice label={t('delegation.chooseModel')} selected={showModels} disabled={busy} onPress={() => setShowModels(value => !value)} /> : null}
                    {draft.agent === 'codex' && machine.metadata?.magpieModelCatalog === 1 ? <Choice label={t('delegation.refreshModels')} disabled={busy || catalogBusy || !canManage} onPress={() => { void refreshModels(); }} testID="delegation-settings-model-refresh" /> : null}</View>
            </Field>
            {showModels ? <View accessibilityRole="radiogroup" accessibilityLabel={t('delegation.model')}>
                <Item title={t('delegation.nativeDefault')} selected={!draft.model} onPress={() => edit({ model: '', effort: '' })} disabled={busy} showChevron={false} />
                {models.map(option => <Item key={option.code} title={option.value} subtitle={option.code} selected={draft.model === option.code} onPress={() => edit({ model: option.code, effort: '' })}
                    disabled={busy} showChevron={false} testID={`delegation-model-${option.code}`} />)}</View> : null}
            <Field label={`${t('delegation.effort')} · ${t('common.optional')}`}><TextInput accessibilityLabel={t('delegation.effort')} testID="delegation-settings-effort" value={draft.effort} placeholder={t('delegation.nativeDefault')} placeholderTextColor={theme.colors.textSecondary}
                onChangeText={effort => edit({ effort })} editable={!busy} autoCapitalize="none" autoCorrect={false} maxLength={100} style={styles.input} />
                <View style={styles.choices}>{model?.supportedEffortLevels?.map(effort => <Choice key={effort} label={effort} selected={draft.effort === effort} onPress={() => edit({ effort })} disabled={busy} />)}</View>
                <Text style={styles.hint}>{t('delegation.defaultModelHint')}</Text>
            </Field>
            <View style={styles.toggle}><Text style={styles.toggleLabel}>{t('delegation.allowAutoSelect')}</Text><Switch accessibilityLabel={t('delegation.allowAutoSelect')} testID="delegation-settings-auto" value={draft.autoDelegate} onValueChange={autoDelegate => edit({ autoDelegate })} disabled={busy} /></View>
            <Item title={t('delegation.saveRole')} loading={busy} disabled={busy || controller.loading || !canManage} onPress={() => { void save(); }} showChevron={false} testID="delegation-settings-save" />
            {saved ? <Item title={t('common.delete')} destructive disabled={busy || controller.loading || !canManage} onPress={() => { void remove(); }} showChevron={false} testID="delegation-settings-delete" /> : null}
        </ItemGroup>
        {saved ? <ItemGroup title={t('delegation.callExample')}><Item title={t('delegation.useRolePrompt', { id: saved.id, name: saved.name })} copy={t('delegation.useRolePrompt', { id: saved.id, name: saved.name })} showChevron={false} testID="delegation-settings-example" /></ItemGroup> : null}
    </>;
});

function Field({ label, children }: React.PropsWithChildren<{ label: string }>) {
    return <View style={styles.field}><Text style={styles.label}>{label}</Text>{children}</View>;
}
function Choice({ label, selected, disabled, onPress, testID }: { label: string; selected?: boolean; disabled?: boolean; onPress: () => void; testID?: string }) {
    const [focused, setFocused] = React.useState(false);
    return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress} testID={testID}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={(state: { pressed: boolean; hovered?: boolean }) => [styles.choice, (state.pressed || state.hovered) && styles.pressed, selected && styles.selected, focused && styles.focused]}><Text style={styles.choiceText}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create(theme => ({
    field: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
    label: { ...Typography.default('regular'), color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18 },
    input: { ...Typography.default('regular'), color: theme.colors.text, borderColor: theme.colors.divider, borderWidth: 1, borderRadius: 8,
        backgroundColor: theme.colors.surfacePressed, paddingHorizontal: 12, paddingVertical: 10, minHeight: 44, fontSize: 14, lineHeight: 21 },
    multiline: { minHeight: 108, textAlignVertical: 'top' },
    hint: { ...Typography.default('regular'), color: theme.colors.textSecondary, fontSize: 12, lineHeight: 19 },
    error: { padding: 16, color: theme.colors.textDestructive, fontSize: 13, lineHeight: 20 },
    notice: { padding: 16, color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20 },
    choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
    choice: { borderColor: theme.colors.divider, borderWidth: 1, borderRadius: 7, paddingVertical: 8, paddingHorizontal: 11, backgroundColor: theme.colors.surface, minHeight: 36, justifyContent: 'center' },
    choiceText: { color: theme.colors.text, fontSize: 12 },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    selected: { backgroundColor: theme.colors.surfaceSelected },
    focused: { borderColor: theme.colors.textLink },
    toggle: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 },
    toggleLabel: { ...Typography.default('regular'), flex: 1, color: theme.colors.text, fontSize: 14, lineHeight: 21 },
}));
