import * as React from 'react';
import { storage, useAllMachines, useSetting } from '@/sync/storage';
import { getCodeAgentDefaults, resolveAgentDefaultConfig } from '@/sync/agentDefaults';
import {
    machineSpawnNewSession,
    machineStopSession,
    sessionArchive,
    sessionKill,
    sessionSetAgentModes,
    sessionSetAvatar,
} from '@/sync/ops';
import { sync } from '@/sync/sync';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { isMachineOnline } from '@/utils/machineUtils';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { createWorktree } from '@/utils/worktree';
import {
    getEffortLevelsForModel,
    getHardcodedModelModes,
    getHardcodedPermissionModes,
    filterPermissionModesForCli,
    getSupportsWorktree,
    includeConfiguredModel,
} from '@/components/modelModeOptions';
import { Modal } from '@/modal';
import { t } from '@/text';
import {
    collectMachineChoices,
    findMachineChoice,
    resolveAgentMachine,
    resolveChoiceAgent,
    resolveWorktreeCreationMachine,
} from '@/sync/machineChoices';
import { delay } from '@/utils/time';
import {
    buildRigSpawnConfiguration,
    getRigMachineSessionCreation,
    resolveRigPendingRetryDelayMs,
} from '@/sync/rigSessionCreation';
import {
    buildSpawnRequestSignature,
    completeSpawnRequest,
    getSpawnedSessionId,
    rememberSpawnedSession,
    resolveSpawnRequestId,
} from '@/sync/spawnRequestId';
import type { NewSessionStartPhase } from '@/components/newSessionProgress';
import type { Session } from '@/sync/storageTypes';
import type { AttachmentPreview } from '@/sync/attachmentTypes';
import type { NewSessionAgentType, NewSessionSessionType } from '@/sync/persistence';
import type { PermissionModeKey } from '@/components/PermissionModeSelector';
import { collectSessionPlaces, collectSessionWorkspaces, projectPlaceKey } from '@/sync/agentSessionPlaces';
import { resolveHappyAgentSpawnTarget, type HappyAgentSpawnTarget } from '@/sync/happyAgentSpawn';
import { paintBotFace } from '@/utils/botFacePaint';
import { describeBotNameProblem } from '@/utils/botName';

const MAX_RIG_PENDING_RESULTS = 3;

/**
 * What to start instead of what the composer's draft says.
 *
 * A session can be started from places that have no composer — the tab strip's
 * `+`, for one — where the target is already known and the persisted draft is
 * somebody else's. Overrides are read in place of the draft for this one start
 * and never written back to it.
 */
export interface StartSessionOverrides {
    selectedMachineId?: string | null;
    selectedPath?: string | null;
    /**
     * The catalog project to start in, for a project with no folder of its own. Naming a directory
     * above clears whatever project the draft held, so a caller never has to state both.
     */
    selectedProjectId?: string | null;
    agentType?: NewSessionAgentType;
    permissionMode?: PermissionModeKey | null;
    modelMode?: string | null;
    effortLevel?: string | null;
    sessionType?: NewSessionSessionType;
    worktreeKey?: string | null;
    input?: string;
    attachments?: AttachmentPreview[];
    /**
     * The Happy Agent catalog destination, when the caller already knows it.
     * The draft can only name a directory, which is then matched back to a
     * project and a workspace; a caller starting from an existing session holds
     * those identities already, and passing them avoids the path round-trip
     * that would otherwise import a known workspace as a second project.
     * Ignored unless the agent is Happy Agent; `null` forces a plain directory.
     */
    happyAgentTarget?: HappyAgentSpawnTarget | null;
    /**
     * Where to go once the session exists. The default pushes the session
     * screen, which is wrong for a caller already on one — the tab strip swaps
     * the route's session in place instead.
     */
    openSession?: (sessionId: string) => void;
}

// Stop has to be felt at once. A request already on its way to the machine
// cannot be recalled, and the machine may never answer it at all, so the flow
// stops waiting on it rather than waiting for it: every await below races this,
// and whatever the machine says afterwards is dealt with off screen.
const CANCELED = Symbol('canceled');

/**
 * One attempt at starting a session.
 *
 * Cancellation is per attempt rather than a shared flag, so an attempt that is
 * still unwinding cannot read — or write — the state of the one that replaced
 * it. `canceled` is what the flow checks between steps; `signal` is what its
 * awaits race, so a step already in flight ends immediately instead of at
 * whatever point the machine feels like answering.
 */
type StartRun = {
    canceled: boolean;
    controller: AbortController;
    accepted: boolean;
    signal: Promise<typeof CANCELED>;
    cancel: () => void;
};

function beginRun(): StartRun {
    let resolve!: (value: typeof CANCELED) => void;
    const signal = new Promise<typeof CANCELED>((r) => { resolve = r; });
    const run: StartRun = {
        canceled: false,
        controller: new AbortController(),
        accepted: false,
        signal,
        cancel: () => {
            run.canceled = true;
            run.controller.abort();
            resolve(CANCELED);
        },
    };
    return run;
}

/**
 * Paints the chosen face and puts it on the bot behind a session that is
 * already open on this phone. Reported rather than thrown: the bot exists by
 * now, and the caller decides what a missing face means.
 */
async function wearBotFace(
    sessionId: string,
    seed: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
    // Each leg is caught under its own name. The three do quite different
    // things — draw, upload, ask — and a bare message like "undefined is not an
    // object" says nothing about which of them was running when it was thrown.
    const leg = async <T,>(name: string, step: () => Promise<T>): Promise<T> => {
        try {
            return await step();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`${name}: ${message}`);
        }
    };
    try {
        const painting = await leg('painting the face', () => paintBotFace(seed));
        const uploaded = await leg('uploading the face', () => (
            sync.uploadSessionBlob(sessionId, 'face.png', painting.bytes)
        ));
        await leg('asking the bot to wear it', () => sessionSetAvatar(sessionId, {
            ref: uploaded.ref,
            size: uploaded.size,
            mimeType: painting.mimeType,
        }));
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

function resolveOption<T extends { key: string }>(
    options: T[],
    preferredKeys: Array<string | null | undefined>,
): T | null {
    for (const key of preferredKeys) {
        if (!key) continue;
        const option = options.find((candidate) => candidate.key === key);
        if (option) return option;
    }
    return options[0] ?? null;
}

export function useStartSessionFromDraft() {
    const machines = useAllMachines({ includeOffline: true });
    const defaultOverrides = useSetting('agentDefaultOverrides');
    const navigateToSession = useNavigateToSession();
    // The composer stays on screen for the whole flow, so what it is waiting on
    // is state rather than a bare boolean: creating a worktree, asking the
    // machine for a session, and opening it are three different waits.
    const [phase, setPhase] = React.useState<NewSessionStartPhase | null>(null);
    const activeRunRef = React.useRef<StartRun | null>(null);
    const isMountedRef = React.useRef(true);
    React.useEffect(() => {
        // Set on the way in as well as cleared on the way out. An effect that
        // only clears is wrong for any setup/cleanup/setup cycle — Strict Mode
        // does exactly that in development — and the flag would stay false for
        // a mounted hook, which silently skips the final phase reset and leaves
        // the composer spinning forever.
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    const cancelStart = React.useCallback(() => {
        const run = activeRunRef.current;
        if (!run || run.accepted) return;
        run.cancel();
        // Spent here, synchronously, and not when the canceled flow eventually
        // resumes. Stop hands the composer back on this same tick, so a new
        // Start can be pressed before that resumption ever runs — and if the
        // key were still pending it would be handed to that new attempt, which
        // the machine would then dedupe straight onto the session this cancel
        // is in the middle of killing.
        completeSpawnRequest();
        // The flow is let go of right here rather than when its body finishes
        // unwinding. Waiting for that is what left Stop useless: one await that
        // never returns and the composer, and every later Start, is held
        // hostage by an attempt nobody is watching any more.
        activeRunRef.current = null;
        if (isMountedRef.current) setPhase(null);
    }, []);

    const startSession = React.useCallback(async (overrides?: StartSessionOverrides): Promise<boolean> => {
        if (activeRunRef.current) return false;

        const {
            happyAgentTarget: targetOverride,
            openSession,
            ...draftOverrides
        } = overrides ?? {};
        const draftStore = useNewSessionDraft.getState();
        // A snapshot for this attempt to read. What the flow clears at the end
        // is the store as it stands then, and only when the prompt came from it.
        const draft = {
            ...draftStore,
            // A caller that names a directory has named the place. Keeping the draft's project
            // beside it would start the session in that project instead, which is somewhere the
            // caller never asked for.
            ...(draftOverrides.selectedPath !== undefined ? { selectedProjectId: null } : {}),
            ...draftOverrides,
        };
        // The draft names a computer, which may run both Happy CLI and Happy Agent. Which daemon
        // receives the request follows from the agent, so it is settled here rather than by
        // whichever machine id the draft happened to store.
        const choice = findMachineChoice(collectMachineChoices(machines), draft.selectedMachineId);
        if (!choice) {
            // Two different failures wear the same shape here. Nothing selected
            // is the composer's, and asking for a computer is the answer. A
            // computer that was named and cannot be found is not: the start came
            // from a session running on it, and telling the user to pick a
            // machine sends them looking for a control that is not on screen —
            // the sibling-chat `+` has no picker at all. A daemon signed in to a
            // different account than the sessions it publishes leaves exactly
            // this state, and it is worth naming rather than papering over.
            Modal.alert(
                t('common.error'),
                draft.selectedMachineId
                    ? 'This session’s computer is not registered with this account, so nothing can start a session on it. Check that Happy is running there and signed in to this account.'
                    : 'Please select a machine',
            );
            return false;
        }

        // The draft survives machine changes and app upgrades. Resolve it again
        // at launch time so a stale Claude selection cannot spawn Claude while
        // the selected computer only reports Codex (the Android 1.7.0 regression).
        // A bot is Happy Agent's to make whatever harness the draft last chose.
        const createsBot = draft.createsBot;
        const botName = draft.botName.trim();
        const botFaceSeed = draft.botFaceSeeds[draft.botFaceSlot];
        const botNameProblem = createsBot ? describeBotNameProblem(botName) : null;
        if (botNameProblem !== null) {
            Modal.alert(t('common.error'), botNameProblem);
            return false;
        }
        const agentType = createsBot ? 'rig' : resolveChoiceAgent(choice, draft.agentType);
        const agentChanged = agentType !== draft.agentType;
        const machine = resolveAgentMachine(choice, agentType);
        if (!machine) {
            Modal.alert(
                t('common.error'),
                agentType === 'rig'
                    ? 'Happy Agent is not running on this computer'
                    : 'Happy CLI is not available on your computer. Run `happy daemon start` on your computer, then try again.',
            );
            return false;
        }
        if (!isMachineOnline(machine)) {
            Modal.alert(
                t('common.error'),
                agentType === 'rig'
                    ? 'Machine is offline'
                    : 'Happy CLI is offline on your computer. Run `happy daemon start` on your computer, then try again.',
            );
            return false;
        }
        const rigCreation = agentType === 'rig'
            ? getRigMachineSessionCreation(machine.metadata)
            : null;
        if (agentType === 'rig' && !rigCreation) {
            Modal.alert(t('common.error'), 'This machine cannot start Happy agent sessions');
            return false;
        }
        if (createsBot && !rigCreation?.supportsBots) {
            Modal.alert(t('common.error'), 'Happy Agent on this computer cannot create bots yet. Update it and try again.');
            return false;
        }
        const defaults = rigCreation
            ? {
                permissionMode: rigCreation.defaultPermissionMode ?? '',
                modelMode: rigCreation.defaultModelKey ?? '',
                effortLevel: rigCreation.defaultEffortForModel(rigCreation.defaultModelKey),
            }
            : resolveAgentDefaultConfig(defaultOverrides, agentType, machine.metadata?.happyCliVersion);
        const permission = resolveOption<{ key: string }>(
            // The daemon machine's CLI is what will parse the mode; older CLIs
            // drop the whole prompt on modes they do not know (e.g. `auto`).
            rigCreation?.permissionModes ?? filterPermissionModesForCli(
                getHardcodedPermissionModes(agentType, t),
                machine.metadata?.happyCliVersion,
            ),
            // The code default last: when the saved and configured modes were
            // both filtered out for an old CLI, land there rather than on
            // whichever mode happens to lead the list.
            agentChanged
                ? [defaults.permissionMode, rigCreation ? null : getCodeAgentDefaults(agentType, machine.metadata?.happyCliVersion).permissionMode]
                : [draft.permissionMode, defaults.permissionMode, rigCreation ? null : getCodeAgentDefaults(agentType, machine.metadata?.happyCliVersion).permissionMode],
        );
        const model = resolveOption<{ key: string }>(
            rigCreation?.models ?? includeConfiguredModel(
                agentType,
                getHardcodedModelModes(agentType, t),
                defaults.modelMode,
            ),
            agentChanged
                ? [defaults.modelMode]
                : [draft.modelMode, defaults.modelMode],
        );
        const effortDefault = rigCreation?.defaultEffortForModel(model?.key)
            ?? defaults.effortLevel;
        const effort = resolveOption<{ key: string }>(
            rigCreation
                ? rigCreation.effortsForModel(model?.key).map((key) => ({ key, name: key }))
                : getEffortLevelsForModel(agentType, model?.key ?? 'default'),
            agentChanged
                ? [effortDefault]
                : [draft.effortLevel, effortDefault],
        );
        if (!permission || !model) {
            Modal.alert(t('common.error'), 'The selected agent configuration is unavailable');
            return false;
        }

        // A bot takes no first message from here: its conversation opens empty
        // and the prompt typed for a session stays in the draft, untouched.
        const prompt = createsBot ? '' : draft.input.trim();
        const attachments = createsBot ? [] : draft.attachments;
        let ownsCreatedSession = true;
        const isCurrentTarget = () => {
            const current = useNewSessionDraft.getState();
            // Only what the composer supplied is watched. A caller that named a
            // machine, a path or an agent itself never read the composer for it,
            // so the composer changing underneath says nothing about whether the
            // session being started is still the one that was asked for — and
            // treating it as a mismatch would put down every start made from a
            // chat's own `+`, which supplies all of them.
            const targetUnchanged = (['selectedMachineId', 'selectedPath', 'agentType', 'permissionMode', 'modelMode', 'effortLevel', 'sessionType', 'worktreeKey'] as const)
                .every(key => draftOverrides[key] !== undefined || current[key] === draft[key]);
            // A bot is only ever created from the composer — no override names
            // one — so these are always read straight off the draft.
            const botUnchanged = (['createsBot', 'botName', 'botFaceSeeds', 'botFaceSlot'] as const)
                .every(key => current[key] === draft[key]);
            return ownsCreatedSession && targetUnchanged && botUnchanged;
        };
        // A draft names either a directory or a catalog project. The project route asks Happy Agent
        // for the project by identity, so the path below is only a fallback for the directory route.
        const draftProjectId = draft.selectedProjectId?.trim() || null;
        if (draftProjectId && !rigCreation) {
            Modal.alert(
                t('common.error'),
                'Only Happy Agent knows where this project is, so no other harness can open it. Switch the harness back to Happy Agent, or pick the project’s folder.',
            );
            return false;
        }
        const selectedPath = draft.selectedPath?.trim() || '~';
        const absolutePath = resolveAbsolutePath(selectedPath, machine.metadata?.homeDir);
        // Read when Start is pressed rather than subscribed to. The session list
        // is rebuilt on every token a running agent sends, and this hook is
        // mounted on screens — the chat's own tab strip among them — that must
        // not re-render at that rate for a list only the press reads.
        const sessionList = (storage.getState().sessionsData ?? [])
            .filter((item): item is Session => typeof item !== 'string');
        const places = collectSessionPlaces({
            machineIds: choice.machineIds,
            selectedPath,
            sessions: sessionList,
        });
        const selectedProjectId = draftProjectId
            ?? places.find((place) => place.path === selectedPath)?.projectId
            ?? null;
        const projectWorkspaces = collectSessionWorkspaces({
            machineIds: choice.machineIds,
            projectId: selectedProjectId,
            sessions: sessionList,
        });
        const requestedWorktree = draft.sessionType === 'worktree'
            ? draft.worktreeKey ?? '__new__'
            : '__none__';
        let happyAgentTarget: HappyAgentSpawnTarget | null;
        try {
            // A bot is its own destination and only the composer asks for one,
            // so it is settled before the workspace routes below are consulted.
            happyAgentTarget = createsBot
                ? { kind: 'bot', name: botName }
                : rigCreation
                    ? (targetOverride !== undefined ? targetOverride : resolveHappyAgentSpawnTarget({
                        projectId: selectedProjectId,
                        workspaceSelection: requestedWorktree,
                        workspaces: projectWorkspaces,
                    }))
                    : null;
        } catch (error) {
            Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : 'The selected workspace is unavailable',
            );
            return false;
        }
        const worktreeCreationMachine = happyAgentTarget
            ? null
            : resolveWorktreeCreationMachine(
                choice,
                agentType,
                rigCreation?.supportsWorktrees
                    ?? (agentType === 'rig' ? false : getSupportsWorktree(agentType)),
            );
        // Happy Agent creates and selects catalog workspaces by durable identity. The Git RPC is
        // only for ordinary code-agent worktrees; without either route, a stale draft safely falls
        // back to the main tree.
        const worktreeSelection = !happyAgentTarget
            && !worktreeCreationMachine
            && requestedWorktree === '__new__'
            ? '__none__'
            : requestedWorktree;
        // Reused across every retry of this exact request so a second press of
        // Start is deduped by Rig instead of spawning a second session.
        const clientRequestId = resolveSpawnRequestId(buildSpawnRequestSignature({
            machineId: machine.id,
            agent: agentType,
            // Two catalog projects share the same empty path, so the project itself is what
            // distinguishes them: without it, starting in one would be deduped into the other.
            place: draftProjectId ? projectPlaceKey(draftProjectId) : selectedPath,
            worktree: worktreeSelection,
            modelKey: model.key,
            permissionMode: permission.key,
            effort: effort?.key ?? null,
            bot: createsBot ? { name: botName, faceSeed: botFaceSeed } : null,
        }));

        const run = beginRun();
        activeRunRef.current = run;
        // Stop returns the composer on the next tick, prompt still in it, no
        // matter what the machine is or is not doing.
        const untilCanceled = <T,>(work: Promise<T>): Promise<T | typeof CANCELED> =>
            Promise.race([work, run.signal]);
        // Only this attempt may drive the display, and only while it is still
        // the current one: a step finishing late must not raise a spinner over
        // a composer that has already been handed back.
        const showPhase = (next: NewSessionStartPhase) => {
            if (isMountedRef.current && activeRunRef.current === run) setPhase(next);
        };
        setPhase(worktreeSelection === '__new__' ? 'worktree' : 'spawning');
        // A session that arrives after Stop still has to be put down, and by
        // then nobody is on this screen to do it, so this runs unattended.
        const stopAbandonedSession = async (createdSessionId: string) => {
            // Every cleanup route shares this ownership, including late async
            // completions. Opening/using the session elsewhere revokes it.
            if (!ownsCreatedSession) return;
            ownsCreatedSession = false;
            // Happy Agent serves no machine stop: its session's own kill RPC
            // archives a bot in the catalog that owns it, which the generic
            // archive refuses. Happy CLI's daemon is asked first: it holds the
            // child process and its socket is the one this session was spawned
            // through. The session's own kill RPC is tried after, for a session
            // already up and detached from the daemon, and the archive last so a
            // session nobody can reach still leaves the active list rather than
            // sitting there as debris. A Stop pressed while Happy Agent's answer
            // is still pending leaves what it made; the next press makes another,
            // which is accepted over a cancel RPC for that one window.
            if (rigCreation) {
                const killed = await sessionKill(createdSessionId);
                if (!killed.success) {
                    console.error('[spawn] The abandoned Happy Agent session could not be put away:', killed.message);
                }
                await sync.refreshSessions().catch(() => { /* the list catches up on its own */ });
                return;
            }
            const stopped = await machineStopSession(machine.id, createdSessionId);
            if (!stopped.success) {
                const killed = await sessionKill(createdSessionId);
                if (!killed.success) {
                    await sessionArchive(createdSessionId);
                }
            }
            await sync.refreshSessions().catch(() => { /* the list catches up on its own */ });
        };
        try {
            const existingSessionId = getSpawnedSessionId(clientRequestId);
            let spawnDirectory = absolutePath;
            if (!existingSessionId && worktreeSelection === '__new__' && !happyAgentTarget) {
                // `worktreeSelection` can only remain `__new__` when a creation
                // machine was resolved above.
                const worktreeResult = await untilCanceled(createWorktree(worktreeCreationMachine!.id, absolutePath));
                // The worktree itself is left wherever git got to: it is a
                // directory, not a running agent, and the next start offers it.
                if (worktreeResult === CANCELED) return false;
                if (!worktreeResult.success) {
                    Modal.alert(t('common.error'), worktreeResult.error || 'Failed to create worktree');
                    return false;
                }
                spawnDirectory = worktreeResult.worktreePath;
                showPhase('spawning');
            } else if (worktreeSelection !== '__none__' && worktreeSelection !== '__new__') {
                spawnDirectory = worktreeSelection;
            }

            const spawn = async (approvedNewDirectoryCreation = false): Promise<string | null> => {
                const spawnOptions = rigCreation
                    ? {
                        machineId: machine.id,
                        ...buildRigSpawnConfiguration(machine.metadata, {
                            directory: spawnDirectory,
                            clientRequestId,
                            approvedNewDirectoryCreation,
                            modelKey: model.key,
                            permissionMode: permission.key,
                            effort: effort?.key,
                        }),
                        ...(happyAgentTarget ? { happyAgentTarget } : {}),
                    }
                    : {
                        machineId: machine.id,
                        directory: spawnDirectory,
                        approvedNewDirectoryCreation,
                        agent: agentType,
                        // Codex Default is a concrete ask-first policy, not an
                        // ambient absence of an override.
                        permissionMode: agentType === 'codex' || permission.key !== 'default'
                            ? permission.key
                            : undefined,
                        modelMode: model.key !== 'default' ? model.key : undefined,
                        effortLevel: effort?.key,
                    };
                let result = await machineSpawnNewSession(spawnOptions);
                let pendingResults = 0;
                while (result.type === 'pending' && pendingResults < MAX_RIG_PENDING_RESULTS) {
                    pendingResults += 1;
                    await delay(resolveRigPendingRetryDelayMs(
                        result.retryAfterMs,
                        rigCreation?.pendingRetryAfterMs,
                    ));
                    if (!isMountedRef.current || run.canceled) return null;
                    result = await machineSpawnNewSession(spawnOptions);
                }

                // The id comes back even when nobody is waiting on it any
                // more: a session that was really created is the caller's to
                // clean up, and it cannot do that without the id.
                if (result.type === 'success') return result.sessionId;
                if (!isMountedRef.current || run.canceled) return null;

                if (result.type === 'error') {
                    Modal.alert(t('common.error'), result.errorMessage);
                    return null;
                }
                if (result.type === 'pending') {
                    Modal.alert(
                        t('common.error'),
                        'The session was created, but it is still syncing. It should appear shortly.',
                    );
                    return null;
                }

                const approved = await Modal.confirm(
                    'Create Directory?',
                    `The directory '${result.directory}' does not exist. Would you like to create it?`,
                    { cancelText: t('common.cancel'), confirmText: t('common.create') },
                );
                return approved ? spawn(true) : null;
            };

            const spawning = existingSessionId ? Promise.resolve(existingSessionId) : spawn();
            const spawned = await untilCanceled(spawning);
            if (spawned === CANCELED) {
                // The key was already spent by cancelStart, on the tick Stop
                // was pressed. Nothing to do here but put down whatever the
                // machine hands back.
                void spawning
                    .then((late) => { if (late) return stopAbandonedSession(late); })
                    .catch(() => { /* the spawn already reported its own failure */ });
                return false;
            }
            const sessionId = spawned;
            if (!sessionId) return false;
            rememberSpawnedSession(clientRequestId, sessionId, () => {
                run.cancel();
                void stopAbandonedSession(sessionId).catch(error => console.error('Failed to stop abandoned session:', error));
            }, () => { ownsCreatedSession = false; });
            showPhase('opening');

            if (await untilCanceled(sync.ensureSessionReady(sessionId)) === CANCELED) {
                void stopAbandonedSession(sessionId);
                return false;
            }

            // Ownership must still hold before changing modes as well as before
            // sending: a session adopted elsewhere is no longer this attempt's.
            if (run.canceled || !isCurrentTarget()) {
                completeSpawnRequest(clientRequestId);
                void stopAbandonedSession(sessionId);
                return false;
            }

            if (!rigCreation) {
                // Pin the actual launch selection to this session. Keeping
                // defaults as null lets a later settings change rewrite an
                // existing session's displayed and transmitted mode/model.
                sessionSetAgentModes(sessionId, {
                    permissionMode: permission.key,
                    modelMode: model.key,
                    effortLevel: effort?.key ?? null,
                });
            }

            if (createsBot) {
                // The face travels as a session attachment, the way a picture
                // for a message does, then the bot is asked to wear it. A face
                // that cannot be painted or delivered is not a reason to lose
                // the bot that was just made: it opens without one, and says so.
                showPhase('avatar');
                const worn = await untilCanceled(wearBotFace(sessionId, botFaceSeed));
                if (worn === CANCELED) {
                    void stopAbandonedSession(sessionId);
                    return false;
                }
                if (!worn.ok) {
                    console.error('[bot] The face could not be put on the bot:', worn.error);
                    Modal.alert(
                        'Bot created without a face',
                        `${botName} is ready, but its picture could not be set: ${worn.error}`,
                    );
                }
            }

            if (prompt || attachments.length > 0) {
                const accepted = await untilCanceled(sync.sendMessage(sessionId, prompt, {
                    source: 'new_session', attachments, signal: run.controller.signal,
                    isCurrent: isCurrentTarget,
                    onAccepted: () => {
                        run.accepted = true;
                        completeSpawnRequest(clientRequestId);
                    },
                }));
                if (accepted === CANCELED) {
                    void stopAbandonedSession(sessionId);
                    return false;
                }
                if (!accepted) {
                    if (!isCurrentTarget()) {
                        completeSpawnRequest(clientRequestId);
                        void stopAbandonedSession(sessionId);
                    }
                    return false;
                }
            }
            completeSpawnRequest(clientRequestId);
            // Only what was consumed is cleared. A start that brought its own
            // prompt never read the draft, and emptying it would throw away
            // whatever the user has been typing on another screen.
            // Do not erase edits made while hydration or attachment upload ran.
            const currentDraft = useNewSessionDraft.getState();
            if (createsBot) {
                // The next bot starts from a clean name and fresh faces; the
                // composer goes back to offering a session, the ordinary case.
                if (currentDraft.botName === draft.botName) currentDraft.setBotName('');
                currentDraft.rollBotFaces();
                currentDraft.setCreatesBot(false);
            } else if (draftOverrides.input === undefined) {
                if (currentDraft.input === draft.input) currentDraft.setInput('');
                if (currentDraft.attachments === attachments) currentDraft.setAttachments([]);
            }
            (openSession ?? navigateToSession)(sessionId);
            return true;
        } catch (error) {
            // A failure the user already walked away from is not news.
            if (!run.canceled) {
                Modal.alert(
                    t('common.error'),
                    error instanceof Error ? error.message : 'Failed to start session',
                );
            }
            return false;
        } finally {
            // Only if this attempt is still the current one. A canceled attempt
            // gave up its claim the moment Stop was pressed, and a newer Start
            // may already own the composer by the time this line is reached.
            if (activeRunRef.current === run) {
                activeRunRef.current = null;
                if (isMountedRef.current) setPhase(null);
            }
        }
    }, [defaultOverrides, machines, navigateToSession]);

    return { isStarting: phase !== null, phase, startSession, cancelStart };
}
