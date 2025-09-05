import { Metadata } from '@/sync/storageTypes';
import { ToolCall, Message } from '@/sync/typesMessage';
import { resolvePath } from '@/utils/pathUtils';
import * as z from 'zod';
import { Ionicons, Octicons } from '@expo/vector-icons';
import React from 'react';
import { t } from '@/text';

// Icon factory functions
const ICON_TASK = (size: number = 24, color: string = '#000') => <Octicons name="rocket" size={size} color={color} />;
const ICON_TERMINAL = (size: number = 24, color: string = '#000') => <Octicons name="terminal" size={size} color={color} />;
const ICON_SEARCH = (size: number = 24, color: string = '#000') => <Octicons name="search" size={size} color={color} />;
const ICON_READ = (size: number = 24, color: string = '#000') => <Octicons name="eye" size={size} color={color} />;
const ICON_EDIT = (size: number = 24, color: string = '#000') => <Octicons name="file-diff" size={size} color={color} />;
const ICON_WEB = (size: number = 24, color: string = '#000') => <Ionicons name="globe-outline" size={size} color={color} />;
const ICON_EXIT = (size: number = 24, color: string = '#000') => <Ionicons name="exit-outline" size={size} color={color} />;
const ICON_TODO = (size: number = 24, color: string = '#000') => <Ionicons name="bulb-outline" size={size} color={color} />;
const ICON_REASONING = (size: number = 24, color: string = '#000') => <Octicons name="light-bulb" size={size} color={color} />;

export const knownTools = {
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
    'Bash': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (opts.tool.description) {
                return opts.tool.description;
            }
            return t('tools.names.terminal');
        },
        icon: ICON_TERMINAL,
        minimal: true,
        hideDefaultError: true,
        isMutable: true,
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
                    return t('tools.desc.terminalCmd', { cmd: firstWord });
                }
                // For other commands, show truncated version
                const truncated = cmd.length > 20 ? cmd.substring(0, 20) + '...' : cmd;
                return t('tools.desc.terminalCmd', { cmd: truncated });
            }
            return t('tools.names.terminal');
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
            return t('tools.names.searchFiles');
        },
        icon: ICON_SEARCH,
        minimal: true,
        input: z.object({
            pattern: z.string().describe('The glob pattern to match files against'),
            path: z.string().optional().describe('The directory to search in')
        }).partial().loose(),
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.pattern === 'string') {
                return t('tools.desc.searchPattern', { pattern: opts.tool.input.pattern });
            }
            return t('tools.names.search');
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
            return t('tools.names.listFiles');
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
                return t('tools.desc.searchPath', { basename });
            }
            return t('tools.names.search');
        }
    },
    'ExitPlanMode': {
        title: t('tools.names.planProposal'),
        icon: ICON_EXIT,
        input: z.object({
            plan: z.string().describe('The plan you came up with')
        }).partial().loose()
    },
    'exit_plan_mode': {
        title: t('tools.names.planProposal'),
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
            return t('tools.names.readFile');
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
            return t('tools.names.editFile');
        },
        icon: ICON_EDIT,
        isMutable: true,
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
                    return t('tools.desc.multiEditEdits', { path, count: editCount });
                }
                return path;
            }
            return t('tools.names.editFile');
        },
        icon: ICON_EDIT,
        isMutable: true,
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
                    return t('tools.desc.multiEditEdits', { path, count: editCount });
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
            return t('tools.names.writeFile');
        },
        icon: ICON_EDIT,
        isMutable: true,
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
                    return t('tools.names.fetchUrl');
                }
            }
            return t('tools.names.fetchUrl');
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
                    return t('tools.desc.fetchUrlHost', { host: url.hostname });
                } catch {
                    return t('tools.names.fetchUrl');
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
            return t('tools.names.readNotebook');
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
            return t('tools.names.editNotebook');
        },
        icon: ICON_EDIT,
        isMutable: true,
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
                return t('tools.desc.editNotebookMode', { path, mode });
            }
            return t('tools.names.editNotebook');
        }
    },
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
    'WebSearch': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (typeof opts.tool.input.query === 'string') {
                return opts.tool.input.query;
            }
            return t('tools.names.webSearch');
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
                return t('tools.desc.webSearchQuery', { query });
            }
            return t('tools.names.webSearch');
        }
    },
    'CodexBash': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Check if this is a single read command
            if (opts.tool.input?.parsed_cmd && 
                Array.isArray(opts.tool.input.parsed_cmd) && 
                opts.tool.input.parsed_cmd.length === 1 && 
                opts.tool.input.parsed_cmd[0].type === 'read' &&
                opts.tool.input.parsed_cmd[0].name) {
                // Display the file name being read
                const path = resolvePath(opts.tool.input.parsed_cmd[0].name, opts.metadata);
                return path;
            }
            return t('tools.names.terminal');
        },
        icon: ICON_TERMINAL,
        minimal: true,
        hideDefaultError: true,
        isMutable: true,
        input: z.object({
            command: z.array(z.string()).describe('The command array to execute'),
            cwd: z.string().optional().describe('Current working directory'),
            parsed_cmd: z.array(z.object({
                type: z.string().describe('Type of parsed command (read, write, bash, etc.)'),
                cmd: z.string().optional().describe('The command string'),
                name: z.string().optional().describe('File name or resource name')
            }).loose()).optional().describe('Parsed command information')
        }).partial().loose(),
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // For single read commands, show the actual command
            if (opts.tool.input?.parsed_cmd && 
                Array.isArray(opts.tool.input.parsed_cmd) && 
                opts.tool.input.parsed_cmd.length === 1 &&
                opts.tool.input.parsed_cmd[0].type === 'read') {
                const parsedCmd = opts.tool.input.parsed_cmd[0];
                if (parsedCmd.cmd) {
                    // Show the command but truncate if too long
                    const cmd = parsedCmd.cmd;
                    return cmd.length > 50 ? cmd.substring(0, 50) + '...' : cmd;
                }
            }
            // Show the actual command being executed for other cases
            if (opts.tool.input?.parsed_cmd && Array.isArray(opts.tool.input.parsed_cmd) && opts.tool.input.parsed_cmd.length > 0) {
                const parsedCmd = opts.tool.input.parsed_cmd[0];
                if (parsedCmd.cmd) {
                    return parsedCmd.cmd;
                }
            }
            if (opts.tool.input?.command && Array.isArray(opts.tool.input.command)) {
                let cmdArray = opts.tool.input.command;
                // Remove ["bash", "-lc"] prefix if present
                if (cmdArray.length >= 3 && cmdArray[0] === 'bash' && cmdArray[1] === '-lc') {
                    // The actual command is in the third element
                    return cmdArray[2];
                }
                return cmdArray.join(' ');
            }
            return null;
        },
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Provide a description based on the parsed command type
            if (opts.tool.input?.parsed_cmd && 
                Array.isArray(opts.tool.input.parsed_cmd) && 
                opts.tool.input.parsed_cmd.length === 1) {
                const parsedCmd = opts.tool.input.parsed_cmd[0];
                if (parsedCmd.type === 'read' && parsedCmd.name) {
                    // For single read commands, show "Reading" as simple description
                    // The file path is already in the title
                    const path = resolvePath(parsedCmd.name, opts.metadata);
                    const basename = path.split('/').pop() || path;
                    return t('tools.desc.readingFile', { file: basename });
                } else if (parsedCmd.type === 'write' && parsedCmd.name) {
                    const path = resolvePath(parsedCmd.name, opts.metadata);
                    const basename = path.split('/').pop() || path;
                    return t('tools.desc.writingFile', { file: basename });
                }
            }
            return t('tools.names.terminal');
        }
    },
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
    'CodexPatch': {
        title: t('tools.names.applyChanges'),
        icon: ICON_EDIT,
        minimal: true,
        hideDefaultError: true,
        input: z.object({
            auto_approved: z.boolean().optional().describe('Whether changes were auto-approved'),
            changes: z.record(z.string(), z.object({
                add: z.object({
                    content: z.string()
                }).optional(),
                modify: z.object({
                    old_content: z.string(),
                    new_content: z.string()
                }).optional(),
                delete: z.object({
                    content: z.string()
                }).optional()
            }).loose()).describe('File changes to apply')
        }).partial().loose(),
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Show the first file being modified
            if (opts.tool.input?.changes && typeof opts.tool.input.changes === 'object') {
                const files = Object.keys(opts.tool.input.changes);
                if (files.length > 0) {
                    const path = resolvePath(files[0], opts.metadata);
                    const fileName = path.split('/').pop() || path;
                    if (files.length > 1) {
                        return t('tools.desc.modifyingMultipleFiles', { 
                            file: fileName, 
                            count: files.length - 1 
                        });
                    }
                    return fileName;
                }
            }
            return null;
        },
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Show the number of files being modified
            if (opts.tool.input?.changes && typeof opts.tool.input.changes === 'object') {
                const files = Object.keys(opts.tool.input.changes);
                const fileCount = files.length;
                if (fileCount === 1) {
                    const path = resolvePath(files[0], opts.metadata);
                    const fileName = path.split('/').pop() || path;
                    return t('tools.desc.modifyingFile', { file: fileName });
                } else if (fileCount > 1) {
                    return t('tools.desc.modifyingFiles', { count: fileCount });
                }
            }
            return t('tools.names.applyChanges');
        }
    },
    'CodexDiff': {
        title: t('tools.names.viewDiff'),
        icon: ICON_EDIT,
        minimal: false,  // Show full diff view
        hideDefaultError: true,
        noStatus: true,  // Always successful, stateless like Task
        input: z.object({
            unified_diff: z.string().describe('Unified diff content')
        }).partial().loose(),
        result: z.object({
            status: z.literal('completed').describe('Always completed')
        }).partial().loose(),
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Try to extract filename from unified diff
            if (opts.tool.input?.unified_diff && typeof opts.tool.input.unified_diff === 'string') {
                const diffLines = opts.tool.input.unified_diff.split('\n');
                for (const line of diffLines) {
                    if (line.startsWith('+++ b/') || line.startsWith('+++ ')) {
                        const fileName = line.replace(/^\+\+\+ (b\/)?/, '');
                        const basename = fileName.split('/').pop() || fileName;
                        return basename;
                    }
                }
            }
            return null;
        },
        extractDescription: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            return t('tools.desc.showingDiff');
        }
    }
} satisfies Record<string, {
    title?: string | ((opts: { metadata: Metadata | null, tool: ToolCall }) => string);
    icon: (size: number, color: string) => React.ReactNode;
    noStatus?: boolean;
    hideDefaultError?: boolean;
    isMutable?: boolean;
    input?: z.ZodObject<any>;
    result?: z.ZodObject<any>;
    minimal?: boolean | ((opts: { metadata: Metadata | null, tool: ToolCall, messages?: Message[] }) => boolean);
    extractDescription?: (opts: { metadata: Metadata | null, tool: ToolCall }) => string;
    extractSubtitle?: (opts: { metadata: Metadata | null, tool: ToolCall }) => string | null;
    extractStatus?: (opts: { metadata: Metadata | null, tool: ToolCall }) => string | null;
}>;

/**
 * Check if a tool is mutable (can potentially modify files)
 * @param toolName The name of the tool to check
 * @returns true if the tool is mutable or unknown, false if it's read-only
 */
export function isMutableTool(toolName: string): boolean {
    const tool = knownTools[toolName as keyof typeof knownTools];
    if (tool) {
        if ('isMutable' in tool) {
            return tool.isMutable === true;
        } else {
            return false;
        }
    }
    // If tool is unknown, assume it's mutable to be safe
    return true;
}
