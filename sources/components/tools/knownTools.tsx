import { Metadata } from '@/sync/storageTypes';
import { ToolCall } from '@/sync/typesMessage';
import { resolvePath } from '@/utils/pathUtils';
import * as z from 'zod';
import { Ionicons, Octicons } from '@expo/vector-icons';
import React from 'react';

// Icon factory functions
const ICON_TASK = (size: number = 24, color: string = '#000') => <Octicons name="rocket" size={size} color={color} />;
const ICON_TERMINAL = (size: number = 24, color: string = '#000') => <Octicons name="terminal" size={size} color={color} />;
const ICON_SEARCH = (size: number = 24, color: string = '#000') => <Octicons name="search" size={size} color={color} />;
const ICON_READ = (size: number = 24, color: string = '#000') => <Octicons name="eye" size={size} color={color} />;
const ICON_EDIT = (size: number = 24, color: string = '#000') => <Octicons name="file-diff" size={size} color={color} />;
const ICON_WEB = (size: number = 24, color: string = '#000') => <Ionicons name="globe-outline" size={size} color={color} />;
const ICON_EXIT = (size: number = 24, color: string = '#000') => <Ionicons name="exit-outline" size={size} color={color} />;
const ICON_TODO = (size: number = 24, color: string = '#000') => <Ionicons name="bulb-outline" size={size} color={color} />;

export const knownTools = {
    'Task': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Check for description field at runtime
            if (opts.tool.input && opts.tool.input.description && typeof opts.tool.input.description === 'string') {
                return opts.tool.input.description;
            }
            return 'Task';
        },
        icon: ICON_TASK,
        input: z.object({
            prompt: z.string().describe('The task for the agent to perform'),
            subagent_type: z.string().optional().describe('The type of specialized agent to use')
        }).partial().loose()
    },
    'Bash': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (opts.tool.description) {
                return opts.tool.description;
            }
            return 'Terminal';
        },
        icon: ICON_TERMINAL,
        minimal: true,
        hideDefaultError: true,
        input: z.object({
            command: z.string().describe('The command to execute'),
            timeout: z.number().optional().describe('Timeout in milliseconds (max 600000)')
        }),
        result: z.object({
            stderr: z.string(),
            stdout: z.string(),
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.command === 'string') {
                const cmd = opts.tool.input.command;
                // Extract just the command name for common commands
                const firstWord = cmd.split(' ')[0];
                if (['cd', 'ls', 'pwd', 'mkdir', 'rm', 'cp', 'mv', 'npm', 'yarn', 'git'].includes(firstWord)) {
                    return `Terminal(cmd: ${firstWord})`;
                }
                // For other commands, show truncated version
                const truncated = cmd.length > 20 ? cmd.substring(0, 20) + '...' : cmd;
                return `Terminal(cmd: ${truncated})`;
            }
            return 'Terminal';
        },
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.command === 'string') {
                return opts.tool.input.command;
            }
            return null;
        }
    },
    'Glob': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.pattern === 'string') {
                return opts.tool.input.pattern;
            }
            return 'Search Files';
        },
        icon: ICON_SEARCH,
        minimal: true,
        input: z.object({
            pattern: z.string().describe('The glob pattern to match files against'),
            path: z.string().optional().describe('The directory to search in')
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.pattern === 'string') {
                return `Search(pattern: ${opts.tool.input.pattern})`;
            }
            return 'Search';
        }
    },
    'Grep': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.pattern === 'string') {
                return `grep(pattern: ${opts.tool.input.pattern})`;
            }
            return 'Search Content';
        },
        icon: ICON_READ,
        minimal: true,
        input: z.object({
            pattern: z.string().describe('The regular expression pattern to search for'),
            path: z.string().optional().describe('File or directory to search in'),
            output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
            '-n': z.boolean().optional().describe('Show line numbers'),
            '-i': z.boolean().optional().describe('Case insensitive search'),
            '-A': z.number().optional().describe('Lines to show after match'),
            '-B': z.number().optional().describe('Lines to show before match'),
            '-C': z.number().optional().describe('Lines to show before and after match'),
            glob: z.string().optional().describe('Glob pattern to filter files'),
            type: z.string().optional().describe('File type to search'),
            head_limit: z.number().optional().describe('Limit output to first N lines/entries'),
            multiline: z.boolean().optional().describe('Enable multiline mode')
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.pattern === 'string') {
                const pattern = opts.tool.input.pattern.length > 20
                    ? opts.tool.input.pattern.substring(0, 20) + '...'
                    : opts.tool.input.pattern;
                return `Search(pattern: ${pattern})`;
            }
            return 'Search';
        }
    },
    'LS': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.path === 'string') {
                return resolvePath(opts.tool.input.path, opts.metadata);
            }
            return 'List Files';
        },
        icon: ICON_SEARCH,
        minimal: true,
        input: z.object({
            path: z.string().describe('The absolute path to the directory to list'),
            ignore: z.array(z.string()).optional().describe('List of glob patterns to ignore')
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.path === 'string') {
                const path = resolvePath(opts.tool.input.path, opts.metadata);
                const basename = path.split('/').pop() || path;
                return `Search(path: ${basename})`;
            }
            return 'Search';
        }
    },
    'ExitPlanMode': {
        title: 'Plan proposal',
        icon: ICON_EXIT,
        input: z.object({
            plan: z.string().describe('The plan you came up with')
        }).partial().loose()
    },
    'exit_plan_mode': {
        title: 'Plan proposal',
        icon: ICON_EXIT,
        input: z.object({
            plan: z.string().describe('The plan you came up with')
        }).partial().loose()
    },
    'Read': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                return path;
            }
            return 'Read File';
        },
        minimal: true,
        icon: ICON_READ,
        input: z.object({
            file_path: z.string().describe('The absolute path to the file to read'),
            limit: z.number().optional().describe('The number of lines to read'),
            offset: z.number().optional().describe('The line number to start reading from')
        }).partial().loose(),
        result: z.object({
            file: z.object({
                filePath: z.string().describe('The absolute path to the file to read'),
                content: z.string().describe('The content of the file'),
                numLines: z.number().describe('The number of lines in the file'),
                startLine: z.number().describe('The line number to start reading from'),
                totalLines: z.number().describe('The total number of lines in the file')
            }).loose().optional()
        }).partial().loose()
    },
    'Edit': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                return path;
            }
            return 'Edit File';
        },
        icon: ICON_EDIT,
        input: z.object({
            file_path: z.string().describe('The absolute path to the file to modify'),
            old_string: z.string().describe('The text to replace'),
            new_string: z.string().describe('The text to replace it with'),
            replace_all: z.boolean().optional().default(false).describe('Replace all occurrences')
        }).partial().loose()
    },
    'MultiEdit': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                const editCount = Array.isArray(opts.tool.input.edits) ? opts.tool.input.edits.length : 0;
                if (editCount > 1) {
                    return `${path} (${editCount} edits)`;
                }
                return path;
            }
            return 'Edit File';
        },
        icon: ICON_EDIT,
        input: z.object({
            file_path: z.string().describe('The absolute path to the file to modify'),
            edits: z.array(z.object({
                old_string: z.string().describe('The text to replace'),
                new_string: z.string().describe('The text to replace it with'),
                replace_all: z.boolean().optional().default(false).describe('Replace all occurrences')
            })).describe('Array of edit operations')
        }).partial().loose(),
        extractStatus: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                const editCount = Array.isArray(opts.tool.input.edits) ? opts.tool.input.edits.length : 0;
                if (editCount > 0) {
                    return `${path} (${editCount} edits)`;
                }
                return path;
            }
            return null;
        }
    },
    'Write': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                return path;
            }
            return 'Write File';
        },
        icon: ICON_EDIT,
        minimal: true,
        input: z.object({
            file_path: z.string().describe('The absolute path to the file to write'),
            content: z.string().describe('The content to write to the file')
        }).partial().loose()
    },
    'WebFetch': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.url === 'string') {
                try {
                    const url = new URL(opts.tool.input.url);
                    return url.hostname;
                } catch {
                    return 'Fetch URL';
                }
            }
            return 'Fetch URL';
        },
        icon: ICON_WEB,
        minimal: true,
        input: z.object({
            url: z.string().url().describe('The URL to fetch content from'),
            prompt: z.string().describe('The prompt to run on the fetched content')
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.url === 'string') {
                try {
                    const url = new URL(opts.tool.input.url);
                    return `Fetch URL(url: ${url.hostname})`;
                } catch {
                    return 'Fetch URL';
                }
            }
            return 'Fetch URL';
        }
    },
    'NotebookRead': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.notebook_path === 'string') {
                const path = resolvePath(opts.tool.input.notebook_path, opts.metadata);
                return path;
            }
            return 'Read Notebook';
        },
        icon: ICON_READ,
        minimal: true,
        input: z.object({
            notebook_path: z.string().describe('The absolute path to the Jupyter notebook file'),
            cell_id: z.string().optional().describe('The ID of a specific cell to read')
        }).partial().loose()
    },
    'NotebookEdit': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.notebook_path === 'string') {
                const path = resolvePath(opts.tool.input.notebook_path, opts.metadata);
                return path;
            }
            return 'Edit Notebook';
        },
        icon: ICON_EDIT,
        input: z.object({
            notebook_path: z.string().describe('The absolute path to the notebook file'),
            new_source: z.string().describe('The new source for the cell'),
            cell_id: z.string().optional().describe('The ID of the cell to edit'),
            cell_type: z.enum(['code', 'markdown']).optional().describe('The type of the cell'),
            edit_mode: z.enum(['replace', 'insert', 'delete']).optional().describe('The type of edit to make')
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.notebook_path === 'string') {
                const path = resolvePath(opts.tool.input.notebook_path, opts.metadata);
                const mode = opts.tool.input.edit_mode || 'replace';
                return `Edit Notebook(file: ${path}, mode: ${mode})`;
            }
            return 'Edit Notebook';
        }
    },
    'TodoWrite': {
        title: 'Todo List',
        icon: ICON_TODO,
        noStatus: true,
        input: z.object({
            todos: z.array(z.object({
                content: z.string().describe('The todo item content'),
                status: z.enum(['pending', 'in_progress', 'completed']).describe('The status of the todo'),
                priority: z.enum(['high', 'medium', 'low']).optional().describe('The priority of the todo'),
                id: z.string().describe('Unique identifier for the todo')
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
                return `Todo List(count: ${count})`;
            }
            return 'Todo List';
        },
    },
    'WebSearch': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.query === 'string') {
                return opts.tool.input.query;
            }
            return 'Web Search';
        },
        icon: ICON_WEB,
        minimal: true,
        input: z.object({
            query: z.string().min(2).describe('The search query to use'),
            allowed_domains: z.array(z.string()).optional().describe('Only include results from these domains'),
            blocked_domains: z.array(z.string()).optional().describe('Never include results from these domains')
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.query === 'string') {
                const query = opts.tool.input.query.length > 30
                    ? opts.tool.input.query.substring(0, 30) + '...'
                    : opts.tool.input.query;
                return `Web Search(query: ${query})`;
            }
            return 'Web Search';
        }
    }
} satisfies Record<string, {
    title?: string | ((opts: { metadata: Metadata | null, tool: ToolCall }) => string);
    icon: (size: number, color: string) => React.ReactNode;
    noStatus?: boolean;
    hideDefaultError?: boolean;
    input?: z.ZodObject<any>;
    result?: z.ZodObject<any>;
    minimal?: boolean;
    extractDescription?: (opts: { metadata: Metadata | null, tool: ToolCall }) => string;
    extractSubtitle?: (opts: { metadata: Metadata | null, tool: ToolCall }) => string | null;
    extractStatus?: (opts: { metadata: Metadata | null, tool: ToolCall }) => string | null;
}>;