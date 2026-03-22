import { describe, expect, it } from 'vitest';
import { type v3 } from '@slopus/happy-sync';
import {
    getResolvedQuestionBlock,
    getToolPartSubtitle,
    getToolPermissionState,
} from './toolPartMeta';

describe('toolPartMeta', () => {
    it('derives pending permission state from a blocked tool part', () => {
        const part: v3.ToolPart = {
            id: 'prt_permission' as v3.PartID,
            sessionID: 'ses_1' as v3.SessionID,
            messageID: 'msg_1' as v3.MessageID,
            type: 'tool',
            callID: 'call_1',
            tool: 'Write',
            state: {
                status: 'blocked',
                input: {
                    file_path: '/tmp/example.ts',
                },
                title: 'Write file',
                time: { start: 123 },
                block: {
                    type: 'permission',
                    id: 'perm_1',
                    permission: 'Write',
                    patterns: ['/tmp/example.ts'],
                    always: ['Write'],
                    metadata: {},
                },
            },
        };

        expect(getToolPartSubtitle(part)).toBe('/tmp/example.ts');
        expect(getToolPermissionState(part)).toEqual({
            id: 'perm_1',
            status: 'pending',
            allowedTools: ['Write'],
        });
    });

    it('extracts resolved question answers from a completed tool part', () => {
        const part: v3.ToolPart = {
            id: 'prt_question' as v3.PartID,
            sessionID: 'ses_1' as v3.SessionID,
            messageID: 'msg_1' as v3.MessageID,
            type: 'tool',
            callID: 'call_1',
            tool: 'AskUserQuestion',
            state: {
                status: 'completed',
                input: {
                    questions: [{
                        header: 'Framework',
                        question: 'Which test framework should I use?',
                        options: [{ label: 'Vitest', description: 'Fast' }],
                    }],
                },
                output: 'User selected Vitest',
                title: 'Ask a question',
                metadata: {},
                time: { start: 10, end: 20 },
                block: {
                    type: 'question',
                    id: 'question_1',
                    questions: [{
                        header: 'Framework',
                        question: 'Which test framework should I use?',
                        options: [{ label: 'Vitest', description: 'Fast' }],
                    }],
                    answers: [['Vitest']],
                    decidedAt: 20,
                },
            },
        };

        expect(getResolvedQuestionBlock(part)?.answers).toEqual([['Vitest']]);
    });
});
