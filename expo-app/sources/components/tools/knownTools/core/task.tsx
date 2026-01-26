import type { Metadata } from '@/sync/storageTypes';
import type { ToolCall, Message } from '@/sync/typesMessage';
import * as z from 'zod';
import { t } from '@/text';
import { ICON_TASK } from '../icons';
import type { KnownToolDefinition } from '../_types';

export const coreTaskTools = {
    'Task': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Check for description field at runtime
            if (opts.tool.input && opts.tool.input.description && typeof opts.tool.input.description === 'string') {
                return opts.tool.input.description;
            }
            return t('tools.names.task');
        },
        icon: ICON_TASK,
        isMutable: true,
        minimal: (opts: { metadata: Metadata | null, tool: ToolCall, messages?: Message[] }) => {
            // Check if there would be any filtered tasks
            const messages = opts.messages || [];
            for (let m of messages) {
                if (m.kind === 'tool-call' &&
                    (m.tool.state === 'running' || m.tool.state === 'completed' || m.tool.state === 'error')) {
                    return false; // Has active sub-tasks, show expanded
                }
            }
            return true; // No active sub-tasks, render as minimal
        },
        input: z.object({
            prompt: z.string().describe('The task for the agent to perform'),
            subagent_type: z.string().optional().describe('The type of specialized agent to use')
        }).partial().loose()
    },
} satisfies Record<string, KnownToolDefinition>;

