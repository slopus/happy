import { Metadata, Session } from '@/sync/storageTypes';
import { ToolCall } from '@/sync/typesMessage';
import { resolvePath } from '@/utils/pathUtils';
import * as z from 'zod';

export const knownTools = {
    'Task': {
        title: 'Task',
        icon: 'rocket',
        input: z.object({
            prompt: z.string().describe('The task for the agent to perform'),
            subagent_type: z.string().optional().describe('The type of specialized agent to use')
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const type = opts.tool.input.subagent_type;
            if (type) {
                return `Task(type: ${type})`;
            }
            return 'Task';
        },
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.description === 'string') {
                return opts.tool.input.description;
            }
            if (typeof opts.tool.input.prompt === 'string') {
                return opts.tool.input.prompt;
            }
            return null;
        }
    },
    'Bash': {
        title: 'Terminal',
        icon: 'terminal',
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
        title: 'Search',
        icon: 'search',
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
        },
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.path === 'string') {
                return resolvePath(opts.tool.input.path, opts.metadata);
            }
            return null;
        },
        extractStatus: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.pattern === 'string') {
                return opts.tool.input.pattern;
            }
            return null;
        },
    },
    'Grep': {
        title: 'Search',
        icon: 'search',
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
        },
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.path === 'string') {
                return resolvePath(opts.tool.input.path, opts.metadata);
            }
            return null;
        },
        extractStatus: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.pattern === 'string') {
                return opts.tool.input.pattern;
            }
            return null;
        }
    },
    'LS': {
        title: 'Search',
        icon: 'search',
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
        },
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.path === 'string') {
                return resolvePath(opts.tool.input.path, opts.metadata);
            }
            return null;
        },
    },
    'ExitPlanMode': {
        title: 'Exit Plan Mode',
        icon: 'exit',
        input: z.object({
            plan: z.string().describe('The plan you came up with')
        }).partial().loose()
    },
    'Read': {
        minimal: true,
        title: 'Read',
        icon: 'document-text',
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
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                const filename = path.split('/').pop() || path;
                return `Read(file: ${filename})`;
            }
            return 'Read';
        },
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                return resolvePath(opts.tool.input.file_path, opts.metadata);
            }
            return null;
        },
        extractStatus: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (opts.tool.state === 'completed' && opts.tool.result && typeof opts.tool.result === 'object' && opts.tool.result.file && typeof opts.tool.result.file.numLines === 'number') {
                return `${opts.tool.result.file.numLines} lines`;
            }
            return null;
        }
    },
    'Edit': {
        title: 'Edit File',
        icon: 'document-text',
        input: z.object({
            file_path: z.string().describe('The absolute path to the file to modify'),
            old_string: z.string().describe('The text to replace'),
            new_string: z.string().describe('The text to replace it with'),
            replace_all: z.boolean().optional().default(false).describe('Replace all occurrences')
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                const filename = path.split('/').pop() || path;
                return `Edit File(file: ${filename})`;
            }
            return 'Edit File';
        },
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                return resolvePath(opts.tool.input.file_path, opts.metadata);
            }
            return null;
        }
    },
    'MultiEdit': {
        title: 'Edit File',
        icon: 'document-text',
        input: z.object({
            file_path: z.string().describe('The absolute path to the file to modify'),
            edits: z.array(z.object({
                old_string: z.string().describe('The text to replace'),
                new_string: z.string().describe('The text to replace it with'),
                replace_all: z.boolean().optional().default(false).describe('Replace all occurrences')
            })).describe('Array of edit operations')
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                const filename = path.split('/').pop() || path;
                const editCount = Array.isArray(opts.tool.input.edits) ? opts.tool.input.edits.length : 0;
                if (editCount > 0) {
                    return `Edit File(file: ${filename}, edits: ${editCount})`;
                }
                return `Edit File(file: ${filename})`;
            }
            return 'Edit File';
        },
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                return resolvePath(opts.tool.input.file_path, opts.metadata);
            }
            return null;
        }
    },
    'Write': {
        title: 'Write File',
        icon: 'document-text',
        minimal: true,
        input: z.object({
            file_path: z.string().describe('The absolute path to the file to write'),
            content: z.string().describe('The content to write to the file')
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                const path = resolvePath(opts.tool.input.file_path, opts.metadata);
                const filename = path.split('/').pop() || path;
                return `Write File(file: ${filename})`;
            }
            return 'Write File';
        },
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.file_path === 'string') {
                return resolvePath(opts.tool.input.file_path, opts.metadata);
            }
            return null;
        }
    },
    'WebFetch': {
        title: 'Fetch URL',
        icon: 'globe',
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
        },
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            return opts.tool.input.url || null;
        }
    },
    'NotebookRead': {
        title: 'Read Notebook',
        icon: 'book',
        minimal: true,
        input: z.object({
            notebook_path: z.string().describe('The absolute path to the Jupyter notebook file'),
            cell_id: z.string().optional().describe('The ID of a specific cell to read')
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.notebook_path === 'string') {
                const path = resolvePath(opts.tool.input.notebook_path, opts.metadata);
                const filename = path.split('/').pop() || path;
                if (opts.tool.input.cell_id) {
                    return `Read Notebook(file: ${filename}, cell: ${opts.tool.input.cell_id})`;
                }
                return `Read Notebook(file: ${filename})`;
            }
            return 'Read Notebook';
        },
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.notebook_path === 'string') {
                return resolvePath(opts.tool.input.notebook_path, opts.metadata);
            }
            return null;
        }
    },
    'NotebookEdit': {
        title: 'Edit Notebook',
        icon: 'book',
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
                const filename = path.split('/').pop() || path;
                const mode = opts.tool.input.edit_mode || 'replace';
                return `Edit Notebook(file: ${filename}, mode: ${mode})`;
            }
            return 'Edit Notebook';
        },
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.notebook_path === 'string') {
                return resolvePath(opts.tool.input.notebook_path, opts.metadata);
            }
            return null;
        }
    },
    'TodoWrite': {
        title: 'Todo List',
        icon: 'bulb-outline',
        noStatus: true,
        input: z.object({
            todos: z.array(z.object({
                content: z.string().describe('The todo item content'),
                status: z.enum(['pending', 'in_progress', 'completed']).describe('The status of the todo'),
                priority: z.enum(['high', 'medium', 'low']).describe('The priority of the todo'),
                id: z.string().describe('Unique identifier for the todo')
            }).loose()).describe('The updated todo list')
        }).partial().loose(),
        result: z.object({
            oldTodos: z.array(z.object({
                content: z.string().describe('The todo item content'),
                status: z.enum(['pending', 'in_progress', 'completed']).describe('The status of the todo'),
                priority: z.enum(['high', 'medium', 'low']).describe('The priority of the todo'),
                id: z.string().describe('Unique identifier for the todo')
            }).loose()).describe('The old todo list'),
            newTodos: z.array(z.object({
                content: z.string().describe('The todo item content'),
                status: z.enum(['pending', 'in_progress', 'completed']).describe('The status of the todo'),
                priority: z.enum(['high', 'medium', 'low']).describe('The priority of the todo'),
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
        title: 'Web Search',
        icon: 'globe',
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
        },
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.query === 'string') {
                return opts.tool.input.query;
            }
            return null;
        }
    }
} satisfies Record<string, {
    title: string;
    icon: string;
    noStatus?: boolean;
    input?: z.ZodObject<any>;
    result?: z.ZodObject<any>;
    minimal?: boolean;
    extractDescription?: (opts: { metadata: Metadata | null, tool: ToolCall }) => string;
    extractSubtitle?: (opts: { metadata: Metadata | null, tool: ToolCall }) => string | null;
    extractStatus?: (opts: { metadata: Metadata | null, tool: ToolCall }) => string | null;
}>;