import type { Metadata } from '@/sync/storageTypes';
import type { ToolCall, Message } from '@/sync/typesMessage';
import * as z from 'zod';
import { t } from '@/text';
import { ICON_TODO } from '../icons';
import type { KnownToolDefinition } from '../_types';

export const coreTodoTools = {
    'TodoWrite': {
        title: t('tools.names.todoList'),
        icon: ICON_TODO,
        noStatus: true,
        minimal: (opts: { metadata: Metadata | null, tool: ToolCall, messages?: Message[] }) => {
            // Check if there are todos in the input
            if (opts.tool.input?.todos && Array.isArray(opts.tool.input.todos) && opts.tool.input.todos.length > 0) {
                return false; // Has todos, show expanded
            }

            // Check if there are todos in the result
            if (opts.tool.result?.newTodos && Array.isArray(opts.tool.result.newTodos) && opts.tool.result.newTodos.length > 0) {
                return false; // Has todos, show expanded
            }

            return true; // No todos, render as minimal
        },
        input: z.object({
            todos: z.array(z.object({
                content: z.string().describe('The todo item content'),
                status: z.enum(['pending', 'in_progress', 'completed']).describe('The status of the todo'),
                priority: z.enum(['high', 'medium', 'low']).optional().describe('The priority of the todo'),
                id: z.string().optional().describe('Unique identifier for the todo')
            }).loose()).describe('The updated todo list')
        }).partial().loose(),
        result: z.object({
            oldTodos: z.array(z.object({
                content: z.string().describe('The todo item content'),
                status: z.enum(['pending', 'in_progress', 'completed']).describe('The status of the todo'),
                priority: z.enum(['high', 'medium', 'low']).optional().describe('The priority of the todo'),
                id: z.string().describe('Unique identifier for the todo')
            }).loose()).describe('The old todo list'),
            newTodos: z.array(z.object({
                content: z.string().describe('The todo item content'),
                status: z.enum(['pending', 'in_progress', 'completed']).describe('The status of the todo'),
                priority: z.enum(['high', 'medium', 'low']).optional().describe('The priority of the todo'),
                id: z.string().describe('Unique identifier for the todo')
            }).loose()).describe('The new todo list')
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (Array.isArray(opts.tool.input.todos)) {
                const count = opts.tool.input.todos.length;
                return t('tools.desc.todoListCount', { count });
            }
            return t('tools.names.todoList');
        },
    },
    'TodoRead': {
        title: t('tools.names.todoList'),
        icon: ICON_TODO,
        noStatus: true,
        minimal: true,
        result: z.object({
            todos: z.array(z.object({
                content: z.string().describe('The todo item content'),
                status: z.enum(['pending', 'in_progress', 'completed']).describe('The status of the todo'),
                priority: z.enum(['high', 'medium', 'low']).optional().describe('The priority of the todo'),
                id: z.string().optional().describe('Unique identifier for the todo')
            }).loose()).describe('The current todo list')
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const list = Array.isArray(opts.tool.result?.todos) ? opts.tool.result.todos : null;
            if (list) {
                return t('tools.desc.todoListCount', { count: list.length });
            }
            return t('tools.names.todoList');
        },
    },
} satisfies Record<string, KnownToolDefinition>;

