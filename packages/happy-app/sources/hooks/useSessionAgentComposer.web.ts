import { Modal } from '@/modal';
import { getAgentPermissionModeForTaskLevel, getTaskPermissionLevelForAgentMode, resolveTaskPermissionAgent } from '@/utils/taskPermissionModes';
import * as React from 'react';
import { useAllSessions, useMachine, useSetting } from '@/sync/storage';
import { enabledCodingAgents, getCodingAgentCycle } from '@/utils/codingAgentSelection';
import { getLatestSessionModelMetadata } from '@/utils/newSessionModelMetadata';
import { resolveNewSessionModeSelection } from '@/utils/newSessionModeSelection';
import { getSuggestedModelModes, getEffortLevelsForModel } from '@/components/modelModeOptions';
import { isMachineOnline } from '@/utils/machineUtils';
import { supportsCodexFast } from '@/utils/codexFast';
import { useClaudeModelCatalog } from './useClaudeModelCatalog';
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
    const [draft, setDraft] = React.useState<{ scope: string; agent: NewSessionAgentType; choices: Partial<Record<NewSessionAgentType, Choice>> }>({ scope, agent: current, choices: {} });
    React.useEffect(() => {
        const currentDefaults = resolveAgentDefaultConfig(defaults, 'codex');
        setDraft(previous => {
            const codex = previous.choices.codex;
            const resetModel = codex?.modelSelection && codex.modelSelection.defaultValue !== currentDefaults.modelMode;
            const resetEffort = codex?.effortSelection && codex.effortSelection.defaultValue !== currentDefaults.effortLevel;
            if (!codex || (!resetModel && !resetEffort)) return previous;
            return { ...previous, choices: { ...previous.choices, codex: {
                ...codex,
                ...(resetModel ? { modelMode: undefined, modelSelection: undefined } : {}),
                ...(resetEffort ? { effortLevel: undefined, effortSelection: undefined } : {}),
            } } };
        });
    }, [defaults]);
    const available = getCodingAgentCycle(enabledCodingAgents(agents, machineId, configured, machine?.metadata?.cliAvailability));
    // The running Agent is always a valid destination for cancelling a staged switch.
    const cycle = getCodingAgentCycle(agents.filter(a => a.key === current || available.some(b => b.key === a.key)));
    const selected = draft.scope === scope && cycle.some(a => a.key === draft.agent) ? draft.agent : current;
    const pending = selected !== current;
    const activeSelection = React.useRef({ scope, selected });
    activeSelection.current = { scope, selected };
    const choice = draft.scope === scope ? draft.choices[selected] : undefined;
    const online = Boolean(machine && isMachineOnline(machine));
    const claude = useClaudeModelCatalog({ machineId, directory, enabled: pending && selected === 'claude' && online });
    const metadata = getLatestSessionModelMetadata({ sessions, selectedMachineId: machineId, agent: selected, codexAccountProfileId: accountProfile });
    const modelMetadata: Metadata | null = selected === 'claude' && claude.catalog
        ? { ...metadata, host: metadata?.host ?? '', path: directory ?? '', flavor: 'claude', models: claude.catalog.models, modelsUpdatedAt: claude.catalog.observedAt }
        : metadata;
    const models = selected === 'codex' && (accountProfile === undefined || !modelMetadata?.models?.length)
        ? [{ key: 'default', name: t('agentInput.model.cliAutomatic'), description: null }]
        : getSuggestedModelModes(selected, modelMetadata, t);
    const selection = resolveNewSessionModeSelection({ agent: selected, permissionMode: choice?.permissionMode,
        modelMode: choice?.modelMode, effortLevel: choice?.effortLevel,
        modelSelection: choice?.modelSelection, effortSelection: choice?.effortSelection, agentDefaultOverrides: defaults,
        modelOptions: models, effortMetadata: modelMetadata });
    if (choice?.permissionMode) selection.permissionMode = choice.permissionMode;
    const effortLevels = getEffortLevelsForModel(selected, selection.modelMode, modelMetadata);
    const spawn = useSpawnSession();
    const busy = spawn.sending || Boolean(spawn.hydrationError);
    const update = (change: Choice) => {
        if (busy) return;
        setDraft(previous => ({ scope, agent: selected, choices: { ...(previous.scope === scope ? previous.choices : {}),
            [selected]: { ...choice, ...change } } }));
    };
    const targetAvailable = available.some(a => a.key === selected);
    const disabled = !online || !targetAvailable || (selected === 'codex' && accountProfile === undefined);
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
            ...(selected === 'codex' ? { expectedCodexAccountProfileId: accountProfile } : {}),
            prompt: submission.prompt, images: submission.images,
        }, false, args.flushDraft);
    };
    if (!directory || !machineId || !agents.some(a => a.key === current) || session.metadata?.application) return undefined;
    const next = cycle[(cycle.findIndex(a => a.key === selected) + 1) % cycle.length];
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
                if (activeSelection.current.scope !== scope || activeSelection.current.selected !== selected) return false;
                update({ permissionMode: mode });
                return true;
            },
        } : undefined,
        modeSelector: {
            ...(pending ? {
                online, unifiedCodex: selected === 'codex', refreshScope: `${scope}:${selected}`,
                model: selected === 'codex' && selection.modelMode === 'default'
                    ? { key: 'default', name: t('agentInput.model.cliAutomatic') }
                    : models.find(m => m.key === selection.modelMode) ?? null, modelOptions: models,
                effort: effortLevels.find(e => e.key === selection.effortLevel) ?? null, effortOptions: effortLevels,
                onModelChange: key => update({ modelMode: key, fastMode: false,
                    modelSelection: { agent: selected, defaultValue: resolveAgentDefaultConfig(defaults, selected).modelMode } }),
                onEffortChange: key => update({ effortLevel: key,
                    effortSelection: { agent: selected, defaultValue: resolveAgentDefaultConfig(defaults, selected).effortLevel } }),
                onRefreshModels: selected === 'claude' ? claude.refresh : undefined,
                supportsFast: supportsCodexFast(modelMetadata, selection.modelMode), fastMode: choice?.fastMode === true,
                onFastModeChange: enabled => update({ fastMode: enabled }),
            } : base),
            online: online && (pending || base.online),
            agentSwitcher: { id: selected, current: agents.find(a => a.key === selected)!.label,
                next: busy || cycle.length < 2 ? null : next.label,
                onSwitch: () => { if (!busy && cycle.length > 1) setDraft(previous => ({ scope, agent: next.key, choices: previous.scope === scope ? previous.choices : {} })); },
            },
        },
    };
}
