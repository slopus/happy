import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
    records: new Map<string, string>(), id: 0, current: true, server: 'http://test', state: {} as any,
    failReceipt: false, failQueue: false,
    persist: vi.fn(), remove: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++mock.id}` }));
vi.mock('@/auth/accountRuntime', () => ({ accountStorageId: (key: string) => key, accountRuntimeCurrent: () => mock.current }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => mock.server }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/persistence/deviceStorage', () => ({
    MMKV: class {
        getString(key: string) { return mock.records.get(key); }
        getAllKeys() { return [...mock.records.keys()]; }
        set(key: string, value: string) {
            if (mock.failReceipt && JSON.parse(value).contextPending === false) throw new Error('Receipt write failed');
            mock.records.set(key, value);
        }
    },
    writeDeviceStorage: async (disk: { set(key: string, value: string): void }, key: string, value: string) => disk.set(key, value),
    flushDeviceStorageWrites: async () => {},
}));
vi.mock('@/utils/sessionUtils', () => ({ resolveSessionState: () => ({ state: 'running', isConnected: false }) }));
vi.mock('./storage', () => ({ storage: { getState: () => mock.state } }));
vi.mock('./sync', () => ({ sync: { getCredentials: () => null, sendMessage: vi.fn(), prepareComposerMessage: vi.fn() } }));
vi.mock('./ops', () => ({ sessionSteer: vi.fn() }));
vi.mock('./messageMeta', () => ({ resolveMessageModeMeta: () => ({}) }));
vi.mock('./messageStagingQueuePersistence', () => ({
    messageStagingPersistence: {
        load: () => ({ messages: [], barriers: {} }),
        save: () => { if (mock.failQueue) throw new Error('Queue write failed'); },
    },
    initializeMessageStagingPersistence: async () => {}, clearMessageStagingStorage: async () => {},
    getMessageStagingNamespace: () => 'account-a-tab',
}));
vi.mock('./stagedAttachmentStorage', () => ({
    persistStagedAttachments: (...args: unknown[]) => mock.persist(...args),
    deleteStagedAttachments: (...args: unknown[]) => mock.remove(...args),
    restoreStagedAttachments: async (_namespace: string, snapshot: unknown) => ({ snapshot, availableBlobUris: new Set() }),
}));

import { setFirstSubmissionScope } from './firstSubmissionScope';
import { createRoleConfiguration, bindRoleConfigurationSession, readRoleConfiguration } from './roleConfigurationHandoff';
import { initializeMessageStagingQueue, stageSessionMessage, messageStagingQueue } from './messageStagingQueueRuntime';
import type { NewSessionDraft } from './persistence';
import type { AttachmentPreview } from './attachmentTypes';

const launch: NewSessionDraft = { input: '', selectedMachineId: 'machine-a', selectedPath: '/work', agentType: 'codex',
    permissionMode: 'yolo', modelMode: 'default', effortLevel: null, sessionType: 'simple', worktreeKey: null, updatedAt: 1 };
const request = { machineId: 'machine-a', clientRoleId: 'writer', draft: {
    name: 'Writer', description: 'Current role requirements', agent: 'antigravity' as const, model: 'neon', effort: 'high', autoDelegate: false,
} };
const attachment = { uri: 'blob:chosen', name: 'reference.png', mimeType: 'image/png' } as AttachmentPreview;
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(accept => { resolve = accept; });
    return { promise, resolve };
}
async function pendingRole(description = request.draft.description) {
    const first = await createRoleConfiguration(request, launch);
    await bindRoleConfigurationSession(first.id, request.machineId, 'session-a');
    return createRoleConfiguration({ ...request, roleId: 'writer', draft: { ...request.draft, description } }, launch);
}
function holdAttachment() {
    const entered = deferred(); const release = deferred();
    mock.persist.mockImplementationOnce(async (_namespace, files) => {
        entered.resolve(); await release.promise;
        return files.map((file: AttachmentPreview) => ({ ...file, uri: 'persisted:reference' }));
    });
    return { entered, release };
}

beforeEach(async () => {
    mock.records.clear(); mock.id = 0; mock.current = true; mock.server = 'http://test';
    mock.failReceipt = false; mock.failQueue = false;
    mock.persist.mockReset(); mock.persist.mockImplementation(async (_namespace, files) => files);
    mock.remove.mockClear();
    mock.state = { sessions: { 'session-a': { metadata: { machineId: request.machineId } }, other: { metadata: { machineId: request.machineId } } },
        socketStatus: 'disconnected', settings: {}, applyPendingMessageSessions: () => {} };
    setFirstSubmissionScope('owner-a', mock.server);
    await initializeMessageStagingQueue();
    await messageStagingQueue.clear();
});

describe('role reentry at the actual message staging boundary', () => {
    it('delivers current private context once while preserving visible text, editable context and attachments', async () => {
        const role = await pendingRole();
        const context = { draftText: 'Visible request', displayText: 'Visible request', fileReference: { path: '/work/doc.md', hash: 'baseline' } };
        await stageSessionMessage('session-a', 'Model payload', [attachment], 'queue', context);
        await stageSessionMessage('session-a', 'Next request');
        const [first, next] = messageStagingQueue.getSnapshot().messages;
        expect(first).toMatchObject({ ...context, attachments: [attachment] });
        expect(first.text).toContain('Current role requirements');
        expect(first.text).toContain('Current user request:\nModel payload');
        expect(next.text).toBe('Next request');
        expect(readRoleConfiguration(role.id)?.contextPending).toBe(false);
    });

    it('serializes preparation so concurrent sends cannot attach the same revision twice', async () => {
        await pendingRole();
        const gate = holdAttachment();
        const first = stageSessionMessage('session-a', 'First', [attachment]);
        await gate.entered.promise;
        const second = stageSessionMessage('session-a', 'Second');
        expect(messageStagingQueue.getSnapshot().messages).toHaveLength(0);
        gate.release.resolve();
        await Promise.all([first, second]);
        const queued = messageStagingQueue.getSnapshot().messages;
        expect(queued[0].text).toContain('Current user request:\nFirst');
        expect(queued[1].text).toBe('Second');
    });

    it('keeps context pending and removes staged files when queue persistence fails', async () => {
        const role = await pendingRole(); mock.failQueue = true;
        await expect(stageSessionMessage('session-a', 'Save this', [attachment])).rejects.toThrow('Queue write failed');
        expect(messageStagingQueue.getSnapshot().messages).toHaveLength(0);
        expect(mock.remove).toHaveBeenCalledWith('account-a-tab', [attachment]);
        expect(readRoleConfiguration(role.id)?.contextPending).toBe(true);
    });

    it('keeps already accepted messages and attachments if only receipt persistence fails', async () => {
        const role = await pendingRole(); mock.failReceipt = true;
        await expect(stageSessionMessage('session-a', 'Save this', [attachment])).resolves.toBeUndefined();
        expect(messageStagingQueue.getSnapshot().messages).toHaveLength(1);
        expect(messageStagingQueue.getSnapshot().messages[0].attachments).toEqual([attachment]);
        expect(mock.remove).not.toHaveBeenCalled();
        expect(readRoleConfiguration(role.id)?.contextPending).toBe(true);
    });

    it('rejects obsolete handoff material if a newer revision arrives while files persist', async () => {
        const role = await pendingRole(); const gate = holdAttachment();
        const submission = stageSessionMessage('session-a', 'Old request', [attachment]);
        await gate.entered.promise;
        const latest = await createRoleConfiguration({ ...request, roleId: 'writer', draft: { ...request.draft, description: 'New requirements' } }, launch);
        gate.release.resolve();
        await expect(submission).rejects.toThrow('Role configuration target changed');
        expect(messageStagingQueue.getSnapshot().messages).toHaveLength(0);
        expect(readRoleConfiguration(role.id)).toMatchObject({ revision: latest.revision, contextPending: true });
        await stageSessionMessage('session-a', 'Use current');
        expect(messageStagingQueue.getSnapshot().messages[0].text).toContain('New requirements');
    });

    it('rejects a changed live machine and retains the pending role context', async () => {
        const role = await pendingRole(); const gate = holdAttachment();
        const submission = stageSessionMessage('session-a', 'Request', [attachment]);
        await gate.entered.promise;
        mock.state.sessions['session-a'].metadata.machineId = 'machine-b';
        gate.release.resolve();
        await expect(submission).rejects.toThrow('Role configuration target changed');
        expect(messageStagingQueue.getSnapshot().messages).toHaveLength(0);
        expect(readRoleConfiguration(role.id)?.contextPending).toBe(true);
        await expect(stageSessionMessage('session-a', 'Another request')).rejects.toThrow('delegation.configurationMachineChanged');
    });

    it('rejects owner A → B → A during file persistence without consuming A’s context', async () => {
        const role = await pendingRole(); const gate = holdAttachment();
        const submission = stageSessionMessage('session-a', 'Request', [attachment]);
        await gate.entered.promise;
        setFirstSubmissionScope('owner-b', mock.server); setFirstSubmissionScope('owner-a', mock.server);
        gate.release.resolve();
        await expect(submission).rejects.toThrow('Role configuration target changed');
        expect(messageStagingQueue.getSnapshot().messages).toHaveLength(0);
        expect(readRoleConfiguration(role.id)?.contextPending).toBe(true);
    });

    it('leaves slash commands and ordinary unrelated sessions unchanged', async () => {
        const role = await pendingRole();
        await stageSessionMessage('session-a', '/help');
        await stageSessionMessage('other', 'Ordinary request');
        expect(messageStagingQueue.getSnapshot().messages.map(message => message.text)).toEqual(['/help', 'Ordinary request']);
        expect(readRoleConfiguration(role.id)?.contextPending).toBe(true);
    });
});
