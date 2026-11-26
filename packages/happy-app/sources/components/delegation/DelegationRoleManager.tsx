import * as React from 'react';
import { Pressable, Switch, Text, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import { randomUUID } from 'expo-crypto';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { DelegationRoleCreateInputSchema, type DelegationRole } from '@slopus/happy-wire';
import { Item } from '@/components/Item';
import { useIsDesktopModalScene } from '@/components/DesktopModalScene';
import { navigateDesktopModalBack } from '@/navigation/desktopModalNavigation';
import { Typography } from '@/constants/Typography';
import { useAllMachines, useAllSessions } from '@/sync/storage';
import type { Machine } from '@/sync/storageTypes';
import { getFirstSubmissionScope, subscribeFirstSubmissionScope } from '@/sync/firstSubmissionScope';
import { getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { createMachineDelegationRole, updateMachineDelegationRole, deleteMachineDelegationRole } from '@/sync/apiDelegation';
import { useMachineDelegationRoles } from '@/hooks/useMachineDelegationRoles';
import { useMagpieModelCatalog } from '@/hooks/useMagpieModelCatalog';
import { getRoleConfigurationSavedHandoff, readRoleConfiguration, type RoleConfigurationHandoff, type RoleConfigurationRequest } from '@/sync/roleConfigurationHandoff';
import { useRoleFlowNavigationBack } from '@/hooks/useRoleFlowNavigationBack';
import { RoleFlowButton, RoleFlowScaffold } from './RoleFlowScaffold';
import { openRoleConfiguration } from './roleConfigurationNavigation';
import { RoleModelPicker } from './RoleModelPicker';
import { Modal } from '@/modal';
import { t } from '@/text';
import { CodingAgentIcon } from '@/components/codingAgents/CodingAgentIcon';

type Draft = { name: string; description: string; agent: 'codex' | 'antigravity'; model: string; effort: string; autoDelegate: boolean };
type ViewName = 'list' | 'detail' | 'create' | 'edit';
const roleFlowScrollKey = (view: ViewName, step: 1 | 2, roleId: string | null) => view === 'list' ? 'list' : `${view}:${view === 'create' ? step : roleId ?? ''}`;
type DraftCache = { selectedId: string | null; view: ViewName; step: 1 | 2; query: string; drafts: Map<string | null, Draft>; baselines: Map<string | null, string>; baseline: string; roles: DelegationRole[]; clientRoleId?: string; appliedReturnKey?: string; consumedSavedKeys?: Set<string>; scrollPositions?: Map<string, number>; advanced?: boolean };
type Model = { code: string; value: string; supportedEffortLevels?: string[] };
type Props = { initialMachineId?: string; initialRoleId?: string; onConfigureWithAI?: (request: RoleConfigurationRequest) => Promise<void> | void };
const newDraft = (): Draft => ({ name: '', description: '', agent: 'antigravity', model: '', effort: '', autoDelegate: false });
const fromRole = (role: DelegationRole): Draft => ({ name: role.name, description: role.description, agent: role.agent, model: role.model ?? '', effort: role.effort ?? '', autoDelegate: role.autoDelegate });
const draftFingerprint = (value: RoleConfigurationRequest['draft']) => JSON.stringify({ name: value.name, description: value.description, agent: value.agent, model: value.model?.trim() || '', effort: value.effort?.trim() || '', autoDelegate: value.autoDelegate });
const asDraft = (value: RoleConfigurationRequest['draft']): Draft => ({ ...value, model: value.model ?? '', effort: value.effort ?? '' });
const errorText = (failure: unknown) => failure instanceof Error ? failure.message : t('delegation.requestFailed');
const agentLabel = (agent: string) => agent === 'codex' ? 'Codex' : 'Antigravity';
function returnToSettings(router: ReturnType<typeof useRouter>) {
    if (navigateDesktopModalBack(false)) return;
    if (router.canGoBack()) router.back(); else router.replace('/settings');
}
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
    const params = useLocalSearchParams<{ roleConfigurationReturn?: string | string[] }>();
    const returnReference = Array.isArray(params.roleConfigurationReturn) ? params.roleConfigurationReturn[0] : params.roleConfigurationReturn;
    const returnRecord = returnReference ? readRoleConfiguration(returnReference) : null;
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
    const machineSelector = <View style={styles.machineSection}>
        <Item title={t('delegation.machine')} detail={machine?.metadata?.displayName ?? machine?.metadata?.host ?? t('delegation.chooseMachine')}
            subtitle={!machines.length ? t('delegation.noMachines') : machine && !machine.active ? t('delegation.offline') : undefined}
            onPress={() => setChoosing(value => !value)} aria-expanded={choosing} testID="delegation-machine-picker"
            style={styles.machineRow} titleStyle={styles.detailLabel} detailStyle={styles.detailValue} />
        {choosing ? machines.map(item => <Item key={item.id} title={item.metadata?.displayName ?? item.metadata?.host ?? item.id}
            subtitle={!item.active ? t('delegation.offline') : item.metadata?.delegationRoles !== 1 ? t('delegation.rolesProtocolHint') : undefined}
            onPress={() => { setSelectedId(item.id); setChoosing(false); }} selected={item.id === selectedId}
            accessibilityRole="radio" aria-checked={item.id === selectedId} showChevron={false} testID={`delegation-machine-${item.id}`} />) : null}
    </View>;
    return <View style={styles.host}>
        <Stack.Screen options={{ headerShown: false }} />
        {machine && account ? <RoleEditor key={`${owner}:${machine.id}`} machine={machine} caches={caches}
            initialRoleId={machine.id === initialMachineId || !initialMachineId ? initialRoleId : undefined}
            returnRecord={returnRecord?.machineId === machine.id ? returnRecord : null}
            machineSelector={machineSelector} onConfigureWithAI={configure} />
            : <RoleFlowScaffold title={t('delegation.settingsTitle')} subtitle={t('delegation.settingsSubtitle')} scrollKey="list" back={{ label: t('common.back'), onPress: () => returnToSettings(router), testID: 'delegation-settings-exit' }}>{machineSelector}</RoleFlowScaffold>}
    </View>;
});

const RoleEditor = React.memo(function RoleEditor({ machine, caches, initialRoleId, returnRecord, machineSelector, onConfigureWithAI }: {
    machine: Machine; caches: Map<string, DraftCache>; initialRoleId?: string; returnRecord: RoleConfigurationHandoff | null; machineSelector: React.ReactNode; onConfigureWithAI: NonNullable<Props['onConfigureWithAI']>;
}) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const inDesktopModal = useIsDesktopModalScene();
    const nameInput = React.useRef<TextInput>(null);
    const descriptionInput = React.useRef<TextInput>(null);
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
    cache.scrollPositions ??= new Map();
    const scrollPositions = cache.scrollPositions;
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
    const [advanced, setAdvanced] = React.useState(cache.advanced ?? false);
    const changeAdvanced = (next: boolean) => { cache.advanced = next; setAdvanced(next); };
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
        const handoff = getRoleConfigurationSavedHandoff(machine.id, created.id);
        const acceptedSource = !!handoff && created.updatedAt >= handoff.savedRole.updatedAt && draftFingerprint(original) === draftFingerprint(handoff.sourceDraft);
        const keepDraft = JSON.stringify(original) !== originalBaseline && !acceptedSource;
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
    }, [roles, view, selectedId, draft, canManage, controller.loading, controller.error, cache, machine.id]);
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
        if (returnRecord?.returnContext) return;
        if (initialRoleId && lastRequestedRole.current !== initialRoleId) {
            lastRequestedRole.current = initialRoleId;
            cache.selectedId = initialRoleId; cache.view = 'detail';
            setSelectedId(initialRoleId); setView('detail'); setFailure(null);
        }
    }, [initialRoleId, cache, returnRecord]);
    React.useEffect(() => {
        if (!returnRecord?.returnContext) return;
        const returnKey = `${returnRecord.id}:${returnRecord.revision}`;
        if (cache.appliedReturnKey === returnKey) return;
        cache.appliedReturnKey = returnKey;
        const context = returnRecord.returnContext;
        const nextId = returnRecord.savedRole || context.view !== 'create' ? returnRecord.roleId : null;
        const nextView = returnRecord.savedRole ? 'detail' : context.view;
        if (returnRecord.savedRole && cache.clientRoleId === returnRecord.roleId) {
            const original = cache.drafts.get(null);
            if (original && !cache.drafts.has(returnRecord.roleId)) {
                const sameSource = draftFingerprint(original) === draftFingerprint(returnRecord.savedSourceDraft ?? returnRecord.draft);
                const next = sameSource ? fromRole(returnRecord.savedRole) : original;
                cache.drafts.set(returnRecord.roleId, next);
                cache.baselines.set(returnRecord.roleId, sameSource ? JSON.stringify(next) : cache.baselines.get(null) ?? JSON.stringify(newDraft()));
            }
            cache.drafts.delete(null); cache.baselines.delete(null); delete cache.clientRoleId;
        }
        const existing = cache.drafts.get(nextId);
        const nextDraft = existing ?? (returnRecord.savedRole ? fromRole(returnRecord.savedRole) : asDraft(returnRecord.draft));
        cache.selectedId = nextId; cache.view = nextView; cache.step = context.step; cache.query = context.query;
        if (nextView === 'create') cache.clientRoleId = returnRecord.roleId;
        if (nextView === 'create' || nextView === 'edit') {
            cache.drafts.set(nextId, nextDraft);
            if (!cache.baselines.has(nextId)) cache.baselines.set(nextId, context.baseline ?? JSON.stringify(newDraft()));
            cache.baseline = cache.baselines.get(nextId)!;
        }
        const bodyKey = roleFlowScrollKey(nextView, context.step, nextId);
        if (!returnRecord.savedRole && context.scrollY !== undefined && !scrollPositions.has(bodyKey)) scrollPositions.set(bodyKey, context.scrollY);
        setSelectedId(nextId); setView(nextView); setStep(context.step); setQuery(context.query); setDraft(nextDraft);
        if (cache.advanced === undefined && context.advanced !== undefined) { cache.advanced = context.advanced; setAdvanced(context.advanced); }
        setFailure(null); setFieldError(null);
    }, [returnRecord, cache, scrollPositions]);
    React.useEffect(() => {
        if (!canManage || controller.loading || controller.error || !selectedId) return;
        const latest = roles.find(role => role.id === selectedId);
        const handoff = getRoleConfigurationSavedHandoff(machine.id, selectedId);
        if (!latest || !handoff || latest.updatedAt < handoff.savedRole.updatedAt) return;
        const key = `${selectedId}:${handoff.revision}:${handoff.savedRole.updatedAt}`;
        cache.consumedSavedKeys ??= new Set();
        if (cache.consumedSavedKeys.has(key)) return;
        cache.consumedSavedKeys.add(key);
        const previous = cache.drafts.get(selectedId);
        // Consume only the exact draft handed to this successful AI operation.
        // A newer independent user edit remains a protected, separate draft.
        if (previous && draftFingerprint(previous) !== draftFingerprint(handoff.sourceDraft)) return;
        const next = fromRole(latest); const nextBaseline = JSON.stringify(next);
        cache.drafts.set(selectedId, next); cache.baselines.set(selectedId, nextBaseline); cache.baseline = nextBaseline;
        if (view === 'edit') setDraft(next);
    }, [roles, selectedId, view, draft, canManage, controller.loading, controller.error, cache, machine.id]);
    const changeView = (next: ViewName) => {
        cache.view = next; setView(next); setFailure(null); setFieldError(null); setShowModels(false); setShowEfforts(false);
        if (next === 'list') { lastRequestedRole.current = undefined; router.setParams({ roleId: undefined, roleConfigurationReturn: undefined }); }
    };
    const edit = (patch: Partial<Draft>) => {
        const next = { ...draft, ...patch };
        cache.drafts.set(selectedId, next); setDraft(next); setFieldError(null); setFailure(null);
    };
    const choose = (roleId: string) => { cache.selectedId = roleId; setSelectedId(roleId); router.setParams({ roleId, roleConfigurationReturn: undefined }); changeView('detail'); };
    const startCreate = () => {
        cache.selectedId = null; setSelectedId(null);
        cache.clientRoleId ??= randomUUID();
        scrollPositions.delete('create:1'); scrollPositions.delete('create:2');
        const next = cache.drafts.get(null) ?? newDraft();
        setDraft(next); cache.baseline = JSON.stringify(newDraft()); cache.baselines.set(null, cache.baseline); cache.step = 1; setStep(1); changeAdvanced(false); changeView('create');
    };
    const startEdit = () => {
        if (!saved) return;
        scrollPositions.delete(`edit:${saved.id}`);
        const savedValue = fromRole(saved);
        const previousBaseline = cache.baselines.get(saved.id) ?? cache.baseline;
        const retainedDraft = cache.drafts.get(saved.id);
        const keepDraft = retainedDraft && JSON.stringify(retainedDraft) !== previousBaseline;
        const next = keepDraft ? retainedDraft : savedValue;
        const nextBaseline = keepDraft ? previousBaseline : JSON.stringify(savedValue);
        cache.drafts.set(saved.id, next); cache.baseline = nextBaseline; cache.baselines.set(saved.id, nextBaseline);
        setDraft(next); changeAdvanced(false); changeView('edit');
    };
    const back = async (exit = false) => {
        if (busy) return;
        if (!exit && view === 'create' && step === 2) { scrollPositions.delete('create:1'); cache.step = 1; setStep(1); setShowModels(false); setShowEfforts(false); return; }
        const token = controller.scope;
        if (dirty) {
            const approved = await Modal.confirm(t('delegation.unsavedTitle'), t('delegation.unsavedHint'), { confirmText: t('delegation.discardChanges'), cancelText: t('delegation.keepEditing'), destructive: true });
            if (!approved || !current(token)) return;
            cache.drafts.delete(selectedId); cache.baselines.delete(selectedId);
            if (selectedId === null) delete cache.clientRoleId;
        }
        changeView(view === 'edit' ? 'detail' : 'list');
    };
    useRoleFlowNavigationBack({ enabled: focused && view !== 'list', onBack: () => back(), onClose: () => back(true) });
    const validateBasics = () => {
        const missing = !draft.name.trim() ? 'name' : !draft.description.trim() ? 'description' : null;
        setFieldError(missing);
        if (missing === 'name') nameInput.current?.focus();
        else if (missing === 'description') descriptionInput.current?.focus();
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
            await onConfigureWithAI({ machineId: machine.id, ...(!newRole && selectedId ? { roleId: selectedId } : { clientRoleId: cache.clientRoleId ?? (cache.clientRoleId = randomUUID()) }), draft: { ...value, model: value.model.trim() || undefined, effort: value.effort.trim() || undefined },
                returnContext: { view: newRole ? 'create' : view === 'list' ? 'create' : view, step: newRole ? 1 : step, query,
                    baseline: newRole ? JSON.stringify(newDraft()) : baseline, roleUpdatedAt: saved?.updatedAt, desktopModal: inDesktopModal, advanced: newRole ? false : advanced,
                    scrollY: newRole ? 0 : scrollPositions.get(roleFlowScrollKey(view, step, selectedId)) ?? 0 } });
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
    const aiEntry = (creating: boolean) => <>
        <View style={styles.aiEntry}>
            <View style={styles.aiEntryCopy}><Text style={styles.aiEntryTitle}>{t(creating ? 'delegation.aiCreateTitle' : 'delegation.aiEditTitle')}</Text>
                <Text style={styles.hint}>{t(creating ? 'delegation.aiCreateHint' : 'delegation.aiEditHint')}</Text></View>
            <RoleFlowButton label={t(creating ? 'delegation.createWithAI' : 'delegation.adjustWithAI')}
                onPress={() => { void configureWithAI(); }} disabled={!canManage || busy} loading={busy} testID="delegation-settings-ai" />
        </View>
        <View style={styles.manualDivider}><View style={styles.dividerLine} /><Text style={styles.manualLabel}>{t('delegation.manualAlternative')}</Text><View style={styles.dividerLine} /></View>
    </>;
    const basics = <>
        <Field label={t('delegation.name')}><TextInput ref={nameInput} accessibilityLabel={t('delegation.name')} testID="delegation-settings-name" value={draft.name} placeholder={t('delegation.roleNamePlaceholder')}
            placeholderTextColor={theme.colors.textSecondary} onChangeText={name => edit({ name })} editable={!busy} maxLength={100} style={styles.input} aria-invalid={fieldError === 'name'} />
            {fieldError === 'name' ? <Text style={styles.fieldError} accessibilityRole="alert">{t('delegation.nameRequired')}</Text> : null}</Field>
        <Field label={t('delegation.description')}><TextInput ref={descriptionInput} accessibilityLabel={t('delegation.description')} testID="delegation-settings-description" value={draft.description} placeholder={t('delegation.roleDescriptionPlaceholder')}
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
        <Item title={t('delegation.advancedSettings')} detail={t(advanced ? 'delegation.collapse' : 'delegation.expand')} onPress={() => changeAdvanced(!advanced)} showChevron={false} aria-expanded={advanced} testID="delegation-settings-advanced" />
        {advanced ? <>
            <Field label={t('delegation.model')}><TextInput accessibilityLabel={t('delegation.model')} testID="delegation-settings-model" value={draft.model} placeholder={t('delegation.nativeDefault')} placeholderTextColor={theme.colors.textSecondary}
                onChangeText={value => edit({ model: value, effort: '' })} editable={!busy} autoCapitalize="none" autoCorrect={false} maxLength={256} style={styles.input} /></Field>
            <Field label={t('delegation.effort')}><TextInput accessibilityLabel={t('delegation.effort')} testID="delegation-settings-effort" value={draft.effort} placeholder={t('delegation.nativeDefault')} placeholderTextColor={theme.colors.textSecondary}
                onChangeText={effort => edit({ effort })} editable={!busy} autoCapitalize="none" autoCorrect={false} maxLength={100} style={styles.input} /></Field>
        </> : null}
    </>;
    const closeEditor = () => { void back(true); };
    const primary = editing ? {
        label: t(view === 'create' && step === 1 ? 'delegation.nextStep' : view === 'create' ? 'delegation.createRole' : 'delegation.saveChanges'),
        loading: busy, disabled: busy || (step === 2 || view === 'edit') && (controller.loading || !canManage),
        onPress: () => { if (view === 'create' && step === 1) { if (validateBasics()) { scrollPositions.delete('create:2'); cache.step = 2; setStep(2); } } else void save(); },
        testID: view === 'create' && step === 1 ? 'delegation-settings-next' : 'delegation-settings-save',
    } : undefined;
    return <RoleFlowScaffold title={t(view === 'list' ? 'delegation.settingsTitle' : view === 'detail' ? 'delegation.roleDetails' : view === 'create' ? 'delegation.newRole' : 'delegation.editRole')}
        subtitle={view === 'list' ? t('delegation.settingsSubtitle') : undefined}
        scrollKey={roleFlowScrollKey(view, step, selectedId)} scrollPositions={scrollPositions}
        back={view !== 'list' ? { label: t(view === 'detail' ? 'delegation.backToList' : view === 'create' && step === 2 ? 'delegation.previousStep' : 'common.cancel'),
            onPress: () => { void back(); }, disabled: busy, testID: 'delegation-settings-back' } : { label: t('common.back'), onPress: () => returnToSettings(router), testID: 'delegation-settings-exit' }}
        close={editing ? { label: t('common.cancel'), onPress: closeEditor, disabled: busy, testID: 'delegation-settings-close' } : inDesktopModal ? { label: t('sidebarLists.close'), onPress: () => { navigateDesktopModalBack(true); }, testID: 'delegation-settings-host-close' } : undefined}
        action={view === 'list' ? { label: t('delegation.newRole'), onPress: startCreate,
            icon: <Ionicons name="add-outline" size={19} color={theme.colors.button.primary.tint} />, testID: 'delegation-settings-new' }
            : view === 'detail' && saved ? { label: t('delegation.editRole'), onPress: startEdit, disabled: busy, testID: 'delegation-settings-edit' } : undefined}
        step={view === 'create' ? step : undefined}
        footer={primary ? { hint: view === 'create' && step === 1 ? t('delegation.stepHint', { step, total: 2 })
            : t(view === 'create' ? 'delegation.saveConfigFooter' : 'delegation.editConfigFooter'), primary,
            secondary: { label: t(view === 'create' && step === 2 ? 'delegation.previousStep' : 'common.cancel'),
                onPress: view === 'create' && step === 2 ? () => { void back(); } : closeEditor,
                disabled: busy, testID: view === 'create' && step === 2 ? 'delegation-settings-previous' : 'delegation-settings-cancel' } } : undefined}>
        {view === 'list' ? machineSelector : null}
        {controller.loading ? <Text style={styles.hintBlock}>{t('common.loading')}</Text> : null}
        {!canManage ? <Text style={styles.hintBlock}>{t(!machine.active ? 'delegation.offline' : machine.metadata?.delegationRoles !== 1 ? 'delegation.rolesProtocolHint' : 'delegation.roleLoadFailed')}</Text> : null}
        {failure || controller.error ? <Text style={styles.error} accessibilityRole="alert" testID="delegation-settings-error">{failure ?? controller.error}</Text> : null}
        {view === 'list' ? <>
            <Text style={styles.sectionTitle}>{t('delegation.rolesTitle')} <Text style={styles.hint}>{roles.length}</Text></Text>
            <Field label={t('delegation.searchRoles')}><View style={styles.search}>
                <Ionicons name="search-outline" size={18} color={theme.colors.textSecondary} />
                <TextInput accessibilityLabel={t('delegation.searchRoles')} testID="delegation-settings-search" value={query} placeholder={t('delegation.searchRoles')}
                    placeholderTextColor={theme.colors.textSecondary} onChangeText={value => { cache.query = value; setQuery(value); }} style={styles.searchInput} autoCorrect={false} />
                {query ? <RoleFlowButton label={t('delegation.clearSearch')} icon={<Ionicons name="close-outline" size={18} color={theme.colors.textSecondary} />}
                    onPress={() => { cache.query = ''; setQuery(''); }} variant="icon" testID="delegation-settings-clear-search" /> : null}
            </View></Field>
            {filtered.length ? <View style={styles.roleList}>{filtered.map(role => <Item key={role.id} title={role.name}
                subtitle={`${role.description}\n${agentLabel(role.agent)} · ${role.model ?? t('delegation.nativeDefault')}`} titleStyle={styles.roleName} subtitleStyle={styles.roleSubtitle}
                icon={<CodingAgentIcon agent={role.agent} size={28} />} onPress={() => choose(role.id)} testID={`delegation-settings-role-${role.id}`} />)}</View> : null}
            {!controller.loading && !filtered.length ? <View style={styles.empty}><Text style={styles.emptyTitle}>{t(roles.length ? 'delegation.searchNoResults' : 'delegation.firstRoleTitle')}</Text>
                {!roles.length ? <><Text style={styles.hint}>{t('delegation.firstRoleHint')}</Text><RoleFlowButton label={t('delegation.createWithAI')}
                    onPress={() => { startCreate(); void configureWithAI(true); }} disabled={!canManage || busy} testID="delegation-settings-empty-ai" /></> : null}</View> : null}
            <RoleFlowButton label={t('delegation.refresh')} disabled={busy || controller.loading || !canManage} loading={controller.loading}
                onPress={() => { setFailure(null); void controller.refresh(); }} variant="text" testID="delegation-settings-refresh" />
        </> : null}
        {view === 'detail' ? saved ? <>
            <View style={styles.detailHero}><CodingAgentIcon agent={saved.agent} size={38} /><View style={styles.heroCopy}><Text style={styles.heroName}>{saved.name}</Text><Text style={styles.heroDescription}>{saved.description}</Text></View></View>
            <View style={styles.detailAI}><RoleFlowButton label={t('delegation.adjustWithAI')} onPress={() => { void configureWithAI(); }} disabled={!canManage || busy}
                loading={busy} testID="delegation-settings-ai" /><Text style={[styles.hint, styles.flexCopy]}>{t('delegation.aiEditHint')}</Text></View>
            <RoleSection title={t('delegation.executionStep')}>
                <Item title={t('delegation.machine')} detail={machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id} showChevron={false} titleStyle={styles.detailLabel} detailStyle={styles.detailValue} style={styles.detailRow} />
                <Item title={t('delegation.agent')} detail={agentLabel(saved.agent)} showChevron={false} titleStyle={styles.detailLabel} detailStyle={styles.detailValue} style={styles.detailRow} />
                <Item title={t('delegation.model')} detail={modelLabel(saved.model)} showChevron={false} titleStyle={styles.detailLabel} detailStyle={styles.detailValue} style={styles.detailRow} testID="delegation-settings-saved-model" />
                <Item title={t('delegation.effort')} detail={saved.effort ?? t('delegation.nativeDefault')} showChevron={false} titleStyle={styles.detailLabel} detailStyle={styles.detailValue} style={styles.detailRow} />
                <Item title={t('delegation.autoDelegate')} detail={t(saved.autoDelegate ? 'delegation.autoSelectEnabled' : 'delegation.specifiedOnly')} showChevron={false} titleStyle={styles.detailLabel} detailStyle={styles.detailValue} style={styles.detailRow} />
            </RoleSection>
            <RoleSection title={t('delegation.roleCalling')}>
                <Item title={t('delegation.roleId')} subtitle={saved.id} titleStyle={styles.detailLabel} subtitleStyle={styles.roleSubtitle} style={styles.detailRow}
                    showChevron={false} testID="delegation-settings-id" rightElement={<InlineCopy value={saved.id} label={t('delegation.copyRoleId')} testID="delegation-settings-copy-id" />} />
            </RoleSection>
            <View style={styles.example}><Text style={styles.exampleText}>{t('delegation.useRolePrompt', { id: saved.id, name: saved.name })}</Text><InlineCopy value={t('delegation.useRolePrompt', { id: saved.id, name: saved.name })} label={t('delegation.copyExample')} testID="delegation-settings-copy-example" /></View>
            <View style={styles.dangerZone}><RoleFlowButton label={t('common.delete')} variant="danger" disabled={busy || !canManage || controller.loading} loading={busy}
                onPress={() => { void remove(); }} testID="delegation-settings-delete" /><Text style={styles.hint}>{t('delegation.deleteHint')}</Text></View>
        </> : !controller.loading && canManage && !controller.error ? <Text style={styles.hintBlock}>{t('delegation.roleNotFound')}</Text> : null : null}
        {editing ? <>
            {view === 'edit' || step === 1 ? <>{aiEntry(view === 'create')}
                {view === 'create' ? <View style={styles.intro}><Text style={styles.introTitle}>{t('delegation.createIntroTitle')}</Text><Text style={styles.hint}>{t('delegation.createIntroHint')}</Text></View>
                    : <Text style={styles.sectionTitle}>{t('delegation.responsibilityStep')}</Text>}{basics}</> : null}
            {view === 'edit' || step === 2 ? <>
                <View style={styles.intro}><Text style={view === 'create' ? styles.introTitle : styles.sectionTitle}>{t(view === 'create' ? 'delegation.executionIntroTitle' : 'delegation.executionStep')}</Text>
                    {view === 'create' ? <Text style={styles.hint}>{t('delegation.executionIntroHint')}</Text> : null}</View>{execution}</> : null}
            {view === 'edit' && saved ? <View style={styles.editID}><Text style={styles.hint}>{t('delegation.roleIdUnchanged')}</Text><Item title={t('delegation.roleId')} subtitle={saved.id}
                showChevron={false} titleStyle={styles.detailLabel} subtitleStyle={styles.roleSubtitle} style={styles.detailRow} testID="delegation-settings-id" /></View> : null}
        </> : null}
    </RoleFlowScaffold>;
});

function RoleSection({ title, children }: React.PropsWithChildren<{ title: string }>) {
    return <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text><View style={styles.sectionSurface}>{children}</View></View>;
}
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
    host: { flex: 1, minHeight: 0 },
    machineSection: { marginBottom: 24, borderColor: theme.colors.divider, borderWidth: 1, borderRadius: 9, overflow: 'hidden', backgroundColor: theme.colors.surface },
    machineRow: { minHeight: 48, paddingHorizontal: 14, paddingVertical: 12 },
    section: { marginBottom: 25 },
    sectionTitle: { ...Typography.default('semiBold'), color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20, marginBottom: 10 },
    sectionSurface: { borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 9, overflow: 'hidden', backgroundColor: theme.colors.surface },
    detailRow: { minHeight: 46, paddingHorizontal: 14, paddingVertical: 12 },
    detailLabel: { ...Typography.default(), color: theme.colors.textSecondary, fontSize: 12, lineHeight: 19 },
    detailValue: { ...Typography.default(), color: theme.colors.text, fontSize: 13, lineHeight: 21, flexShrink: 1 },
    roleList: { borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 10, overflow: 'hidden', backgroundColor: theme.colors.surface, marginBottom: 12 },
    roleName: { ...Typography.default('semiBold'), color: theme.colors.text, fontSize: 15, lineHeight: 21 },
    roleSubtitle: { ...Typography.default(), color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20 },
    search: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 11, borderColor: theme.colors.divider, borderWidth: 1, borderRadius: 8, backgroundColor: theme.colors.surface },
    searchInput: { ...Typography.default(), color: theme.colors.text, flex: 1, minWidth: 0, minHeight: 42, fontSize: 13, lineHeight: 20, paddingVertical: 10 },
    empty: { alignItems: 'center', gap: 12, paddingVertical: 36, paddingHorizontal: 14 },
    emptyTitle: { ...Typography.default('semiBold'), color: theme.colors.text, fontSize: 16, lineHeight: 23 },
    detailHero: { flexDirection: 'row', alignItems: 'flex-start', gap: 15, paddingTop: 4, paddingBottom: 24 },
    heroCopy: { flex: 1, minWidth: 0, gap: 8 },
    heroName: { ...Typography.default('semiBold'), color: theme.colors.text, fontSize: 20, lineHeight: 28 },
    heroDescription: { ...Typography.default(), color: theme.colors.textSecondary, fontSize: 13, lineHeight: 23 },
    detailAI: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 25 },
    flexCopy: { flex: 1, minWidth: 120 },
    aiEntry: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 16, padding: 17, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 9, backgroundColor: theme.colors.surface },
    aiEntryCopy: { flex: 1, minWidth: 160, gap: 5 },
    aiEntryTitle: { ...Typography.default('semiBold'), color: theme.colors.text, fontSize: 14, lineHeight: 22 },
    manualDivider: { flexDirection: 'row', alignItems: 'center', gap: 13, marginTop: 22, marginBottom: 25 },
    manualLabel: { ...Typography.default(), color: theme.colors.textSecondary, fontSize: 11, lineHeight: 18 },
    dividerLine: { flex: 1, height: 1, backgroundColor: theme.colors.divider },
    intro: { gap: 6, marginBottom: 20 },
    introTitle: { ...Typography.default('semiBold'), color: theme.colors.text, fontSize: 18, lineHeight: 27 },
    editID: { marginTop: 14 },
    dangerZone: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginTop: 28, paddingTop: 16, borderTopWidth: 1, borderTopColor: theme.colors.divider },
    field: { marginBottom: 20, gap: 8 },
    label: { ...Typography.default('regular'), color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19.5 },
    input: { ...Typography.default('regular'), color: theme.colors.text, borderColor: theme.colors.divider, borderWidth: 1, borderRadius: 8, backgroundColor: theme.colors.input.background, paddingHorizontal: 12, paddingVertical: 11, minHeight: 46, fontSize: 14, lineHeight: 22.4 },
    multiline: { minHeight: 114, textAlignVertical: 'top' },
    hint: { ...Typography.default('regular'), color: theme.colors.textSecondary, fontSize: 12, lineHeight: 19 },
    hintBlock: { ...Typography.default('regular'), color: theme.colors.textSecondary, fontSize: 12, lineHeight: 19, paddingVertical: 12 },
    error: { paddingVertical: 12, color: theme.colors.textDestructive, fontSize: 13, lineHeight: 20 },
    fieldError: { color: theme.colors.textDestructive, fontSize: 12, lineHeight: 18 },
    choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    choice: { flexDirection: 'row', alignItems: 'center', gap: 8, borderColor: theme.colors.divider, borderWidth: 1, borderRadius: 7, paddingVertical: 10, paddingHorizontal: 12, backgroundColor: theme.colors.surface, minHeight: 42, justifyContent: 'center' },
    choiceText: { color: theme.colors.text, fontSize: 13 },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    selected: { backgroundColor: theme.colors.surfaceSelected },
    focused: { borderColor: theme.colors.textLink },
    toggle: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 16 },
    toggleCopy: { flex: 1, gap: 4 },
    toggleLabel: { ...Typography.default('regular'), color: theme.colors.text, fontSize: 14, lineHeight: 21 },
    steps: { flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: 22, paddingHorizontal: 16, paddingVertical: 14 },
    step: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 21 },
    currentStep: { color: theme.colors.text, fontWeight: '600' },
    example: { gap: 8, marginTop: -10, paddingBottom: 6 },
    exampleText: { ...Typography.default('regular'), color: theme.colors.text, fontSize: 13, lineHeight: 23, backgroundColor: theme.colors.surfacePressed, borderRadius: 8, padding: 14 },
    copyControl: { flexDirection: 'column', alignItems: 'flex-start', minWidth: 80 },
    copyButton: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 6, padding: 5, borderRadius: 6 },
    copyLabel: { fontSize: 12, color: theme.colors.textSecondary },
    copyStatus: { color: theme.colors.textSecondary, fontSize: 11, lineHeight: 16, minHeight: 16 },
}));
