/** Real encrypted Paws relay + native model/tool loop + same-session restart. Opt in explicitly. */
import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PawsAgentClient, type Message } from '@wangjs-jacky/paws-agent';
import { ApiClient } from '@/api/api';
import { encodeBase64 } from '@/api/encryption';
import { configuration } from '@/configuration';
import { readCredentials, readSettings } from '@/persistence';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { loadPersonalConfig } from './config';
import { writePersonalJson, PersonalStore } from './store';
import { runPersonal } from './runPersonal';

it.skipIf(process.env.PAWS_PERSONAL_LIVE !== '1')('completes encrypted remote turns and resumes without replaying old input', async () => {
    const config = loadPersonalConfig();
    const home = mkdtempSync(join(tmpdir(), 'paws-personal-relay-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'paws-personal-relay-work-'));
    const previousCwd = process.cwd();
    const envKeys = ['PAWS_PERSONAL_HOME', 'HAPPY_RECONNECT_SESSION_ID', 'HAPPY_RECONNECT_ENCRYPTION_KEY',
        'HAPPY_RECONNECT_ENCRYPTION_VARIANT', 'HAPPY_RECONNECT_SEQ', 'HAPPY_RECONNECT_METADATA_VERSION', 'HAPPY_RECONNECT_AGENT_STATE_VERSION', 'HAPPY_RECONNECT_METADATA_JSON'];
    const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    let client: PawsAgentClient | undefined;
    let runner: Promise<void> | undefined;
    let sessionId: string | undefined;
    let watch: { unsubscribe(): void } | undefined;
    let complete: ((status: string) => void) | undefined;
    let rejectTurn: ((error: unknown) => void) | undefined;
    let timer: NodeJS.Timeout | undefined;
    let readyAfterSeq = Infinity;
    let ready: (() => void) | undefined;
    const texts: string[] = [];
    const waitForTurn = () => new Promise<string>((resolve, reject) => {
        complete = resolve; rejectTurn = reject;
        timer = setTimeout(() => reject(new Error('Personal relay turn timed out')), 120_000);
    }).finally(() => { clearTimeout(timer); complete = undefined; rejectTurn = undefined; });
    const onMessage = (message: Message) => {
        const content = message.content as { role?: string; content?: { type?: string; data?: { type?: string }; ev?: { t?: string; status?: string; text?: string } } };
        if (message.seq > readyAfterSeq && content.role === 'agent' && content.content?.type === 'event' && content.content.data?.type === 'ready') ready?.();
        const event = content.role === 'session' ? content.content?.ev : undefined;
        if (event?.t === 'text' && event.text) texts.push(event.text);
        if (event?.t === 'turn-end') complete?.(event.status || 'unknown');
    };
    try {
        const credentials = await readCredentials();
        const settings = await readSettings();
        if (!credentials || !settings.machineId) throw new Error('This live check requires an existing authenticated Paws machine');
        process.chdir(cwd);
        process.env.PAWS_PERSONAL_HOME = home;
        writePersonalJson(join(home, 'config.json'), { baseUrl: config.baseUrl, model: config.model, maxSteps: 8 });
        const api = await ApiClient.create(credentials);
        const { metadata, state } = createSessionMetadata({ flavor: 'personal', machineId: settings.machineId });
        const created = await api.getOrCreateSession({ tag: randomUUID(), metadata, state });
        if (!created) throw new Error('The Paws relay is unavailable');
        sessionId = created.id;
        new PersonalStore(home).save(sessionId, []);
        const reconnect = (seq: number, metadataVersion: number, agentStateVersion: number, previousMetadata: unknown = created.metadata) => {
            Object.assign(process.env, {
                HAPPY_RECONNECT_SESSION_ID: created.id, HAPPY_RECONNECT_ENCRYPTION_KEY: encodeBase64(created.encryptionKey),
                HAPPY_RECONNECT_ENCRYPTION_VARIANT: created.encryptionVariant, HAPPY_RECONNECT_SEQ: String(seq),
                HAPPY_RECONNECT_METADATA_VERSION: String(metadataVersion), HAPPY_RECONNECT_AGENT_STATE_VERSION: String(agentStateVersion),
                HAPPY_RECONNECT_METADATA_JSON: JSON.stringify(previousMetadata),
            });
        };
        client = new PawsAgentClient({ serverUrl: configuration.serverUrl, credentials: { getCredentials: async () => ({
            token: credentials.token, resolveRecordKey: record => record.type === 'session' && record.id === created.id
                ? { key: created.encryptionKey, variant: created.encryptionVariant } : null,
        }) } });
        await client.connect();
        await client.sessions.get(created.id);
        watch = await client.messages.watch(created.id, { afterSeq: 0, onMessage, onError: error => rejectTurn?.(error) });
        reconnect(created.seq, created.metadataVersion, created.agentStateVersion);
        runner = runPersonal({ credentials, resume: created.id });
        runner.catch(error => rejectTurn?.(error));
        const first = waitForTurn();
        await client.messages.send({ sessionId: created.id, text: '请用memory_write记住：验收口令是NATIVE_PAWS_52，然后简短确认。', meta: { permissionMode: 'default' } });
        expect(await first).toBe('completed');
        expect(Object.values(new PersonalStore(home).memory()).join(' ')).toContain('NATIVE_PAWS_52');
        await client.sessions.terminate(created.id);
        await runner;
        const snapshot = await client.sessions.get(created.id);
        console.log(JSON.stringify({ stage: 'stopped-snapshot', seq: snapshot.seq, active: snapshot.active, lifecycle: (snapshot.metadata as { lifecycleState?: string }).lifecycleState }));
        reconnect(snapshot.seq, snapshot.metadataVersion, snapshot.agentStateVersion, snapshot.metadata);
        readyAfterSeq = snapshot.seq;
        let readyTimeout: NodeJS.Timeout | undefined;
        const startup = new Promise<void>((resolve, reject) => {
            ready = resolve;
            readyTimeout = setTimeout(() => reject(new Error('Personal reconnect did not signal ready')), 30_000);
        }).finally(() => { clearTimeout(readyTimeout); ready = undefined; });
        runner = runPersonal({ credentials, resume: created.id });
        runner.catch(error => rejectTurn?.(error));
        await startup;
        // The existing relay batches active flags every 5s and throttles writes
        // for 30s. Its SDK validates that persisted flag, whereas the App sees
        // live presence. Allow one bounded convergence wait, with no query loop.
        await new Promise(resolve => setTimeout(resolve, 36_000));
        const readySnapshot = await client.sessions.get(created.id);
        console.log(JSON.stringify({ stage: 'ready-snapshot', seq: readySnapshot.seq, active: readySnapshot.active, lifecycle: (readySnapshot.metadata as { lifecycleState?: string }).lifecycleState }));
        const second = waitForTurn();
        await client.messages.send({ sessionId: created.id, text: '读取记忆，原样告诉我验收口令。', meta: { permissionMode: 'read-only' } });
        expect(await second).toBe('completed');
        expect(texts.at(-1)).toContain('NATIVE_PAWS_52');
        const transcript = new PersonalStore(home).transcript(created.id);
        expect(transcript.filter(message => message.role === 'user')).toHaveLength(2);
        expect((await client.sessions.get(created.id)).agentState).toMatchObject({ turnStatus: { status: 'completed' } });
        await client.sessions.terminate(created.id);
        await runner;
        runner = undefined;
        console.log(JSON.stringify({ verified: 'encrypted-personal-relay-and-resume', sessionId: created.id, userTurns: 2 }));
    } finally {
        watch?.unsubscribe();
        if (runner && client && sessionId) {
            await client.sessions.terminate(sessionId).catch(() => {});
            await Promise.race([runner.catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))]);
        }
        await client?.dispose();
        process.chdir(previousCwd);
        for (const key of envKeys) { if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key]; }
        rmSync(home, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
    }
}, 180_000);
