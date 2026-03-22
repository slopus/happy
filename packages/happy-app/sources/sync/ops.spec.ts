import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    sessionRPC,
    getSession,
    fetchSession,
    approvePermission,
    denyPermission,
    answerQuestion,
} = vi.hoisted(() => ({
    sessionRPC: vi.fn(),
    getSession: vi.fn(),
    fetchSession: vi.fn(),
    approvePermission: vi.fn(),
    denyPermission: vi.fn(),
    answerQuestion: vi.fn(),
}));

vi.mock('./apiSocket', () => ({
    apiSocket: {
        sessionRPC,
        machineRPC: vi.fn(),
        emitWithAck: vi.fn(),
        request: vi.fn(),
    },
}));

vi.mock('./sync', () => ({
    sync: {
        appSyncStore: {
            getSession,
            fetchSession,
            approvePermission,
            denyPermission,
            answerQuestion,
        },
        encryption: {
            getMachineEncryption: vi.fn(),
        },
    },
}));

import { sessionAllow, sessionAnswerQuestion, sessionDeny } from './ops';

describe('ops v3 routing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        fetchSession.mockResolvedValue(undefined);
        getSession.mockReturnValue(undefined);
    });

    it('routes permission approvals through AppSyncStore when a v3 request is pending', async () => {
        getSession.mockReturnValue({
            permissions: [{ permissionId: 'perm_1', resolved: false }],
            questions: [],
        });

        await sessionAllow('ses_1', 'perm_1', undefined, ['Write'], 'approved_for_session');

        expect(approvePermission).toHaveBeenCalledWith('ses_1', 'perm_1', {
            decision: 'always',
            allowTools: ['Write'],
        });
        expect(sessionRPC).not.toHaveBeenCalled();
    });

    it('fails loudly when a v3 permission request does not exist', async () => {
        await expect(sessionAllow('ses_1', 'perm_1')).rejects.toThrow(
            'SyncNode session ses_1 is not available',
        );

        expect(fetchSession).toHaveBeenCalledWith('ses_1');
        expect(sessionRPC).not.toHaveBeenCalled();
        expect(approvePermission).not.toHaveBeenCalled();
    });

    it('hydrates v3 permissions before approving through AppSyncStore', async () => {
        getSession
            .mockReturnValueOnce(undefined)
            .mockReturnValue({
                permissions: [{ permissionId: 'perm_1', resolved: false }],
                questions: [],
            });

        await sessionAllow('ses_1', 'perm_1');

        expect(fetchSession).toHaveBeenCalledWith('ses_1');
        expect(approvePermission).toHaveBeenCalledWith('ses_1', 'perm_1', {
            decision: 'once',
            allowTools: undefined,
        });
        expect(sessionRPC).not.toHaveBeenCalled();
    });

    it('routes permission denial through AppSyncStore when a v3 request is pending', async () => {
        getSession.mockReturnValue({
            permissions: [{ permissionId: 'perm_1', resolved: false }],
            questions: [],
        });

        await sessionDeny('ses_1', 'perm_1', undefined, undefined, 'abort');

        expect(denyPermission).toHaveBeenCalledWith(
            'ses_1',
            'perm_1',
            'request aborted by user',
        );
        expect(sessionRPC).not.toHaveBeenCalled();
    });

    it('maps allow-for-session approvals to persistent v3 decisions', async () => {
        getSession.mockReturnValue({
            permissions: [{ permissionId: 'perm_1', resolved: false }],
            questions: [],
        });

        await sessionAllow('ses_1', 'perm_1', undefined, ['Write'], 'approved_for_session');

        expect(approvePermission).toHaveBeenCalledWith('ses_1', 'perm_1', {
            decision: 'always',
            allowTools: ['Write'],
        });
    });

    it('answers v3 questions through AppSyncStore when a pending question exists', async () => {
        answerQuestion.mockResolvedValue(undefined);
        getSession.mockReturnValue({
            permissions: [],
            questions: [{ questionId: 'q_1', resolved: false }],
        });

        await expect(sessionAnswerQuestion('ses_1', 'q_1', [['Vitest']])).resolves.toBe(true);
        expect(answerQuestion).toHaveBeenCalledWith('ses_1', 'q_1', [['Vitest']]);
    });

    it('hydrates v3 questions before returning false', async () => {
        answerQuestion.mockResolvedValue(undefined);
        getSession
            .mockReturnValueOnce(undefined)
            .mockReturnValue({
                permissions: [],
                questions: [{ questionId: 'q_1', resolved: false }],
            });

        await expect(sessionAnswerQuestion('ses_1', 'q_1', [['Vitest']])).resolves.toBe(true);
        expect(fetchSession).toHaveBeenCalledWith('ses_1');
        expect(answerQuestion).toHaveBeenCalledWith('ses_1', 'q_1', [['Vitest']]);
    });

    it('returns false when no v3 question is available', async () => {
        await expect(sessionAnswerQuestion('ses_1', 'q_1', [['Vitest']])).resolves.toBe(false);
        expect(answerQuestion).not.toHaveBeenCalled();
    });
});
