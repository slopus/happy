import * as React from 'react';
import { Pressable, Switch, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import { randomUUID } from 'expo-crypto';
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
import type { RoleConfigurationRequest } from '@/sync/roleConfigurationHandoff';
import { openRoleConfiguration } from './roleConfigurationNavigation';
import { RoleModelPicker } from './RoleModelPicker';
import { Modal } from '@/modal';
import { t } from '@/text';
import { CodingAgentIcon } from '@/components/codingAgents/CodingAgentIcon';

type Draft = { name: string; description: string; agent: 'codex' | 'antigravity'; model: string; effort: string; autoDelegate: boolean };
type ViewName = 'list' | 'detail' | 'create' | 'edit';
type DraftCache = { selectedId: string | null; view: ViewName; step: 1 | 2; query: string; drafts: Map<string | null, Draft>; baselines: Map<string | null, string>; baseline: string; roles: DelegationRole[]; clientRoleId?: string };
type Model = { code: string; value: string; supportedEffortLevels?: string[] };
type Props = { initialMachineId?: string; initialRoleId?: string; onConfigureWithAI?: (request: RoleConfigurationRequest) => Promise<void> | void };
const newDraft = (): Draft => ({ name: '', description: '', agent: 'antigravity', model: '', effort: '', autoDelegate: false });
const fromRole = (role: DelegationRole): Draft => ({ name: role.name, description: role.description, agent: role.agent, model: role.model ?? '', effort: role.effort ?? '', autoDelegate: role.autoDelegate });
const errorText = (failure: unknown) => failure instanceof Error ? failure.message : t('delegation.requestFailed');
const agentLabel = (agent: string) => agent === 'codex' ? 'Codex' : 'Antigravity';
// Retain an unfinished settings form while visiting the ordinary conversation.
// This memory is deliberately limited to the current account incarnation.
let retained: { owner: string; machines: Map<string, DraftCache> } | undefined;
function accountCaches(owner: string) {
    if (retained?.owner !== owner) retained = { owner, machines: new Map() };
    return retained.machines;
}

/** Role management is separate from ordinary conversation-based configuration. */
export const DelegationRoleManager = React.memo(function DelegationRoleManager({ initialMachineId, initialRoleId, onConfigureWithAI }: Props) {
    const router = useRouter();
    const machines = useAllMachines({ includeOffline: true });
    const account = React.useSyncExternalStore(subscribeFirstSubmissionScope, getFirstSubmissionScope, getFirstSubmissionScope);
    const selection = getRuntimeAccountSelection();
    const owner = JSON.stringify([selection?.key, selection?.generation, selection?.serverUrl, !!account]);
    const caches = React.useMemo(() => accountCaches(owner), [owner]);
    const [selectedId, setSelectedId] = React.useState<string | null>(initialMachineId ?? null);
    const [choosing, setChoosing] = React.useState(false);
    React.useEffect(() => { if (initialMachineId) setSelectedId(initialMachineId); }, [initialMachineId]);
    React.useEffect(() => {
        if (!selectedId && machines.length) setSelectedId(machines.find(machine => machine.active && machine.metadata?.delegationRoles === 1)?.id ?? machines[0].id);
    }, [selectedId, machines]);
    const machine = machines.find(item => item.id === selectedId);
    const configure = onConfigureWithAI ?? ((request: RoleConfigurationRequest) => openRoleConfiguration(router, request));
    return <ItemList keyboardShouldPersistTaps="handled" testID="delegation-role-settings">
        <ItemGroup title={t('delegation.machine')}>
            <Item title={machine?.metadata?.displayName ?? machine?.metadata?.host ?? t('delegation.chooseMachine')}
                subtitle={!machines.length ? t('delegation.noMachines') : machine && !machine.active ? t('delegation.offline') : undefined}
                onPress={() => setChoosing(value => !value)} aria-expanded={choosing} testID="delegation-machine-picker" />
            {choosing ? machines.map(item => <Item key={item.id} title={item.metadata?.displayName ?? item.metadata?.host ?? item.id}
                subtitle={!item.active ? t('delegation.offline') : item.metadata?.delegationRoles !== 1 ? t('delegation.rolesProtocolHint') : undefined}
                onPress={() => { setSelectedId(item.id); setChoosing(false); }} selected={item.id === selectedId}
                accessibilityRole="radio" aria-checked={item.id === selectedId} showChevron={false} testID={`delegation-machine-${item.id}`} />) : null}
        </ItemGroup>
        {machine && account ? <RoleEditor key={`${owner}:${machine.id}`} machine={machine} caches={caches}
            initialRoleId={machine.id === initialMachineId || !initialMachineId ? initialRoleId : undefined} onConfigureWithAI={configure} /> : null}
    </ItemList>;
});

const RoleEditor = React.memo(function RoleEditor({ machine, caches, initialRoleId, onConfigureWithAI }: {
    machine: Machine; caches: Map<string, DraftCache>; initialRoleId?: string; onConfigureWithAI: NonNullable<Props['onConfigureWithAI']>;
}) {
    const { theme } = useUnistyles();
    const machineReady = machine.active && machine.metadata?.delegationRoles === 1;
    const focused = useIsFocused();
    const controller = useMachineDelegationRoles(machine.id, machineReady, focused);
    const canManage = machineReady && controller.connected;
    const sessions = useAllSessions();
    const cache = React.useMemo(() => {
        let value = caches.get(machine.id);
        if (!value) {
            value = { selectedId: initialRoleId ?? null, view: initialRoleId ? 'detail' : 'list', step: 1, query: '', drafts: new Map(), baselines: new Map(), baseline: JSON.stringify(newDraft()), roles: [] };
            caches.set(machine.id, value);
        }
        return value;
    }, [caches, machine.id]);
    const [selectedId, setSelectedId] = React.useState(cache.selectedId);
    const [view, setView] = React.useState<ViewName>(cache.view);
    const [step, setStep] = React.useState<1 | 2>(cache.step);
    const [query, setQuery] = React.useState(cache.query);
    const [draft, setDraft] = React.useState<Draft>(() => cache.drafts.get(cache.selectedId) ?? newDraft());
    const [failure, setFailure] = React.useState<string | null>(null);
    const [fieldError, setFieldError] = React.useState<'name' | 'description' | null>(null);
    const [operation, setOperation] = React.useState<typeof controller.scope | null>(null);
    const [catalogOperation, setCatalogOperation] = React.useState<typeof controller.scope | null>(null);
    const [showModels, setShowModels] = React.useState(false);
    const modelModal = React.useRef<string | null>(null);
    React.useEffect(() => () => { if (modelModal.current) Modal.hide(modelModal.current); }, []);
    const [showEfforts, setShowEfforts] = React.useState(false);
    const [advanced, setAdvanced] = React.useState(false);
    const scope = React.useRef<typeof controller.scope | null>(controller.scope);
    scope.current = controller.scope;
    React.useEffect(() => () => { scope.current = null; }, []);
    const busy = operation === controller.scope;
    const catalogBusy = catalogOperation === controller.scope;
    const current = (token: typeof controller.scope) => scope.current === token && controller.isCurrent();
    if (canManage && !controller.loading && !controller.error) cache.roles = controller.roles;
    const roles = canManage ? controller.roles : cache.roles;
    const saved = roles.find(role => role.id === selectedId);
    const editing = view === 'create' || view === 'edit';
    const baseline = cache.baselines.get(selectedId) ?? cache.baseline;
    const dirty = editing && JSON.stringify(draft) !== baseline;
    const savedBaseline = saved ? JSON.stringify(fromRole(saved)) : null;
    const latestSavedBaseline = React.useRef(savedBaseline);
    latestSavedBaseline.current = savedBaseline;
    React.useEffect(() => {
        if (view !== 'edit' || dirty || !saved || !canManage || controller.loading || controller.error
            || savedBaseline === baseline) return;
        // A clean form can follow AI/remote updates. An unfinished local draft
        // retains its original baseline so saving cannot silently overwrite them.
        const next = fromRole(saved);
        cache.drafts.set(saved.id, next); cache.baseline = savedBaseline!; cache.baselines.set(saved.id, savedBaseline!);
        setDraft(next);
    }, [view, dirty, saved, savedBaseline, baseline, canManage, controller.loading, controller.error, cache]);
    React.useEffect(() => {
        if (!cache.clientRoleId || !canManage || controller.loading || controller.error) return;
        const created = roles.find(role => role.id === cache.clientRoleId);
        if (!created) return;
        const original = cache.drafts.get(null) ?? (view === 'create' ? draft : newDraft());
        const originalBaseline = cache.baselines.get(null) ?? JSON.stringify(newDraft());
        const keepDraft = JSON.stringify(original) !== originalBaseline;
        const next = keepDraft ? original : fromRole(created);
        const nextBaseline = keepDraft ? originalBaseline : JSON.stringify(next);
        // The reserved ID now names a real AI-created role. Keep unfinished
        // manual input on that role, rather than offering a duplicate create.
        cache.drafts.set(created.id, next); cache.baselines.set(created.id, nextBaseline);
        cache.drafts.delete(null); cache.baselines.delete(null); delete cache.clientRoleId;
        if (view === 'create' || (view === 'detail' && selectedId === created.id)) {
            cache.selectedId = created.id; cache.baseline = nextBaseline; cache.view = 'detail';
            setSelectedId(created.id); setDraft(next); setView('detail'); setFailure(null); setFieldError(null);
        }
    }, [roles, view, selectedId, draft, canManage, controller.loading, controller.error, cache]);
    const catalog = useMagpieModelCatalog(machine.id, machine.metadata?.homeDir ?? null,
        canManage && editing && draft.agent === 'codex' && machine.metadata?.magpieModelCatalog === 1);
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
    const lastRequestedRole = React.useRef<string | undefined>(undefined);
    React.useEffect(() => {
        if (initialRoleId && lastRequestedRole.current !== initialRoleId) {
            lastRequestedRole.current = initialRoleId;
            cache.selectedId = initialRoleId; cache.view = 'detail';
            setSelectedId(initialRoleId); setView('detail'); setFailure(null);
        }
    }, [initialRoleId, cache]);
    const changeView = (next: ViewName) => { cache.view = next; setView(next); setFailure(null); setFieldError(null); setShowModels(false); setShowEfforts(false); };
    const edit = (patch: Partial<Draft>) => {
        const next = { ...draft, ...patch };
        cache.drafts.set(selectedId, next); setDraft(next); setFieldError(null); setFailure(null);
    };
    const choose = (roleId: string) => { cache.selectedId = roleId; setSelectedId(roleId); changeView('detail'); };
    const startCreate = () => {
        cache.selectedId = null; setSelectedId(null);
        cache.clientRoleId ??= randomUUID();
        const next = cache.drafts.get(null) ?? newDraft();
        setDraft(next); cache.baseline = JSON.stringify(newDraft()); cache.baselines.set(null, cache.baseline); cache.step = 1; setStep(1); setAdvanced(false); changeView('create');
    };
    const startEdit = () => {
        if (!saved) return;
        const savedValue = fromRole(saved);
        const previousBaseline = cache.baselines.get(saved.id) ?? cache.baseline;
        const retainedDraft = cache.drafts.get(saved.id);
        const keepDraft = retainedDraft && JSON.stringify(retainedDraft) !== previousBaseline;
        const next = keepDraft ? retainedDraft : savedValue;
        const nextBaseline = keepDraft ? previousBaseline : JSON.stringify(savedValue);
        cache.drafts.set(saved.id, next); cache.baseline = nextBaseline; cache.baselines.set(saved.id, nextBaseline);
        setDraft(next); setAdvanced(false); changeView('edit');
    };
    const back = async (exit = false) => {
        if (busy) return;
        if (!exit && view === 'create' && step === 2) { cache.step = 1; setStep(1); setShowModels(false); setShowEfforts(false); return; }
        const token = controller.scope;
        if (dirty) {
            const approved = await Modal.confirm(t('delegation.unsavedTitle'), t('delegation.unsavedHint'), { confirmText: t('delegation.discardChanges'), cancelText: t('delegation.keepEditing'), destructive: true });
            if (!approved || !current(token)) return;
            cache.drafts.delete(selectedId); cache.baselines.delete(selectedId);
            if (selectedId === null) delete cache.clientRoleId;
        }
        changeView(view === 'edit' ? 'detail' : 'list');
    };
    const validateBasics = () => {
        const missing = !draft.name.trim() ? 'name' : !draft.description.trim() ? 'description' : null;
        setFieldError(missing);
        return !missing;
    };
    const save = async () => {
        if (busy || controller.loading || !canManage || !validateBasics()) return;
        if (selectedId === null && cache.clientRoleId && roles.some(role => role.id === cache.clientRoleId)) return;
        if (selectedId !== null && !saved) { setFailure(t('delegation.roleNotFound')); return; }
        const parsed = DelegationRoleCreateInputSchema.safeParse({ ...draft, ...(selectedId === null && cache.clientRoleId ? { id: cache.clientRoleId } : {}), name: draft.name.trim(), description: draft.description.trim(), model: draft.model.trim() || undefined, effort: draft.effort.trim() || undefined });
        if (!parsed.success) { setFailure(t('delegation.invalidRole')); return; }
        const token = controller.scope;
        setOperation(token); setFailure(null);
        try {
            if (selectedId !== null && savedBaseline !== baseline) {
                const remoteAtConfirmation = latestSavedBaseline.current;
                const approved = await Modal.confirm(t('delegation.roleChangedTitle'), t('delegation.roleChangedHint'), {
                    confirmText: t('files.overwrite'), cancelText: t('common.cancel'), destructive: true,
                });
                if (!approved || !current(token)) return;
                // If another refresh changed it while the dialog was open,
                // require a fresh review instead of using stale confirmation.
                if (latestSavedBaseline.current !== remoteAtConfirmation) { setFailure(t('delegation.roleChangedTitle')); return; }
            }
            const result = selectedId === null
                ? await createMachineDelegationRole(machine.id, parsed.data)
                : await updateMachineDelegationRole(machine.id, selectedId, { ...parsed.data, model: parsed.data.model ?? null, effort: parsed.data.effort ?? null });
            if (!current(token)) return;
            controller.apply(result.roles); cache.roles = result.roles;
            const next = fromRole(result.role);
            if (selectedId === null) { cache.drafts.delete(null); delete cache.clientRoleId; }
            cache.selectedId = result.role.id; cache.drafts.set(result.role.id, next); cache.baseline = JSON.stringify(next); cache.baselines.set(result.role.id, cache.baseline);
            setSelectedId(result.role.id); setDraft(next); changeView('detail');
        } catch (error) { if (current(token)) setFailure(errorText(error)); }
        finally { if (current(token)) setOperation(null); }
    };
    const remove = async () => {
        if (busy || controller.loading || !canManage || !saved) return;
        const token = controller.scope;
        setOperation(token); setFailure(null);
        try {
            const approved = await Modal.confirm(t('delegation.deleteTitle'), `${saved.name}\n\n${t('delegation.deleteHint')}${dirty ? `\n\n${t('delegation.discardOnDelete')}` : ''}`, { destructive: true, confirmText: t('common.delete') });
            if (!approved || !current(token)) return;
            const remaining = await deleteMachineDelegationRole(machine.id, saved.id);
            if (!current(token)) return;
            controller.apply(remaining); cache.roles = remaining; cache.drafts.delete(saved.id); cache.baselines.delete(saved.id); cache.selectedId = null;
            setSelectedId(null); setDraft(cache.drafts.get(null) ?? newDraft()); changeView('list');
        } catch (error) { if (current(token)) setFailure(errorText(error)); }
        finally { if (current(token)) setOperation(null); }
    };
    const configureWithAI = async (newRole = false) => {
        if (!canManage || busy) return;
        const value = newRole ? newDraft() : view === 'detail' && saved ? fromRole(saved) : draft;
        const token = controller.scope;
        setOperation(token); setFailure(null);
        try {
            await onConfigureWithAI({ machineId: machine.id, ...(!newRole && selectedId ? { roleId: selectedId } : { clientRoleId: cache.clientRoleId ?? (cache.clientRoleId = randomUUID()) }), draft: { ...value, model: value.model.trim() || undefined, effort: value.effort.trim() || undefined } });
        } catch (error) { if (current(token)) setFailure(errorText(error)); }
        finally { if (current(token)) setOperation(null); }
    };
    const refreshModels = async () => {
        if (catalogBusy || !canManage) return;
        const token = controller.scope; setCatalogOperation(token); setFailure(null);
        try { await catalog.refresh(); }
        catch (error) { if (current(token)) setFailure(errorText(error)); }
        finally { if (current(token)) setCatalogOperation(null); }
    };
    const chooseModel = () => {
        if (busy) return;
        if (modelModal.current) { Modal.hide(modelModal.current); return; }
        const token = controller.scope;
        setShowEfforts(false); setShowModels(true);
        const modalId = Modal.show({ component: RoleModelPicker, accessibilityLabel: t('delegation.chooseModel'), props: {
            models, selectedCode: draft.model,
            onSelect: (code: string) => { if (current(token)) edit({ model: code, effort: '' }); },
            onDismiss: () => { if (modelModal.current === modalId) { modelModal.current = null; if (current(token)) setShowModels(false); } },
        } });
        modelModal.current = modalId || null;
        if (!modalId) setShowModels(false);
    };
    const filtered = roles.filter(role => !query.trim() || `${role.name} ${role.description} ${role.id} ${role.agent} ${role.model ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    const modelLabel = (value?: string) => models.find(option => option.code === value)?.value ?? value ?? t('delegation.nativeDefault');
    const aiEntry = (creating: boolean) => <ItemGroup footer={t('delegation.manualAlternative')}><Item title={t(creating ? 'delegation.createWithAI' : 'delegation.adjustWithAI')}
        subtitle={t(creating ? 'delegation.aiCreateHint' : 'delegation.aiEditHint')} icon={<Ionicons name="chatbubble-outline" size={22} color={theme.colors.text} />}
        onPress={() => { void configureWithAI(); }} disabled={!canManage || busy} loading={busy} testID="delegation-settings-ai" /></ItemGroup>;
    const basics = <>
        <Field label={t('delegation.name')}><TextInput accessibilityLabel={t('delegation.name')} testID="delegation-settings-name" value={draft.name} placeholder={t('delegation.roleNamePlaceholder')}
            placeholderTextColor={theme.colors.textSecondary} onChangeText={name => edit({ name })} editable={!busy} maxLength={100} style={styles.input} aria-invalid={fieldError === 'name'} />
            {fieldError === 'name' ? <Text style={styles.fieldError} accessibilityRole="alert">{t('delegation.nameRequired')}</Text> : null}</Field>
        <Field label={t('delegation.description')}><TextInput accessibilityLabel={t('delegation.description')} testID="delegation-settings-description" value={draft.description} placeholder={t('delegation.roleDescriptionPlaceholder')}
            placeholderTextColor={theme.colors.textSecondary} onChangeText={description => edit({ description })} editable={!busy} maxLength={10000} multiline style={[styles.input, styles.multiline]} aria-invalid={fieldError === 'description'} />
            {fieldError === 'description' ? <Text style={styles.fieldError} accessibilityRole="alert">{t('delegation.descriptionRequired')}</Text> : null}</Field>
    </>;
    const execution = <>
        <Field label={t('delegation.agent')}><View style={styles.choices} accessibilityRole="radiogroup" accessibilityLabel={t('delegation.agent')}>
            {(['codex', 'antigravity'] as const).map(agent => <Choice key={agent} label={agentLabel(agent)} selected={draft.agent === agent} disabled={busy}
                icon={<CodingAgentIcon agent={agent} size={22} />} onPress={() => { if (draft.agent !== agent) { edit({ agent, model: '', effort: '' }); setShowModels(false); setShowEfforts(false); } }} testID={`delegation-settings-agent-${agent}`} />)}
        </View></Field>
        <Item title={t('delegation.model')} detail={modelLabel(draft.model || undefined)} onPress={chooseModel} disabled={busy} aria-expanded={showModels} testID="delegation-settings-model-picker" />
        {draft.agent === 'codex' && machine.metadata?.magpieModelCatalog === 1 ? <Item title={t('delegation.refreshModels')} disabled={busy || catalogBusy || !canManage} loading={catalogBusy} onPress={() => { void refreshModels(); }} showChevron={false} testID="delegation-settings-model-refresh" /> : null}
        <Item title={t('delegation.effort')} detail={draft.effort || t('delegation.nativeDefault')} onPress={() => { setShowEfforts(value => !value); setShowModels(false); }} disabled={busy} aria-expanded={showEfforts} testID="delegation-settings-effort-picker" />
        {showEfforts ? <View accessibilityRole="radiogroup" accessibilityLabel={t('delegation.effort')}>
            <Item title={t('delegation.nativeDefault')} selected={!draft.effort} onPress={() => { edit({ effort: '' }); setShowEfforts(false); }} showChevron={false} />
            {model?.supportedEffortLevels?.map(effort => <Item key={effort} title={effort} selected={draft.effort === effort} onPress={() => { edit({ effort }); setShowEfforts(false); }} showChevron={false} testID={`delegation-effort-${effort}`} />)}
            {!model?.supportedEffortLevels?.length ? <Text style={styles.hintBlock}>{t('delegation.defaultModelHint')}</Text> : null}
        </View> : null}
        <Text style={styles.hintBlock}>{t('delegation.defaultModelHint')}</Text>
        <View style={styles.toggle}><View style={styles.toggleCopy}><Text style={styles.toggleLabel}>{t('delegation.allowAutoSelect')}</Text><Text style={styles.hint}>{t('delegation.enabledAutoHint')}</Text></View><Switch accessibilityLabel={t('delegation.allowAutoSelect')} testID="delegation-settings-auto" value={draft.autoDelegate} onValueChange={autoDelegate => edit({ autoDelegate })} disabled={busy} /></View>
        <Item title={t('delegation.advancedSettings')} detail={t(advanced ? 'delegation.collapse' : 'delegation.expand')} onPress={() => setAdvanced(value => !value)} showChevron={false} aria-expanded={advanced} testID="delegation-settings-advanced" />
        {advanced ? <>
            <Field label={t('delegation.model')}><TextInput accessibilityLabel={t('delegation.model')} testID="delegation-settings-model" value={draft.model} placeholder={t('delegation.nativeDefault')} placeholderTextColor={theme.colors.textSecondary}
                onChangeText={value => edit({ model: value, effort: '' })} editable={!busy} autoCapitalize="none" autoCorrect={false} maxLength={256} style={styles.input} /></Field>
            <Field label={t('delegation.effort')}><TextInput accessibilityLabel={t('delegation.effort')} testID="delegation-settings-effort" value={draft.effort} placeholder={t('delegation.nativeDefault')} placeholderTextColor={theme.colors.textSecondary}
                onChangeText={effort => edit({ effort })} editable={!busy} autoCapitalize="none" autoCorrect={false} maxLength={100} style={styles.input} /></Field>
        </> : null}
    </>;
    return <>
        {(failure ?? controller.error) ? <ItemGroup><Text style={styles.error} accessibilityRole="alert" testID="delegation-settings-error">{failure ?? controller.error}</Text></ItemGroup> : null}
        {!canManage ? <ItemGroup><Text style={styles.hintBlock}>{!machineReady ? machine.active ? t('delegation.rolesProtocolHint') : t('delegation.offline') : t('delegation.roleLoadFailed')}</Text></ItemGroup> : null}
        {view === 'list' ? <>
            <ItemGroup title={t('delegation.rolesTitle')}><Field label={t('delegation.searchRoles')}><TextInput testID="delegation-settings-search" accessibilityLabel={t('delegation.searchRoles')} value={query}
                placeholder={t('delegation.searchRoles')} placeholderTextColor={theme.colors.textSecondary} onChangeText={value => { cache.query = value; setQuery(value); }} style={styles.input} autoCorrect={false} />
                {query ? <Choice label={t('delegation.clearSearch')} onPress={() => { cache.query = ''; setQuery(''); }} testID="delegation-settings-clear-search" /> : null}</Field>
                {filtered.map(role => <Item key={role.id} title={role.name} subtitle={`${role.description}\n${agentLabel(role.agent)} · ${role.model ?? t('delegation.nativeDefault')}`}
                    icon={<CodingAgentIcon agent={role.agent} size={28} />} onPress={() => choose(role.id)} testID={`delegation-settings-role-${role.id}`} />)}
                {!controller.loading && !filtered.length ? <Item title={t(roles.length ? 'delegation.searchNoResults' : 'delegation.firstRoleTitle')} subtitle={!roles.length ? t('delegation.firstRoleHint') : undefined} showChevron={false} /> : null}
                <Item title={t('delegation.newRole')} icon={<Ionicons name="add-outline" size={24} color={theme.colors.text} />} onPress={startCreate} disabled={busy} testID="delegation-settings-new" />
                {!roles.length ? <Item title={t('delegation.createWithAI')} onPress={() => { startCreate(); void configureWithAI(true); }} disabled={!canManage || busy} testID="delegation-settings-empty-ai" /> : null}
                <Item title={t('delegation.refresh')} loading={controller.loading} disabled={busy || controller.loading || !canManage} onPress={() => { setFailure(null); void controller.refresh(); }} showChevron={false} testID="delegation-settings-refresh" />
            </ItemGroup>
        </> : null}
        {view === 'detail' ? <>
            <ItemGroup><Item title={t('delegation.backToList')} onPress={() => changeView('list')} testID="delegation-settings-back" /></ItemGroup>
            {saved ? <>
                <ItemGroup title={t('delegation.roleDetails')}><Item title={saved.name} subtitle={saved.description} icon={<CodingAgentIcon agent={saved.agent} size={32} />} showChevron={false} />
                    <Item title={t('delegation.adjustWithAI')} subtitle={t('delegation.aiEditHint')} onPress={() => { void configureWithAI(); }} disabled={!canManage || busy} loading={busy} testID="delegation-settings-ai" />
                    <Item title={t('delegation.editRole')} onPress={startEdit} disabled={busy} testID="delegation-settings-edit" />
                </ItemGroup>
                <ItemGroup title={t('delegation.executionStep')}>
                    <Item title={t('delegation.agent')} detail={agentLabel(saved.agent)} showChevron={false} />
                    <Item title={t('delegation.model')} detail={modelLabel(saved.model)} showChevron={false} testID="delegation-settings-saved-model" />
                    <Item title={t('delegation.effort')} detail={saved.effort ?? t('delegation.nativeDefault')} showChevron={false} />
                    <Item title={t('delegation.autoDelegate')} detail={t(saved.autoDelegate ? 'delegation.autoSelectEnabled' : 'delegation.specifiedOnly')} showChevron={false} />
                </ItemGroup>
                <ItemGroup title={t('delegation.roleCalling')}>
                    <Item title={t('delegation.roleId')} subtitle={saved.id} showChevron={false} testID="delegation-settings-id" rightElement={<InlineCopy value={saved.id} label={t('delegation.copyRoleId')} testID="delegation-settings-copy-id" />} />
                    <View style={styles.example}><Text style={styles.exampleText}>{t('delegation.useRolePrompt', { id: saved.id, name: saved.name })}</Text><InlineCopy value={t('delegation.useRolePrompt', { id: saved.id, name: saved.name })} label={t('delegation.copyExample')} testID="delegation-settings-copy-example" /></View>
                </ItemGroup>
                <ItemGroup footer={t('delegation.deleteHint')}><Item title={t('common.delete')} destructive disabled={busy || !canManage || controller.loading} loading={busy} onPress={() => { void remove(); }} showChevron={false} testID="delegation-settings-delete" /></ItemGroup>
            </> : !controller.loading && canManage && !controller.error ? <ItemGroup><Text style={styles.hintBlock}>{t('delegation.roleNotFound')}</Text></ItemGroup> : null}
        </> : null}
        {editing ? <>
            <ItemGroup><Item title={t(view === 'create' && step === 2 ? 'delegation.previousStep' : 'common.cancel')} onPress={() => { void back(); }} disabled={busy} showChevron={false} testID="delegation-settings-back" /></ItemGroup>
            {view === 'create' ? <View style={styles.steps} accessibilityLabel={`${step} / 2`} testID="delegation-settings-steps"><Text style={[styles.step, step === 1 && styles.currentStep]}>1 · {t('delegation.responsibilityStep')}</Text><Text style={[styles.step, step === 2 && styles.currentStep]}>2 · {t('delegation.executionStep')}</Text></View> : null}
            {view === 'edit' || step === 1 ? <>{aiEntry(view === 'create')}<ItemGroup title={t('delegation.responsibilityStep')}>{basics}</ItemGroup></> : null}
            {view === 'edit' || step === 2 ? <ItemGroup title={t('delegation.executionStep')}>{execution}</ItemGroup> : null}
            {view === 'edit' && saved ? <ItemGroup footer={t('delegation.roleIdUnchanged')}><Item title={t('delegation.roleId')} subtitle={saved.id} showChevron={false} testID="delegation-settings-id" /></ItemGroup> : null}
            <ItemGroup footer={t(view === 'create' ? 'delegation.saveOnlyHint' : 'delegation.snapshotHint')}>
                <Item title={t(view === 'create' && step === 1 ? 'delegation.nextStep' : view === 'create' ? 'delegation.createRole' : 'delegation.saveChanges')}
                    loading={busy} disabled={busy || (step === 2 || view === 'edit') && (controller.loading || !canManage)} onPress={() => {
                        if (view === 'create' && step === 1) { if (validateBasics()) { cache.step = 2; setStep(2); } } else void save();
                    }} showChevron={false} testID={view === 'create' && step === 1 ? 'delegation-settings-next' : 'delegation-settings-save'} />
                <Item title={t('common.cancel')} onPress={() => { void back(true); }} disabled={busy} showChevron={false} testID="delegation-settings-cancel" />
            </ItemGroup>
        </> : null}
    </>;
});

function Field({ label, children }: React.PropsWithChildren<{ label: string }>) {
    return <View style={styles.field}><Text style={styles.label}>{label}</Text>{children}</View>;
}
function Choice({ label, selected, disabled, onPress, testID, icon }: { label: string; selected?: boolean; disabled?: boolean; onPress: () => void; testID?: string; icon?: React.ReactNode }) {
    const [focused, setFocused] = React.useState(false);
    return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress} testID={testID}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={(state: { pressed: boolean; hovered?: boolean }) => [styles.choice, (state.pressed || state.hovered) && styles.pressed, selected && styles.selected, focused && styles.focused]}>{icon}<Text style={styles.choiceText}>{label}</Text></Pressable>;
}
function InlineCopy({ value, label, testID }: { value: string; label: string; testID: string }) {
    const { theme } = useUnistyles();
    const [feedback, setFeedback] = React.useState<'copied' | 'failed' | null>(null);
    const sequence = React.useRef(0);
    React.useEffect(() => { setFeedback(null); return () => { sequence.current++; }; }, [value]);
    const copy = async () => {
        const token = ++sequence.current;
        try {
            const result = await Clipboard.setStringAsync(value);
            if (result === false) throw new Error('clipboard rejected');
            if (sequence.current === token) setFeedback('copied');
        } catch { if (sequence.current === token) setFeedback('failed'); }
    };
    return <View style={styles.copyControl}>
        <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => { void copy(); }} testID={testID} style={({ pressed }) => [styles.copyButton, pressed && styles.pressed]}>
            <Ionicons name={feedback === 'copied' ? 'checkmark-outline' : 'copy-outline'} size={18} color={theme.colors.textSecondary} /><Text style={styles.copyLabel}>{label}</Text>
        </Pressable>
        <Text style={styles.copyStatus} accessibilityLiveRegion="polite" testID={`${testID}-status`}>{feedback ? t(feedback === 'copied' ? 'delegation.copiedInline' : 'delegation.copyFailedInline') : ' '}</Text>
    </View>;
}

const styles = StyleSheet.create(theme => ({
    field: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
    label: { ...Typography.default('regular'), color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18 },
    input: { ...Typography.default('regular'), color: theme.colors.text, borderColor: theme.colors.divider, borderWidth: 1, borderRadius: 8, backgroundColor: theme.colors.surfacePressed, paddingHorizontal: 12, paddingVertical: 10, minHeight: 44, fontSize: 14, lineHeight: 21 },
    multiline: { minHeight: 108, textAlignVertical: 'top' },
    hint: { ...Typography.default('regular'), color: theme.colors.textSecondary, fontSize: 12, lineHeight: 19 },
    hintBlock: { ...Typography.default('regular'), color: theme.colors.textSecondary, fontSize: 12, lineHeight: 19, paddingHorizontal: 16, paddingVertical: 12 },
    error: { padding: 16, color: theme.colors.textDestructive, fontSize: 13, lineHeight: 20 },
    fieldError: { color: theme.colors.textDestructive, fontSize: 12, lineHeight: 18 },
    choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    choice: { flexDirection: 'row', alignItems: 'center', gap: 8, borderColor: theme.colors.divider, borderWidth: 1, borderRadius: 7, paddingVertical: 10, paddingHorizontal: 12, backgroundColor: theme.colors.surface, minHeight: 42, justifyContent: 'center' },
    choiceText: { color: theme.colors.text, fontSize: 13 },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    selected: { backgroundColor: theme.colors.surfaceSelected },
    focused: { borderColor: theme.colors.textLink },
    toggle: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 },
    toggleCopy: { flex: 1, gap: 4 },
    toggleLabel: { ...Typography.default('regular'), color: theme.colors.text, fontSize: 14, lineHeight: 21 },
    steps: { flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: 22, paddingHorizontal: 16, paddingVertical: 14 },
    step: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 21 },
    currentStep: { color: theme.colors.text, fontWeight: '600' },
    example: { gap: 8, padding: 16 },
    exampleText: { ...Typography.default('regular'), color: theme.colors.text, fontSize: 14, lineHeight: 22 },
    copyControl: { flexDirection: 'column', alignItems: 'flex-start', minWidth: 80 },
    copyButton: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 6, padding: 5, borderRadius: 6 },
    copyLabel: { fontSize: 12, color: theme.colors.textSecondary },
    copyStatus: { color: theme.colors.textSecondary, fontSize: 11, lineHeight: 16, minHeight: 16 },
}));
