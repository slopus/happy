import type { Metadata } from '@/sync/storageTypes';
import type { ToolCall } from '@/sync/typesMessage';
import * as z from 'zod';
import { t } from '@/text';
import { ICON_QUESTION } from '../icons';
import type { KnownToolDefinition } from '../_types';

export const providerAskUserQuestionTools = {
    'AskUserQuestion': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Use first question header as title if available
            if (opts.tool.input?.questions && Array.isArray(opts.tool.input.questions) && opts.tool.input.questions.length > 0) {
                const firstQuestion = opts.tool.input.questions[0];
                if (firstQuestion.header) {
                    return firstQuestion.header;
                }
            }
            return t('tools.names.question');
        },
        icon: ICON_QUESTION,
        minimal: false,  // Always show expanded to display options
        noStatus: true,
        input: z.object({
            questions: z.array(z.object({
                question: z.string().describe('The question to ask'),
                header: z.string().describe('Short label for the question'),
                options: z.array(z.object({
                    label: z.string().describe('Option label'),
                    description: z.string().describe('Option description')
                })).describe('Available choices'),
                multiSelect: z.boolean().describe('Allow multiple selections')
            })).describe('Questions to ask the user')
        }).partial().loose(),
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (opts.tool.input?.questions && Array.isArray(opts.tool.input.questions)) {
                const count = opts.tool.input.questions.length;
                if (count === 1) {
                    return opts.tool.input.questions[0].question;
                }
                return t('tools.askUserQuestion.multipleQuestions', { count });
            }
            return null;
        }
    }
} satisfies Record<string, KnownToolDefinition>;

