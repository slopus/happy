import type { Metadata } from '@/sync/storageTypes';
import type { ToolCall } from '@/sync/typesMessage';
import * as z from 'zod';
import { t } from '@/text';
import { ICON_REASONING } from '../icons';
import type { KnownToolDefinition } from '../_types';

export const providerReasoningTools = {
    'CodexReasoning': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Use the title from input if provided
            if (opts.tool.input?.title && typeof opts.tool.input.title === 'string') {
                return opts.tool.input.title;
            }
            return t('tools.names.reasoning');
        },
        icon: ICON_REASONING,
        minimal: true,
        input: z.object({
            title: z.string().describe('The title of the reasoning')
        }).partial().loose(),
        result: z.object({
            content: z.string().describe('The reasoning content'),
            status: z.enum(['completed', 'in_progress', 'error']).optional().describe('The status of the reasoning')
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (opts.tool.input?.title && typeof opts.tool.input.title === 'string') {
                return opts.tool.input.title;
            }
            return t('tools.names.reasoning');
        }
    },
    'GeminiReasoning': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Use the title from input if provided
            if (opts.tool.input?.title && typeof opts.tool.input.title === 'string') {
                return opts.tool.input.title;
            }
            return t('tools.names.reasoning');
        },
        icon: ICON_REASONING,
        minimal: true,
        input: z.object({
            title: z.string().describe('The title of the reasoning')
        }).partial().loose(),
        result: z.object({
            content: z.string().describe('The reasoning content'),
            status: z.enum(['completed', 'in_progress', 'canceled']).optional().describe('The status of the reasoning')
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (opts.tool.input?.title && typeof opts.tool.input.title === 'string') {
                return opts.tool.input.title;
            }
            return t('tools.names.reasoning');
        }
    },
    'think': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Use the title from input if provided
            if (opts.tool.input?.title && typeof opts.tool.input.title === 'string') {
                return opts.tool.input.title;
            }
            return t('tools.names.reasoning');
        },
        icon: ICON_REASONING,
        minimal: true,
        input: z.object({
            title: z.string().optional().describe('The title of the thinking'),
            items: z.array(z.any()).optional().describe('Items to think about'),
            locations: z.array(z.any()).optional().describe('Locations to consider')
        }).partial().loose(),
        result: z.object({
            content: z.string().optional().describe('The reasoning content'),
            text: z.string().optional().describe('The reasoning text'),
            status: z.enum(['completed', 'in_progress', 'canceled']).optional().describe('The status')
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (opts.tool.input?.title && typeof opts.tool.input.title === 'string') {
                return opts.tool.input.title;
            }
            return t('tools.names.reasoning');
        }
    },
} satisfies Record<string, KnownToolDefinition>;

