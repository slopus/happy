/** Connect the native Personal engine to Paws encrypted sessions, permissions and lifecycle events. */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createEnvelope } from '@slopus/happy-wire';
import { ApiClient } from '@/api/api';
import type { UserMessage, Session } from '@/api/types';
import { decodeBase64, encodeBase64, decrypt } from '@/api/encryption';
import { initialMachineMetadata } from '@/daemon/machineMetadata';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { BasePermissionHandler } from '@/utils/BasePermissionHandler';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { readSettings, readPersistedSessions, type Credentials } from '@/persistence';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { connectionState } from '@/utils/serverConnectionErrors';
import { loadPersonalConfig, personalHome } from './config';
import { listPersonalSkills } from './skills';
import { PersonalEngine } from './engine';
import { personalPermissionMode, type PersonalPermissionMode } from './tools';

class PersonalPermissionHandler extends BasePermissionHandler {
    protected getLogPrefix(): string { return '[personal]'; }

    async approve(id: string, toolName: string, input: Record<string, unknown>, signal: AbortSignal): Promise<boolean> {
        signal.throwIfAborted();
        const cancel = () => this.cancelPendingRequest(id, 'Personal turn cancelled');
        const result = await new Promise<boolean>((resolve, reject) => {
            this.pendingRequests.set(id, { resolve: result => resolve(result.decision === 'approved' || result.decision === 'approved_for_session'),
                reject, toolName, input });
            this.addPendingRequestToState(id, toolName, input);
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) cancel();
        }).finally(() => signal.removeEventListener('abort', cancel));
        return result;
    }
}

export async function runPersonal(opts: { credentials: Credentials; startedBy?: 'daemon' | 'terminal'; resume?: string }): Promise<void> {
    const config = loadPersonalConfig();
    const home = personalHome();
    const saved = opts.resume && !process.env.HAPPY_RECONNECT_SESSION_ID ? readPersistedSessions()[opts.resume] : undefined;
    if (opts.resume && !process.env.HAPPY_RECONNECT_SESSION_ID) {
        if (saved?.metadata.flavor !== 'personal') throw new Error('No saved Personal session exists on this machine');
        process.chdir(saved.metadata.path);
    }
    const cwd = process.cwd();
    connectionState.setBackend('Paws Personal');
    const settings = await readSettings();
    if (!settings.machineId) throw new Error('No Paws machine is configured');
    const api = await ApiClient.create(opts.credentials);
    await api.assertUnmanagedArtifactRunner(settings.machineId, cwd);
    await api.getOrCreateMachine({ machineId: settings.machineId, metadata: initialMachineMetadata });
    const { state, metadata } = createSessionMetadata({ flavor: 'personal', machineId: settings.machineId,
        startedBy: opts.startedBy, skills: listPersonalSkills(home, cwd).map(skill => skill.name) });
    metadata.models = [{ code: config.model, value: config.model }];
    metadata.currentModelCode = config.model;
    metadata.currentOperatingModeCode = 'default';
    if (opts.resume && process.env.HAPPY_RECONNECT_METADATA_JSON) {
        const previous = JSON.parse(process.env.HAPPY_RECONNECT_METADATA_JSON) as typeof metadata;
        if (previous.flavor !== 'personal' || previous.machineId !== settings.machineId || previous.path !== cwd) throw new Error('Personal reconnect metadata belongs to a different execution');
        metadata.currentModelCode = previous.currentModelCode || config.model;
        metadata.currentOperatingModeCode = personalPermissionMode(previous.currentOperatingModeCode);
    }
    metadata.operatingModes = [
        { code: 'default', value: 'Confirm actions' }, { code: 'read-only', value: 'Read only' }, { code: 'yolo', value: 'Full access' },
    ];
    metadata.slashCommands = ['skills', 'status'];
    metadata.summary = { text: 'Paws Personal', updatedAt: Date.now() };
    const reconnectId = process.env.HAPPY_RECONNECT_SESSION_ID || (saved ? opts.resume : undefined);
    let response: Session | null;
    if (reconnectId) {
        if (!existsSync(join(home, 'sessions', `${reconnectId}.json`))) throw new Error('The original Personal transcript is missing. Restore it before resuming this session.');
        const key = process.env.HAPPY_RECONNECT_ENCRYPTION_KEY || saved?.encryptionKey;
        const variant = process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT || saved?.encryptionVariant;
        if (!key || !['legacy', 'dataKey'].includes(variant || '') || opts.resume !== reconnectId) throw new Error('Incomplete Personal session reconnect context');
        const encryptionKey = decodeBase64(key), encryptionVariant = variant as 'legacy' | 'dataKey';
        response = { id: reconnectId, encryptionKey, encryptionVariant,
            seq: Number(process.env.HAPPY_RECONNECT_SEQ || 0), metadata,
            metadataVersion: Number(process.env.HAPPY_RECONNECT_METADATA_VERSION || 0), agentState: state,
            agentStateVersion: Number(process.env.HAPPY_RECONNECT_AGENT_STATE_VERSION || 0) };
        if (saved) {
            const http = await fetch(`${configuration.serverUrl}/v2/sessions/${encodeURIComponent(reconnectId)}`, {
                headers: { Authorization: `Bearer ${opts.credentials.token}` }, signal: AbortSignal.timeout(15_000),
            });
            if (!http.ok) throw new Error(`Cannot verify Personal resume: HTTP ${http.status}`);
            const raw = (await http.json() as { session: { id: string; active: boolean; metadata: string; seq: number; metadataVersion: number; agentStateVersion: number } }).session;
            const remote = decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.metadata)) as typeof metadata | null;
            if (raw.id !== reconnectId || remote?.flavor !== 'personal' || remote.machineId !== settings.machineId || remote.path !== cwd) throw new Error('Personal resume identity does not match this machine and path');
            if (raw.active) throw new Error('Personal session is still active; use its existing conversation');
            response = { ...response, seq: raw.seq, metadataVersion: raw.metadataVersion, agentStateVersion: raw.agentStateVersion,
                metadata: { ...remote, ...metadata, summary: remote.summary, currentModelCode: remote.currentModelCode || config.model,
                    currentOperatingModeCode: personalPermissionMode(remote.currentOperatingModeCode) } };
        }
    } else {
        if (opts.resume) throw new Error('Use paws resume <Paws session ID> to reconnect an existing Personal session');
        response = await api.getOrCreateSession({ tag: randomUUID(), metadata, state });
    }
    if (!response) throw new Error('Paws server is unavailable; the Personal session was not started');
    const session = api.sessionSyncClient(response);
    session.keepAlive(false, 'remote');
    if (reconnectId) {
        session.skipExistingMessages();
        session.suppressNextArchiveSignal();
    }
    const permission = new PersonalPermissionHandler(session);
    permission.reset('Previous Personal execution stopped');
    const engine = new PersonalEngine({ home, cwd, sessionId: response.id, config, approve: (...args) => permission.approve(...args) });
    const queue: UserMessage[] = [];
    let active: AbortController | null = null;
    let stopped = false;
    let draining = false;
    let drainPromise: Promise<void> = Promise.resolve();
    let mode: PersonalPermissionMode = personalPermissionMode(response.metadata.currentOperatingModeCode);
    let model = response.metadata.currentModelCode || config.model;
    // Presence only: no business state queries, scans or storage access.
    const heartbeat = setInterval(() => session.keepAlive(active !== null, 'remote'), 5000);
    const drain = async () => {
        draining = true;
        try {
            while (!stopped && queue.length) {
                const message = queue.shift()!;
                await session.updateAgentState(state => ({ ...state, queuedMessages: queue.length }));
                const turn = randomUUID();
                session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'turn-start' }, { turn }));
                active = new AbortController();
                session.keepAlive(true, 'remote');
                try {
                    if (message.meta?.permissionMode !== undefined) mode = personalPermissionMode(message.meta.permissionMode);
                    if (message.meta?.model !== undefined) model = message.meta.model && message.meta.model !== 'default' ? message.meta.model : config.model;
                    await session.updateMetadataAndAwait(current => ({ ...current, currentModelCode: model, currentOperatingModeCode: mode }));
                    if (message.content.text === '/skills' || message.content.text === '/status') {
                        session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'text', text: message.content.text === '/skills'
                            ? engine.skills.map(skill => `${skill.name} — ${skill.capability}`).join('\n')
                            : `Paws Personal · ${model} · ${engine.skills.length} skills · ${mode}` }, { turn }));
                    } else {
                        await engine.turn(message.content.text, mode, active.signal, event => {
                            if (event.type === 'text') session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'text', text: event.text }, { turn }));
                            else if (event.type === 'tool-start') session.sendSessionProtocolMessage(createEnvelope('agent', {
                                t: 'tool-call-start', call: event.id, name: event.name, title: event.name, description: event.name, args: event.args,
                            }, { turn }));
                            else session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'tool-call-end', call: event.id,
                                status: event.error ? 'failed' : 'completed', ...(event.error ? { error: { summary: event.error.slice(0, 280) } } : {}) }, { turn }));
                        }, model);
                    }
                    session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'turn-end', status: 'completed' }, { turn }));
                } catch (error) {
                    session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'text', text: active.signal.aborted ? 'Cancelled.' : error instanceof Error ? error.message : 'Personal turn failed' }, { turn }));
                    session.sendSessionProtocolMessage(createEnvelope('agent', { t: 'turn-end', status: active.signal.aborted ? 'cancelled' : 'failed' }, { turn }));
                } finally {
                    active = null;
                    permission.abortAll();
                    session.keepAlive(false, 'remote');
                    session.sendSessionEvent({ type: 'ready' });
                    await session.flush();
                }
            }
        } finally { draining = false; }
    };
    const enqueue = (message: UserMessage) => {
        if (stopped) return;
        queue.push(message);
        void session.updateAgentState(state => ({ ...state, queuedMessages: queue.length })).catch(error => logger.debug('[personal] Queue state update failed', error));
        if (!draining) drainPromise = drain().catch(error => logger.debug('[personal] Queue failed', error));
    };
    let finish!: () => void;
    const closed = new Promise<void>(resolve => { finish = resolve; });
    const stop = async () => {
        if (stopped) return;
        stopped = true;
        clearInterval(heartbeat);
        active?.abort();
        permission.abortAll();
        await drainPromise;
        await session.updateMetadataAndAwait(current => ({ ...current, lifecycleState: 'archived', lifecycleStateSince: Date.now(), archivedBy: 'cli' }));
        session.sendSessionDeath();
        await session.flush();
        await session.close();
        finish();
    };
    session.onUserMessage(enqueue);
    session.on('archived', () => { void stop(); });
    session.rpcHandlerManager.registerHandler('abort', async () => { active?.abort(); permission.abortAll(); });
    registerKillSessionHandler(session.rpcHandlerManager, stop);
    process.once('SIGTERM', () => { void stop(); });
    process.once('SIGINT', () => { void stop(); });
    if (reconnectId) await session.updateMetadataAndAwait(current => ({ ...current, ...metadata, currentModelCode: model, currentOperatingModeCode: mode, summary: current.summary ?? metadata.summary }));
    // The volatile presence frame sent before connect can be dropped; publish
    // again after the metadata acknowledgement and before declaring readiness.
    session.keepAlive(false, 'remote');
    await notifyDaemonSessionStarted(response.id, metadata, { encryptionKey: encodeBase64(response.encryptionKey), encryptionVariant: response.encryptionVariant,
        seq: response.seq, metadataVersion: response.metadataVersion, agentStateVersion: response.agentStateVersion });
    console.log(`Paws Personal session: ${response.id}`);
    session.sendSessionEvent({ type: 'ready' });
    await closed;
}
