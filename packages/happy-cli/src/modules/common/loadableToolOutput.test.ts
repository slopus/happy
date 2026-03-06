import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./toolOutputStore', () => ({
    saveToolOutputRecord: vi.fn(),
}));

import { saveToolOutputRecord } from './toolOutputStore';
import { createLoadableToolOutput, summarizeBashToolOutput } from './loadableToolOutput';

describe('createLoadableToolOutput', () => {
    const mockSaveToolOutput = saveToolOutputRecord as ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockSaveToolOutput.mockClear();
    });

    it('stores the full result and returns a marker payload', () => {
        const payload = createLoadableToolOutput({
            sessionId: 'session-1',
            callId: 'call-1',
            toolName: 'Read',
            agent: 'claude',
            result: { file: { content: 'hello' } },
            kind: 'text',
            summary: { type: 'text' },
        });

        expect(payload).toEqual({
            type: 'text',
            _outputTrimmed: true,
            _callId: 'call-1',
            _toolResultKind: 'text',
        });
        expect(mockSaveToolOutput).toHaveBeenCalledOnce();
    });
});

describe('summarizeBashToolOutput', () => {
    const mockSaveToolOutput = saveToolOutputRecord as ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockSaveToolOutput.mockClear();
    });

    it('keeps exit_code for CodexBash while storing full output', () => {
        const payload = summarizeBashToolOutput({
            sessionId: 'session-1',
            callId: 'call-codex',
            toolName: 'CodexBash',
            agent: 'codex',
            result: {
                stdout: 'hello',
                stderr: '',
                exit_code: 7,
                formatted_output: 'hello',
            },
        });

        expect(payload).toEqual({
            exit_code: 7,
            _outputTrimmed: true,
            _callId: 'call-codex',
            _toolResultKind: 'command',
        });
        expect(mockSaveToolOutput).toHaveBeenCalledOnce();
    });

    it('defaults missing exit_code to zero', () => {
        const payload = summarizeBashToolOutput({
            sessionId: 'session-1',
            callId: 'call-gemini',
            toolName: 'GeminiBash',
            agent: 'gemini',
            result: {
                stdout: 'hello',
                stderr: '',
            },
        });

        expect(payload).toEqual({
            exit_code: 0,
            _outputTrimmed: true,
            _callId: 'call-gemini',
            _toolResultKind: 'command',
        });
        expect(mockSaveToolOutput).toHaveBeenCalledOnce();
    });
});
