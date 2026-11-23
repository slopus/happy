import { Modal } from '@/modal';
import { getAgentPermissionModeForTaskLevel, getTaskPermissionLevelForAgentMode, resolveTaskPermissionAgent } from '@/utils/taskPermissionModes';
import * as React from 'react';
import { useAllSessions, useMachine, useSetting } from '@/sync/storage';
import { enabledCodingAgents } from '@/utils/codingAgentSelection';
import { getLatestSessionModelMetadata } from '@/utils/newSessionModelMetadata';
import { resolveNewSessionModeSelection } from '@/utils/newSessionModeSelection';
import { getSuggestedModelModes, getEffortLevelsForModel } from '@/components/modelModeOptions';
import { isMachineOnline } from '@/utils/machineUtils';
import { supportsCodexFast } from '@/utils/codexFast';
import { useClaudeModelCatalog } from './useClaudeModelCatalog';
import { useMagpieModelCatalog } from './useMagpieModelCatalog';
import { useCodexAccounts } from './useCodexAccounts';
import { useSpawnSession } from './useSpawnSession';
import { t } from '@/text';
import type { DraftModeSelection, NewSessionAgentType } from '@/sync/persistence';
import { resolveAgentDefaultConfig } from '@/sync/agentDefaults';
import type { Metadata } from '@/sync/storageTypes';
import type { SessionAgentComposerArgs, SessionAgentComposer } from './useSessionAgentComposer.types';

const agents: { key: NewSessionAgentType; label: string }[] = [
    { key: 'codex', label: 'Codex' }, { key: 'claude', label: 'Claude Code' },
    { key: 'opencode', label: 'OpenCode' }, { key: 'antigravity', label: 'Antigravity' },
    { key: 'openclaw', label: 'OpenClaw' },
];
type Choice = { permissionMode?: string | null; modelMode?: string | null; effortLevel?: string | null;
    modelSelection?: DraftModeSelection; effortSelection?: DraftModeSelection; fastMode?: boolean };
export function useSessionAgentComposer(args: SessionAgentComposerArgs): SessionAgentComposer | undefined {
    const { session, base } = args;
    const machineId = session.metadata?.machineId ?? null;
    const directory = session.metadata?.path ?? null;
    const machine = useMachine(machineId ?? '');
    const sessions = useAllSessions();
    const configured = useSetting('codingAgentMachines');
    const defaults = useSetting('agentDefaultOverrides');
    const accounts = useCodexAccounts();
    const accountProfile = accounts.loading || accounts.error ? undefined
        : accounts.bindings.find(b => b.machineId === machineId)?.profileId ?? null;
    const flavor = session.metadata?.flavor ?? 'claude';
    const current = (['gpt', 'openai'].includes(flavor) ? 'codex' : flavor) as NewSessionAgentType;
    const scope = JSON.stringify([session.id, machineId, directory]);
    const [draft, setDraft] = React.useState<{ scope: string; agent: NewSessionAgentType; magpie?: boolean; choices: Partial<Record<NewSessionAgentType, Choice>> }>({ scope, agent: current, choices: {} });
    React.useEffect(() => {
        const currentDefaults = resolveAgentDefaultConfig(defaults, 'codex');
        setDraft(previous => {
            const codex = previous.choices.codex;
            const resetModel = !previous.magpie && codex?.modelSelection && codex.modelSelection.defaultValue !== currentDefaults.modelMode;
            const resetEffort = codex?.effortSelection && codex.effortSelection.defaultValue !== currentDefaults.effortLevel;
            if (!codex || (!resetModel && !resetEffort)) return previous;
            return { ...previous, choices: { ...previous.choices, codex: {
                ...codex,
                ...(resetModel ? { modelMode: undefined, modelSelection: undefined } : {}),
                ...(resetEffort ? { effortLevel: undefined, effortSelection: undefined } : {}),
            } } };
        });
    }, [defaults]);
    const available = enabledCodingAgents(agents, machineId, configured, machine?.metadata?.cliAvailability);
    // The current agent remains available for cancelling a staged switch.
    const destinations = agents.filter(agent => agent.key === current || available.some(other => other.key === agent.key));
    const selected = draft.scope === scope && destinations.some(a => a.key === draft.agent) ? draft.agent : current;
    const useMagpie = draft.scope === scope && selected === 'codex' && draft.magpie === true;
    const pending = selected !== current || useMagpie;
    const activeSelection = React.useRef({ scope, selected, useMagpie });
    activeSelection.current = { scope, selected, useMagpie };
    const choice = draft.scope === scope ? draft.choices[selected] : undefined;
    const online = Boolean(machine && isMachineOnline(machine));
    const runningMagpie = current === 'codex' && !session.metadata?.codexAccountProfileId && session.metadata?.codexMagpieConnection === true;
    const discoverMagpie = online && !runningMagpie && !!machine?.metadata?.magpieModelCatalog
        && !session.metadata?.application && available.some(agent => agent.key === 'codex');
    const magpie = useMagpieModelCatalog(machineId, directory, discoverMagpie);
    const magpieMetadata: Metadata | null = magpie.catalog && !runningMagpie
        ? { path: directory ?? '', host: '', flavor: 'codex', ...magpie.catalog }
        : null;
    const magpieModels = magpieMetadata ? getSuggestedModelModes('codex', magpieMetadata, t) : [];
    const claude = useClaudeModelCatalog({ machineId, directory, enabled: pending && selected === 'claude' && online });
    const metadata = getLatestSessionModelMetadata({ sessions, selectedMachineId: machineId, agent: selected, codexAccountProfileId: accountProfile });
    const modelMetadata: Metadata | null = useMagpie ? magpieMetadata : selected === 'claude' && claude.catalog
        ? { ...metadata, host: metadata?.host ?? '', path: directory ?? '', flavor: 'claude', models: claude.catalog.models, modelsUpdatedAt: claude.catalog.observedAt }
        : metadata;
    const models = useMagpie ? magpieModels : selected === 'codex' && (accountProfile === undefined || !modelMetadata?.models?.length)
        ? [{ key: 'default', name: t('agentInput.model.cliAutomatic'), description: null }]
        : getSuggestedModelModes(selected, modelMetadata, t);
    const selection = resolveNewSessionModeSelection({ agent: selected, permissionMode: choice?.permissionMode,
        modelMode: choice?.modelMode, effortLevel: choice?.effortLevel,
        modelSelection: useMagpie ? { agent: 'codex', defaultValue: resolveAgentDefaultConfig(defaults, 'codex').modelMode } : choice?.modelSelection,
        effortSelection: choice?.effortSelection, agentDefaultOverrides: defaults,
        modelOptions: models, effortMetadata: modelMetadata });
    if (choice?.permissionMode) selection.permissionMode = choice.permissionMode;
    const explicitCodexModel = selected === 'codex' && choice?.modelMode && choice.modelMode !== 'default'
        && (useMagpie || (choice.modelSelection?.agent === 'codex'
            && choice.modelSelection.defaultValue === resolveAgentDefaultConfig(defaults, 'codex').modelMode))
        ? choice.modelMode : null;
    const modelUnavailable = explicitCodexModel !== null && !models.some(model => model.key === explicitCodexModel);
    const effortLevels = modelUnavailable ? [] : getEffortLevelsForModel(selected, selection.modelMode, modelMetadata);
    const spawn = useSpawnSession();
    const busy = spawn.sending || Boolean(spawn.hydrationError);
    const update = (change: Choice) => {
        if (busy) return;
        setDraft(previous => ({ scope, agent: selected, magpie: useMagpie, choices: { ...(previous.scope === scope ? previous.choices : {}),
            [selected]: { ...(previous.scope === scope ? previous.choices[selected] : undefined), ...change } } }));
    };
    const targetAvailable = available.some(a => a.key === selected);
    const disabled = !online || !targetAvailable || modelUnavailable
        || (selected === 'codex' && !useMagpie && accountProfile === undefined);
    const submit = async () => {
        if (!pending || disabled || spawn.sending) return false;
        if (spawn.hydrationError) return spawn.retryHydration();
        args.flushDraft();
        let submission: ReturnType<SessionAgentComposerArgs['readSubmission']>;
        try { submission = args.readSubmission(); }
        catch (error) { Modal.alert(t('common.error'), error instanceof Error ? error.message : String(error)); return false; }
        const attachments = submission.images ?? [];
        const supportsAttachments = selected === 'claude' || selected === 'codex'
            || (selected === 'opencode' && attachments.every(a => !a.kind || a.kind === 'image'));
        if (attachments.length && !supportsAttachments) {
            Modal.alert(t('imageUpload.notSupportedTitle'), t('imageUpload.notSupportedMessage'));
            return false;
        }
        return spawn.spawn({ machineId: machineId!, machine: machine!, path: directory, agent: selected,
            worktreeKey: null, ...selection, fastMode: choice?.fastMode === true && supportsCodexFast(modelMetadata, selection.modelMode),
            ...(useMagpie ? { magpieModel: selection.modelMode, expectedCodexAccountProfileId: null }
                : selected === 'codex' ? { expectedCodexAccountProfileId: accountProfile } : {}),
            prompt: submission.prompt, images: submission.images,
        }, false, args.flushDraft);
    };
    if (!directory || !machineId || !agents.some(a => a.key === current) || session.metadata?.application) return undefined;
    const selectAgent = (key: string) => {
        const target = destinations.find(agent => agent.key === key);
        if (busy || !target || (key === selected && !useMagpie)) return;
        setDraft(previous => {
            const choices = previous.scope === scope ? { ...previous.choices } : {};
            if (previous.magpie) delete choices.codex;
            return { scope, agent: target.key, choices };
        });
    };
    const nativeRoutes = magpieModels.map(model => ({
        ...model, key: `magpie::${model.key}`, connectionLabel: 'Magpie',
    }));
    const sourceModels = (useMagpie ? base.modelOptions : pending ? models : base.modelOptions)
        .map(model => ({ ...model, ...(nativeRoutes.length && current === 'codex' && (!pending || useMagpie)
            ? { connectionLabel: runningMagpie ? 'Magpie' : session.metadata?.codexAccountProfileId ? 'ChatGPT' : 'Codex' } : {}) }));
    const options = [...sourceModels, ...nativeRoutes];
    const stagedModel = modelUnavailable && explicitCodexModel
        ? { key: explicitCodexModel, name: explicitCodexModel }
        : selected === 'codex' && selection.modelMode === 'default'
        ? { key: 'default', name: t('agentInput.model.cliAutomatic') }
        : models.find(model => model.key === selection.modelMode) ?? null;
    const displayedModel = useMagpie
        ? { key: `magpie::${choice?.modelMode}`, name: magpieModels.find(model => model.key === choice?.modelMode)?.name ?? choice?.modelMode ?? '' }
        : pending ? stagedModel : base.model;
    const refreshCurrent = pending ? (selected === 'claude' ? claude.refresh : undefined) : base.onRefreshModels;
    const onModelChange = (key: string) => {
        if (busy) return;
        if (key.startsWith('magpie::')) {
            const modelId = key.slice('magpie::'.length);
            if (!magpieModels.some(model => model.key === modelId)) return;
            setDraft(previous => ({ scope, agent: 'codex', magpie: true, choices: {
                ...(previous.scope === scope ? previous.choices : {}),
                codex: { ...(useMagpie ? previous.choices.codex : {}), modelMode: modelId,
                    fastMode: useMagpie && choice?.fastMode === true && supportsCodexFast(magpieMetadata, modelId) },
            } }));
        } else if (useMagpie) {
            selectAgent(current);
            base.onModelChange(key);
        } else if (pending) {
            update({ modelMode: key, fastMode: false,
                modelSelection: { agent: selected, defaultValue: resolveAgentDefaultConfig(defaults, selected).modelMode } });
        } else {
            base.onModelChange(key);
        }
    };
    return { pendingAgent: pending ? selected : null, sending: spawn.sending, disabled,
        submit,
        permissionSelector: pending ? {
            online: online && !busy, supported: resolveTaskPermissionAgent(selected) !== null,
            supportsAutomatic: selected === 'codex', currentMode: selection.permissionMode,
            level: getTaskPermissionLevelForAgentMode(selected, selection.permissionMode), unavailableReason: null,
            onLevelChange: async level => {
                const mode = getAgentPermissionModeForTaskLevel(selected, level);
                if (!mode || busy || !online) return false;
                if (level === 'full-access' && getTaskPermissionLevelForAgentMode(selected, selection.permissionMode) !== 'full-access'
                    && !await Modal.confirm(t('agentInput.taskPermission.riskTitle'), t('agentInput.taskPermission.riskMessage'),
                        { cancelText: t('common.cancel'), confirmText: t('agentInput.taskPermission.riskConfirm'), destructive: true })) return false;
                if (activeSelection.current.scope !== scope || activeSelection.current.selected !== selected || activeSelection.current.useMagpie !== useMagpie) return false;
                update({ permissionMode: mode });
                return true;
            },
        } : undefined,
        modeSelector: {
            ...(pending ? {
                online, unifiedCodex: selected === 'codex', refreshScope: `${scope}:${selected}`,
                effort: effortLevels.find(e => e.key === selection.effortLevel) ?? null, effortOptions: effortLevels,
                onEffortChange: key => update({ effortLevel: key,
                    effortSelection: { agent: selected, defaultValue: resolveAgentDefaultConfig(defaults, selected).effortLevel } }),
                supportsFast: !modelUnavailable && supportsCodexFast(modelMetadata, selection.modelMode), fastMode: choice?.fastMode === true,
                onFastModeChange: enabled => update({ fastMode: enabled }),
            } : base),
            ownerScope: scope,
            online: online && (pending || base.online) && !busy,
            model: displayedModel,
            modelOptions: options,
            onRefreshModels: discoverMagpie || refreshCurrent ? async () => {
                await Promise.all([discoverMagpie ? magpie.refresh() : undefined, refreshCurrent?.()]);
            } : undefined,
            onModelChange,
            agentSwitcher: { id: selected, current: useMagpie || (runningMagpie && !pending) ? 'Magpie' : agents.find(a => a.key === selected)!.label,
                options: busy ? [] : destinations, onSelect: selectAgent,
            },
        },
    };
}
