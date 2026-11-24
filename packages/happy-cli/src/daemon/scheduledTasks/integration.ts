/** Adapts durable scheduling to the daemon's existing encrypted spawn/resume pipeline. */
import axios from 'axios';
import { stat, realpath } from 'node:fs/promises';
import { ScheduledRunClaimSchema, type ScheduledRunReport, type ScheduledTaskConfig } from '@slopus/happy-wire';
import { configuration } from '@/configuration';
import { ApiClient } from '@/api/api';
import type { Machine, Metadata, AgentState } from '@/api/types';
import { encodeBase64, decodeBase64, encrypt, decrypt } from '@/api/encryption';
import { flushScheduledReceipts } from '@/api/scheduledRun';
import type { TrackedSession } from '@/daemon/types';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { createScheduleJournal, scheduleJournalDirectory, type ScheduledSessionBinding } from './journal';
import { createScheduledTaskRunner } from './runner';
import { readSettings } from '@/persistence';
import { SCHEDULED_PERMISSION_ENV, scheduledLaunchPermission, assertScheduledRuntimeSupported } from './permissions';
import { scheduledWorkerPresence } from './workerPresence';

export function createDaemonScheduledTaskRunner(deps: {
    token: string; machine: Machine; api: ApiClient; accountIdentity: Uint8Array;
    spawn: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    resume: (sessionId: string, options?: { model?: string; permissionMode?: string; effort?: string | null; codexSessionGrant?: string; scheduledPermissionMode?: string }) => Promise<SpawnSessionResult>;
    find: (sessionId: string) => TrackedSession | undefined;
    restore: (binding: ScheduledSessionBinding) => void;
}) {
    const headers = { Authorization: `Bearer ${deps.token}` };
    const directory = scheduleJournalDirectory(deps.token, deps.accountIdentity);
    const sendReport = async (taskId: string, runId: string, report: ScheduledRunReport) => {
        await axios.post(`${configuration.serverUrl}/v1/scheduled-tasks/${taskId}/runs/${runId}/report`, report, { headers, timeout: 15000 });
    };
    const bindingFromTracked = (sessionId: string, config: ScheduledTaskConfig): ScheduledSessionBinding => {
        const session = deps.find(sessionId);
        if (!session?.encryption || !session.happySessionMetadataFromLocalWebhook) throw new Error('Scheduled session encryption unavailable');
        return { sessionId, agent: config.agent, directory: config.directory, profileId: session.happySessionMetadataFromLocalWebhook.codexAccountProfileId,
            saved: { encryptionKey: encodeBase64(session.encryption.encryptionKey), encryptionVariant: session.encryption.encryptionVariant,
                seq: session.encryption.seq, metadataVersion: session.encryption.metadataVersion, agentStateVersion: session.encryption.agentStateVersion,
                metadata: session.happySessionMetadataFromLocalWebhook, savedAt: Date.now() } };
    };
    return createScheduledTaskRunner({
        journal: createScheduleJournal(directory),
        decrypt: value => decrypt(deps.machine.encryptionKey, deps.machine.encryptionVariant, decodeBase64(value)),
        validate: async config => {
            if (!(await stat(config.directory)).isDirectory()) throw new Error('Working directory unavailable');
            if (config.effort === 'ultra') throw new Error('Unsupported reasoning level');
            assertScheduledRuntimeSupported(Boolean((await readSettings()).sandboxConfig?.enabled));
        },
        claim: async () => {
            const response = await axios.post(`${configuration.serverUrl}/v1/scheduled-tasks/machines/${encodeURIComponent(deps.machine.id)}/claim`, {}, { headers, timeout: 15000 });
            return ScheduledRunClaimSchema.array().parse(response.data.runs);
        },
        report: (run, report) => sendReport(run.taskId, run.id, report),
        flushReceipts: () => flushScheduledReceipts(directory, sendReport),
        start: async (config, binding) => {
            if (binding) {
                deps.restore(binding);
                const response = await axios.get(`${configuration.serverUrl}/v2/sessions/${encodeURIComponent(binding.sessionId)}`, { headers, timeout: 15000 });
                const raw = response.data.session;
                if (!raw) throw new Error('Task conversation unavailable');
                const key = decodeBase64(binding.saved.encryptionKey);
                const metadata = decrypt(key, binding.saved.encryptionVariant, decodeBase64(raw.metadata)) as Metadata | null;
                const state = raw.agentState ? decrypt(key, binding.saved.encryptionVariant, decodeBase64(raw.agentState)) as AgentState | null : null;
                if (!metadata || metadata.lifecycleState === 'archived' || metadata.lifecycleState === 'archiveRequested' || await realpath(metadata.path) !== await realpath(config.directory) || metadata.flavor !== config.agent
                    || metadata.codexAccountProfileId !== binding.profileId || state?.turnStatus?.status === 'running' || Object.keys(state?.requests ?? {}).length || (state?.queuedMessages ?? 0) > 0) throw new Error('Task conversation cannot be reused');
                const presence = scheduledWorkerPresence(metadata.hostPid);
                if (presence === 'unknown' || (presence === 'running' && !raw.active)) throw new Error('Task conversation worker cannot be verified');
                if (presence === 'stopped') {
                    const result = await deps.resume(binding.sessionId, { model: config.model, permissionMode: config.permissionMode, effort: config.effort,
                        scheduledPermissionMode: config.permissionMode,
                        codexSessionGrant: config.agent === 'codex' && binding.profileId ? (await deps.api.createCodexSessionGrant({ machineId: deps.machine.id, sourceSessionId: binding.sessionId })).grant : undefined });
                    if (result.type !== 'success' || result.sessionId !== binding.sessionId) throw new Error('Task conversation resume failed');
                }
                return { ...binding, saved: { ...binding.saved, metadata, seq: raw.seq, metadataVersion: raw.metadataVersion, agentStateVersion: raw.agentStateVersion, savedAt: Date.now() } };
            }
            const result = await deps.spawn({ directory: config.directory, agent: config.agent, approvedNewDirectoryCreation: false,
                environmentVariables: { [SCHEDULED_PERMISSION_ENV]: config.permissionMode },
                ...(config.agent === 'codex' ? { model: config.model, effort: config.effort as SpawnSessionOptions['effort'],
                    expectedCodexAccountProfileId: config.codexAccountProfileId,
                    ...(config.codexAccountProfileId ? { codexSessionGrant: (await deps.api.createCodexSessionGrant({ machineId: deps.machine.id })).grant } : {}) } : {}) });
            if (result.type !== 'success') throw new Error('Scheduled session launch failed');
            return bindingFromTracked(result.sessionId, config);
        },
        send: async (binding, run, config) => {
            const message = { role: 'user', content: { type: 'text', text: `${config.title}\n\n${config.prompt}` },
                meta: { sentFrom: 'paws-scheduled-task', permissionMode: scheduledLaunchPermission(config.agent, { [SCHEDULED_PERMISSION_ENV]: config.permissionMode }), permissionModeExplicit: true,
                    ...(config.agent === 'codex' ? { model: config.model ?? null, effort: config.effort ?? null } : {}),
                    scheduledRun: { taskId: run.taskId, runId: run.id, claimId: run.claimId!, notificationPolicy: run.notificationPolicy } } };
            const content = encodeBase64(encrypt(decodeBase64(binding.saved.encryptionKey), binding.saved.encryptionVariant, message));
            const snapshot = await axios.get(`${configuration.serverUrl}/v2/sessions/${encodeURIComponent(binding.sessionId)}`, { headers, timeout: 15000 });
            await axios.post(`${configuration.serverUrl}/v1/scheduled-tasks/${run.taskId}/runs/${run.id}/deliver`,
                { claimId: run.claimId!, content, expectedSessionSeq: snapshot.data.session.seq }, { headers, timeout: 15000 });
        },
    });
}
