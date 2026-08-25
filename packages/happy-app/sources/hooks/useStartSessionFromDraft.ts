import * as React from 'react';
import { useAllMachines, useSetting } from '@/sync/storage';
import { getCodeAgentDefaults, resolveAgentDefaultConfig } from '@/sync/agentDefaults';
import {
    machineSpawnNewSession,
    machineStopSession,
    sessionArchive,
    sessionKill,
    sessionSetAgentModes,
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
    includeConfiguredModel,
} from '@/components/modelModeOptions';
import { Modal } from '@/modal';
import { t } from '@/text';
import {
    collectMachineChoices,
    findMachineChoice,
    resolveAgentMachine,
    resolveChoiceAgent,
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
    resolveSpawnRequestId,
} from '@/sync/spawnRequestId';
import type { NewSessionStartPhase } from '@/components/newSessionProgress';

const MAX_RIG_PENDING_RESULTS = 3;

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
    signal: Promise<typeof CANCELED>;
    cancel: () => void;
};

function beginRun(): StartRun {
    let resolve!: (value: typeof CANCELED) => void;
    const signal = new Promise<typeof CANCELED>((r) => { resolve = r; });
    const run: StartRun = {
        canceled: false,
        signal,
        cancel: () => {
            run.canceled = true;
            resolve(CANCELED);
        },
    };
    return run;
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
        if (!run) return;
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

    const startSession = React.useCallback(async (): Promise<boolean> => {
        if (activeRunRef.current) return false;

        const draft = useNewSessionDraft.getState();
        // The draft names a computer, which may run both Happy CLI and Happy Agent. Which daemon
        // receives the request follows from the agent, so it is settled here rather than by
        // whichever machine id the draft happened to store.
        const choice = findMachineChoice(collectMachineChoices(machines), draft.selectedMachineId);
        if (!choice) {
            Modal.alert(t('common.error'), 'Please select a machine');
            return false;
        }

        // The draft survives machine changes and app upgrades. Resolve it again
        // at launch time so a stale Claude selection cannot spawn Claude while
        // the selected computer only reports Codex (the Android 1.7.0 regression).
        const agentType = resolveChoiceAgent(choice, draft.agentType);
        const agentChanged = agentType !== draft.agentType;
        const machine = resolveAgentMachine(choice, agentType);
        if (!machine) {
            Modal.alert(
                t('common.error'),
                agentType === 'rig'
                    ? 'Happy Agent is not running on this computer'
                    : 'This computer has no Happy CLI daemon to start that agent',
            );
            return false;
        }
        if (!isMachineOnline(machine)) {
            Modal.alert(t('common.error'), 'Machine is offline');
            return false;
        }
        const rigCreation = agentType === 'rig'
            ? getRigMachineSessionCreation(machine.metadata)
            : null;
        if (agentType === 'rig' && !rigCreation) {
            Modal.alert(t('common.error'), 'This machine cannot start Happy agent sessions');
            return false;
        }
        const defaults = rigCreation
            ? {
                permissionMode: rigCreation.defaultPermissionMode ?? '',
                modelMode: rigCreation.defaultModelKey ?? '',
                effortLevel: rigCreation.defaultEffortForModel(rigCreation.defaultModelKey),
            }
            : resolveAgentDefaultConfig(defaultOverrides, agentType);
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
                ? [defaults.permissionMode, rigCreation ? null : getCodeAgentDefaults(agentType).permissionMode]
                : [draft.permissionMode, defaults.permissionMode, rigCreation ? null : getCodeAgentDefaults(agentType).permissionMode],
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

        const prompt = draft.input.trim();
        const attachments = draft.attachments;
        const selectedPath = draft.selectedPath?.trim() || '~';
        const absolutePath = resolveAbsolutePath(selectedPath, machine.metadata?.homeDir);
        const requestedWorktree = draft.sessionType === 'worktree'
            ? draft.worktreeKey ?? '__new__'
            : '__none__';
        // A workspace that already exists is only a directory to start in, so it stands whatever
        // the machine says about making new ones. Making one is what the capability governs.
        const worktreeSelection = rigCreation?.supportsWorktrees === false && requestedWorktree === '__new__'
            ? '__none__'
            : requestedWorktree;
        // Reused across every retry of this exact request so a second press of
        // Start is deduped by Rig instead of spawning a second session.
        const clientRequestId = resolveSpawnRequestId(buildSpawnRequestSignature({
            machineId: machine.id,
            agent: agentType,
            directory: selectedPath,
            worktree: worktreeSelection,
            modelKey: model.key,
            permissionMode: permission.key,
            effort: effort?.key ?? null,
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
            // The daemon first: it holds the child process and its socket is the
            // one this session was spawned through. The session's own kill RPC
            // is tried after, for a session already up and detached from the
            // daemon, and the archive last so a session nobody can reach still
            // leaves the active list rather than sitting there as debris.
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
            let spawnDirectory = absolutePath;
            if (worktreeSelection === '__new__') {
                const worktreeResult = await untilCanceled(createWorktree(machine.id, absolutePath));
                // The worktree itself is left wherever git got to: it is a
                // directory, not a running agent, and the next start offers it.
                if (worktreeResult === CANCELED) return false;
                if (!worktreeResult.success) {
                    Modal.alert(t('common.error'), worktreeResult.error || 'Failed to create worktree');
                    return false;
                }
                spawnDirectory = worktreeResult.worktreePath;
                showPhase('spawning');
            } else if (worktreeSelection !== '__none__') {
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

            const spawning = spawn();
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
            // The idempotency key did its job; the next Start is a new session.
            completeSpawnRequest();
            showPhase('opening');

            if (await untilCanceled(sync.refreshSessions()) === CANCELED) {
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

            // Last look before anything becomes irreversible. Past this line the
            // prompt is cleared, the screen changes, and the message goes out —
            // a Stop that lands a moment too late must not do all three anyway.
            if (run.canceled) {
                void stopAbandonedSession(sessionId);
                return false;
            }

            draft.setInput('');
            draft.setAttachments([]);
            navigateToSession(sessionId);
            if (prompt || attachments.length > 0) {
                // The session is ready at this point. Open it immediately and
                // let the first message enqueue without keeping the user on Home
                // during image upload or a slower network round-trip.
                void sync.sendMessage(sessionId, prompt, { source: 'new_session', attachments }).catch((error) => {
                    Modal.alert(
                        t('common.error'),
                        error instanceof Error ? error.message : 'Failed to send the first message',
                    );
                });
            }
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
