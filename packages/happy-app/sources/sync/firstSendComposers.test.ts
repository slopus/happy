import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as spawnLifecycle from './spawnRequestId';

vi.mock('expo-crypto', () => ({ randomUUID: () => crypto.randomUUID() }));

// Execute the actual production callbacks with their React/native boundaries
// supplied explicitly. This keeps the large screen's rendering/native imports
// out of Node without copying its send control flow into a parallel test model.
// New closure dependencies or callback renames require updating this explicit test scope.
function callbackAt(file: string, find: (node: ts.Node) => ts.Node | undefined, scope: Record<string, unknown>) {
    const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let callback: ts.Node | undefined;
    const visit = (node: ts.Node) => { callback ??= find(node); if (!callback) ts.forEachChild(node, visit); };
    visit(source);
    if (!callback) throw new Error(`Production callback not found: ${file}`);
    const js = ts.transpileModule(`const handleSend = ${callback.getText(source)}; return handleSend;`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    return new Function(...Object.keys(scope), js)(...Object.values(scope));
}

const sendCallback = (node: ts.Node) => ts.isVariableDeclaration(node)
    && node.name.getText() === 'handleSend' && node.initializer && ts.isCallExpression(node.initializer)
    ? node.initializer.arguments[0] : undefined;

const newScreen = '../app/(app)/new/index.tsx';
const chatScreen = '../-session/SessionView.tsx';

function draft(input = 'original prompt') {
    return { input, attachments: [{ id: 'old-image' }], selectedMachineId: 'machine', selectedPath: '/original', agentType: 'claude', setInput: vi.fn(), setAttachments: vi.fn() };
}

function newScreenBoundary() {
    const machine = { id: 'machine', metadata: { homeDir: '/test' } };
    const state = { draft: draft() };
    const scope = {
        ...spawnLifecycle,
        sendingRef: { current: null },
        useNewSessionDraft: { getState: () => state.draft },
        findMachineChoice: () => ({}), collectMachineChoices: () => [], allMachines: [machine], selectedMachineId: 'machine',
        resolveChoiceAgent: () => 'claude', selectedAgent: 'claude', resolveAgentMachine: () => machine,
        isMachineOnline: () => true, getSupportsWorktree: () => true, resolveWorktreeCreationMachine: () => machine,
        canPickWorktree: false, worktreeKey: null, setIsSpawning: vi.fn(), selectedPath: '/original',
        trimPathInput: (path: string) => path, resolveAbsolutePath: (path: string) => path,
        currentPermission: { key: 'default' }, currentModelKey: 'default', currentEffort: null,
        machineSpawnNewSession: vi.fn().mockResolvedValue({ type: 'success', sessionId: 'created' }),
        MAX_RIG_PENDING_RESULTS: 3, isMountedRef: { current: true },
        machineStopSession: vi.fn().mockResolvedValue({ success: true }),
        sessionKill: vi.fn().mockResolvedValue({ success: true }), sessionArchive: vi.fn(),
        sync: { ensureSessionReady: vi.fn().mockResolvedValue(undefined), sendMessage: vi.fn().mockResolvedValue(true) },
        sessionSetAgentModes: vi.fn(), router: { back: vi.fn() }, navigateToSession: vi.fn(),
        Modal: { alert: vi.fn(), confirm: vi.fn() }, t: (key: string) => key,
    };
    return { state, scope, send: callbackAt(newScreen, sendCallback, scope) as () => Promise<void> };
}

beforeEach(() => { spawnLifecycle.completeSpawnRequest(); });

describe('new-session screen callback boundary', () => {
    it('preserves a failed draft and retries the created session without another spawn', async () => {
        const { state, scope, send } = newScreenBoundary();
        scope.sync.sendMessage.mockResolvedValueOnce(false).mockResolvedValue(true);
        await send();
        expect(state.draft.setInput).not.toHaveBeenCalled();
        expect(state.draft.setAttachments).not.toHaveBeenCalled();
        expect(scope.navigateToSession).not.toHaveBeenCalled();
        await send();
        expect(scope.machineSpawnNewSession).toHaveBeenCalledOnce();
        expect(scope.sync.sendMessage.mock.calls.map(call => call[0])).toEqual(['created', 'created']);
        expect(state.draft.setInput).toHaveBeenCalledWith('');
    });

    it('never sends a newer draft to the older session after hydration', async () => {
        const { state, scope, send } = newScreenBoundary();
        let finish!: () => void;
        scope.sync.ensureSessionReady.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
        const sending = send();
        await vi.waitFor(() => expect(scope.sync.ensureSessionReady).toHaveBeenCalledOnce());
        state.draft = { ...draft('new destination prompt'), selectedPath: '/different' };
        finish();
        await sending;
        expect(scope.sync.sendMessage).not.toHaveBeenCalled();
        expect(scope.machineStopSession).toHaveBeenCalledWith('machine', 'created');
        expect(state.draft.setInput).not.toHaveBeenCalled();
        expect(state.draft.setAttachments).not.toHaveBeenCalled();
        expect(scope.navigateToSession).not.toHaveBeenCalled();
    });

    it('blocks same-frame duplicate starts before React re-renders', async () => {
        const { scope, send } = newScreenBoundary();
        let finish!: (value: unknown) => void;
        scope.machineSpawnNewSession.mockReturnValue(new Promise(resolve => { finish = resolve; }));
        const first = send();
        await send();
        expect(scope.machineSpawnNewSession).toHaveBeenCalledOnce();
        finish({ type: 'success', sessionId: 'created' });
        await first;
        expect(scope.sync.sendMessage).toHaveBeenCalledOnce();
    });

    it('aborts an older created attempt if another screen changes its pending request', async () => {
        const { scope, send } = newScreenBoundary();
        let finish!: () => void;
        scope.sync.ensureSessionReady.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
        const sending = send();
        await vi.waitFor(() => expect(scope.sync.ensureSessionReady).toHaveBeenCalledOnce());
        spawnLifecycle.resolveSpawnRequestId('different configuration');
        finish();
        await sending;
        expect(scope.machineStopSession).toHaveBeenCalledWith('machine', 'created');
        expect(scope.sync.sendMessage).not.toHaveBeenCalled();
    });

    it('does not stop an adopted session when the still-active callback changes destination', async () => {
        const { state, scope, send } = newScreenBoundary();
        let finish!: () => void;
        scope.sync.ensureSessionReady.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
        const sending = send();
        await vi.waitFor(() => expect(scope.sync.ensureSessionReady).toHaveBeenCalledOnce());
        spawnLifecycle.releaseSpawnedSession('created');
        state.draft = { ...draft(), selectedPath: '/different' };
        finish();
        await sending;
        expect(scope.sync.sendMessage).not.toHaveBeenCalled();
        expect(scope.machineStopSession).not.toHaveBeenCalled();
        expect(scope.sessionKill).not.toHaveBeenCalled();
        expect(scope.sessionArchive).not.toHaveBeenCalled();
        expect(state.draft.setInput).not.toHaveBeenCalled();
    });
});

describe('chat composer callback boundary', () => {
    function chatBoundary() {
        const composer = { getMessage: vi.fn(() => 'original'), clearMessage: vi.fn() };
        const scope = {
            sessionId: 'original-session', composerHandleRef: { current: composer },
            sendingSessionsRef: { current: new Set() }, currentSessionIdRef: { current: 'original-session' as string | null },
            selectedImages: [{ id: 'image' }], removeImage: vi.fn(), pendingCommunications: [{ id: 'question', kind: 'question' }],
            sessionCancelCommunication: vi.fn(), sync: { sendMessage: vi.fn() },
        };
        return { scope, composer, send: callbackAt(chatScreen, sendCallback, scope) as () => void };
    }

    it.each(['failure', 'new-text', 'navigation'])('preserves the correct draft and question on %s', async (change) => {
        const { scope, composer, send } = chatBoundary();
        let finish!: (accepted: boolean) => void;
        scope.sync.sendMessage.mockReturnValue(new Promise(resolve => { finish = resolve; }));
        send();
        send();
        expect(scope.sync.sendMessage).toHaveBeenCalledOnce();
        if (change === 'new-text') composer.getMessage.mockReturnValue('new text');
        if (change === 'navigation') scope.currentSessionIdRef.current = 'new-session';
        if (change !== 'failure') scope.sync.sendMessage.mock.calls[0][2].onAccepted();
        finish(change !== 'failure');
        await vi.waitFor(() => expect(scope.sendingSessionsRef.current.size).toBe(0));
        expect(composer.clearMessage).not.toHaveBeenCalled();
        if (change === 'failure' || change === 'navigation') expect(scope.removeImage).not.toHaveBeenCalled();
        if (change === 'failure') expect(scope.sessionCancelCommunication).not.toHaveBeenCalled();
        expect(scope.sync.sendMessage.mock.calls[0][0]).toBe('original-session');
    });

    it('clears an accepted draft immediately while keeping question dismissal behind delivery', async () => {
        const { scope, composer, send } = chatBoundary();
        let finish!: (accepted: boolean) => void;
        scope.sync.sendMessage.mockReturnValue(new Promise(resolve => { finish = resolve; }));
        send();
        scope.sync.sendMessage.mock.calls[0][2].onAccepted();
        expect(composer.clearMessage).toHaveBeenCalledOnce();
        expect(scope.removeImage).toHaveBeenCalledWith('image');
        expect(scope.sessionCancelCommunication).not.toHaveBeenCalled();
        finish(true);
        await vi.waitFor(() => expect(scope.sessionCancelCommunication).toHaveBeenCalledOnce());
    });

    it('restores the session guard during Strict Mode effect replay', () => {
        const currentSessionIdRef = { current: 'session' as string | null };
        const setup = callbackAt(chatScreen, node => ts.isCallExpression(node)
            && node.expression.getText() === 'React.useEffect'
            && node.arguments[0]?.getText().includes('currentSessionIdRef.current = sessionId')
            ? node.arguments[0] : undefined,
        { currentSessionIdRef, sessionId: 'session' });
        const cleanup = setup();
        cleanup();
        expect(currentSessionIdRef.current).toBeNull();
        setup();
        expect(currentSessionIdRef.current).toBe('session');
    });
});