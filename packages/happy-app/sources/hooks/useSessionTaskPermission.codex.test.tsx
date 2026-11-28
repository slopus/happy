import * as React from 'react';
import { act } from 'react';
// @ts-expect-error no react-test-renderer declarations
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionTaskPermission } from './useSessionTaskPermission';
import { isAgyConfigPending } from '@/sync/agyConfigPending';
import { resolveMessageModeMeta } from '@/sync/messageMeta';

const mocks = vi.hoisted(() => ({
    setMode: vi.fn(),
    confirm: vi.fn(),
    alert: vi.fn(),
    sessions: {} as Record<string, any>,
}));
vi.mock('@/sync/ops', () => ({ sessionSetPermissionMode: mocks.setMode }));
vi.mock('@/sync/storage', () => ({
    useSetting: () => ({}),
    storage: { getState: () => ({
        sessions: mocks.sessions,
        updateSessionPermissionMode: (id: string, mode: string) => {
            mocks.sessions[id] = { ...mocks.sessions[id], permissionMode: mode };
        },
    }) },
}));
vi.mock('@/modal', () => ({ Modal: { confirm: mocks.confirm, alert: mocks.alert } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

let controller: ReturnType<typeof useSessionTaskPermission>;
let renderer: ReturnType<typeof TestRenderer.create>;
let sequence = 0;
let sessionId: string;
function Harness() {
    controller = useSessionTaskPermission(mocks.sessions[sessionId], true);
    return null;
}
function renderCurrent() {
    act(() => { renderer.update(<Harness />); });
}

describe('acknowledged Codex permission controls', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        sessionId = `codex-permission-${++sequence}`;
        mocks.confirm.mockResolvedValue(true);
        mocks.sessions = { [sessionId]: { id: sessionId, permissionMode: 'acceptEdits',
            metadata: { flavor: 'codex', hostPid: 1, currentOperatingModeCode: 'acceptEdits' } } };
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        act(() => { renderer = TestRenderer.create(<Harness />); });
    });
    afterEach(() => { act(() => renderer.unmount()); });

    it('keeps the previous displayed mode until the worker acknowledges full access', async () => {
        let acknowledge!: (accepted: boolean) => void;
        mocks.setMode.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
        const pending = controller.onLevelChange('full-access');
        await act(async () => { await Promise.resolve(); });
        renderCurrent();
        expect(isAgyConfigPending(sessionId)).toBe(true);
        expect(controller.level).toBe('confirm');
        expect(resolveMessageModeMeta(mocks.sessions[sessionId]).permissionMode).toBe('acceptEdits');
        let result: boolean | undefined;
        await act(async () => { acknowledge(true); result = await pending; });
        renderCurrent();
        expect(result).toBe(true);
        expect(controller.level).toBe('full-access');
        expect(isAgyConfigPending(sessionId)).toBe(false);
        expect(resolveMessageModeMeta(mocks.sessions[sessionId])).toMatchObject({ permissionMode: 'yolo', permissionModeExplicit: true });
    });

    it.each(['rejected', 'unavailable'] as const)('keeps the previous mode and permits a full-access retry when the RPC is %s', async failure => {
        if (failure === 'rejected') mocks.setMode.mockResolvedValueOnce(false);
        else mocks.setMode.mockRejectedValueOnce(new Error('worker unavailable'));
        let result: boolean | undefined;
        await act(async () => { result = await controller.onLevelChange('full-access'); });
        renderCurrent();
        expect(result).toBe(false);
        expect(controller.level).toBe('confirm');
        expect(isAgyConfigPending(sessionId)).toBe(false);
        expect(mocks.alert).toHaveBeenCalled();

        mocks.setMode.mockResolvedValueOnce(true);
        await act(async () => { result = await controller.onLevelChange('full-access'); });
        renderCurrent();
        expect(result).toBe(true);
        expect(controller.level).toBe('full-access');
        expect(mocks.confirm).toHaveBeenCalledTimes(2);
    });

    it('ignores an acknowledgement from a worker replaced while the change was pending', async () => {
        let acknowledge!: (accepted: boolean) => void;
        mocks.setMode.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
        const pending = controller.onLevelChange('full-access');
        await act(async () => { await Promise.resolve(); });
        mocks.sessions[sessionId] = { ...mocks.sessions[sessionId], metadata: {
            ...mocks.sessions[sessionId].metadata, hostPid: 2,
        } };
        let result: boolean | undefined;
        await act(async () => { acknowledge(true); result = await pending; });
        renderCurrent();
        expect(result).toBe(false);
        expect(controller.level).toBe('confirm');
        expect(mocks.alert).toHaveBeenCalled();
    });
});
