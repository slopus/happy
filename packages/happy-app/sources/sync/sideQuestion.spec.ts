import { describe, expect, it } from 'vitest';
import type { Metadata } from './storageTypes';
import {
    askSideQuestion,
    parseSideQuestionCommand,
    supportsSideQuestions,
    type SideQuestionRpcRequest,
    type SideQuestionRpcResponse,
} from './sideQuestion';

const BASE_METADATA = { path: '/tmp/project', host: 'localhost' } as Metadata;

/** An RPC stub that answers each request from a script and records what it was asked. */
function scriptedRpc(script: Array<SideQuestionRpcResponse | ((request: SideQuestionRpcRequest) => Promise<SideQuestionRpcResponse>)>) {
    const requests: SideQuestionRpcRequest[] = [];
    const rpc = async (request: SideQuestionRpcRequest) => {
        requests.push(request);
        if (request.type === 'cancel') {
            return { status: 'cancelled', id: request.id } as const;
        }
        const next = script.shift();
        if (!next) throw new Error(`unexpected ${request.type}`);
        return typeof next === 'function' ? next(request) : next;
    };
    return { rpc, requests };
}

describe('parseSideQuestionCommand', () => {
    it('extracts the question after /btw', () => {
        expect(parseSideQuestionCommand('/btw what changed?')).toBe('what changed?');
        expect(parseSideQuestionCommand('  /btw   spaced out  ')).toBe('spaced out');
        expect(parseSideQuestionCommand('/btw first line\nsecond line')).toBe('first line\nsecond line');
    });

    it('treats a bare /btw as an empty question', () => {
        expect(parseSideQuestionCommand('/btw')).toBe('');
        expect(parseSideQuestionCommand('/btw   ')).toBe('');
    });

    it('ignores anything that is not the /btw command', () => {
        expect(parseSideQuestionCommand('/btwx')).toBeNull();
        expect(parseSideQuestionCommand('by the way /btw')).toBeNull();
        expect(parseSideQuestionCommand('/compact')).toBeNull();
    });
});

describe('supportsSideQuestions', () => {
    it('accepts Claude sessions, including ones that predate the flavor field', () => {
        expect(supportsSideQuestions(BASE_METADATA)).toBe(true);
        expect(supportsSideQuestions({ ...BASE_METADATA, flavor: 'claude' })).toBe(true);
    });

    it('rejects other agents, Happy Agent sessions and missing metadata', () => {
        expect(supportsSideQuestions({ ...BASE_METADATA, flavor: 'codex' })).toBe(false);
        expect(supportsSideQuestions({ ...BASE_METADATA, client: { id: 'rig' } } as Metadata)).toBe(false);
        expect(supportsSideQuestions(null)).toBe(false);
    });
});

describe('askSideQuestion', () => {
    const answer = { response: 'The entry point.', synthetic: false };

    it('returns an answer that arrives with the first call', async () => {
        const { rpc, requests } = scriptedRpc([{ status: 'answered', id: 'q1', answer }]);
        const history = [{ question: 'which file?', response: 'index.ts' }];

        await expect(askSideQuestion(rpc, 'why?', history, new AbortController().signal))
            .resolves.toEqual({ status: 'answered', answer });
        expect(requests).toEqual([{ type: 'ask', question: 'why?', history }]);
    });

    it('keeps waiting while the CLI reports the question pending', async () => {
        const { rpc, requests } = scriptedRpc([
            { status: 'pending', id: 'q1' },
            { status: 'pending', id: 'q1' },
            { status: 'answered', id: 'q1', answer },
        ]);

        await expect(askSideQuestion(rpc, 'slow one', [], new AbortController().signal))
            .resolves.toEqual({ status: 'answered', answer });
        expect(requests.map((request) => request.type)).toEqual(['ask', 'wait', 'wait']);
    });

    it('passes through why the CLI cannot answer', async () => {
        const { rpc } = scriptedRpc([{ status: 'unavailable', reason: 'local' }]);
        await expect(askSideQuestion(rpc, 'anything', [], new AbortController().signal))
            .resolves.toEqual({ status: 'unavailable', reason: 'local' });
    });

    it('throws the error a failing CLI handler returns', async () => {
        const { rpc } = scriptedRpc([{ error: 'Query closed' }]);
        await expect(askSideQuestion(rpc, 'anything', [], new AbortController().signal))
            .rejects.toThrow('Query closed');
    });

    it('cancels on the CLI as soon as the caller aborts', async () => {
        const controller = new AbortController();
        let releaseWait: (response: SideQuestionRpcResponse) => void = () => {};
        const { rpc, requests } = scriptedRpc([
            { status: 'pending', id: 'q1' },
            () => new Promise((resolve) => { releaseWait = resolve; }),
        ]);

        const result = askSideQuestion(rpc, 'long one', [], controller.signal);
        await Promise.resolve();
        await Promise.resolve();
        controller.abort();
        // The cancel goes out while the wait is still open
        expect(requests).toContainEqual({ type: 'cancel', id: 'q1' });

        releaseWait({ error: 'aborted' });
        await expect(result).resolves.toEqual({ status: 'cancelled' });
    });
});
