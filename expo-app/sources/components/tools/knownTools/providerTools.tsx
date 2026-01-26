import type { Metadata } from '@/sync/storageTypes';
import type { ToolCall, Message } from '@/sync/typesMessage';
import { resolvePath } from '@/utils/pathUtils';
import * as z from 'zod';
import { t } from '@/text';
import { ICON_TASK, ICON_TERMINAL, ICON_SEARCH, ICON_READ, ICON_EDIT, ICON_WEB, ICON_EXIT, ICON_TODO, ICON_REASONING, ICON_QUESTION } from './icons';
import type { KnownToolDefinition } from './_types';
import { extractShellCommand } from '../utils/shellCommand';

export const knownToolsProviders = {
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
                // Remove shell wrapper prefix if present (bash/zsh with -lc flag)
                if (cmdArray.length >= 3 && (cmdArray[0] === 'bash' || cmdArray[0] === '/bin/bash' || cmdArray[0] === 'zsh' || cmdArray[0] === '/bin/zsh') && cmdArray[1] === '-lc') {
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
    'change_title': {
        title: t('tools.names.changeTitle'),
        icon: ICON_EDIT,
        minimal: true,
        noStatus: true,
        input: z.object({
            title: z.string().optional().describe('New session title')
        }).partial().loose(),
        result: z.object({}).partial().loose()
    },
    // Gemini internal tools - should be hidden (minimal)
    'search': {
        title: t('tools.names.search'),
        icon: ICON_SEARCH,
        minimal: true,
        input: z.object({
            items: z.array(z.any()).optional(),
            locations: z.array(z.any()).optional()
        }).partial().loose()
    },
    'edit': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Gemini sends data in nested structure, try multiple locations
            let filePath: string | undefined;
            
            // 1. Check toolCall.content[0].path
            if (typeof opts.tool.input?.toolCall?.content?.[0]?.path === 'string') {
                filePath = opts.tool.input.toolCall.content[0].path;
            }
            // 2. Check toolCall.title (has nice "Writing to ..." format)
            else if (typeof opts.tool.input?.toolCall?.title === 'string') {
                return opts.tool.input.toolCall.title;
            }
            // 3. Check input[0].path (array format)
            else if (Array.isArray(opts.tool.input?.input) && typeof opts.tool.input.input[0]?.path === 'string') {
                filePath = opts.tool.input.input[0].path;
            }
            // 4. Check direct path field
            else if (typeof opts.tool.input?.path === 'string') {
                filePath = opts.tool.input.path;
            }
            
            if (typeof filePath === 'string' && filePath.length > 0) {
                return resolvePath(filePath, opts.metadata);
            }
            return t('tools.names.editFile');
        },
        icon: ICON_EDIT,
        isMutable: true,
        input: z.object({
            path: z.string().describe('The file path to edit'),
            oldText: z.string().describe('The text to replace'),
            newText: z.string().describe('The new text'),
            type: z.string().optional().describe('Type of edit (diff)')
        }).partial().loose()
    },
    'shell': {
        title: t('tools.names.terminal'),
        icon: ICON_TERMINAL,
        minimal: true,
        isMutable: true,
        input: z.object({}).partial().loose()
    },
    'execute': {
        title: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Prefer a human-readable title when provided by ACP metadata
            const acpTitle =
                typeof opts.tool.input?._acp?.title === 'string'
                    ? opts.tool.input._acp.title
                    : typeof opts.tool.input?.toolCall?.title === 'string'
                        ? opts.tool.input.toolCall.title
                        : null;
            if (acpTitle) {
                // Title is often like "rm file.txt [cwd /path] (description)".
                // Extract just the command part before [
                const bracketIdx = acpTitle.indexOf(' [');
                if (bracketIdx > 0) return acpTitle.substring(0, bracketIdx);
                return acpTitle;
            }
            const cmd = extractShellCommand(opts.tool.input);
            if (cmd) return cmd;
            return t('tools.names.terminal');
        },
        icon: ICON_TERMINAL,
        isMutable: true,
        input: z.object({}).partial().loose(),
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            const cmd = extractShellCommand(opts.tool.input);
            if (cmd) return cmd;
            return null;
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
    'GeminiBash': {
        title: t('tools.names.terminal'),
        icon: ICON_TERMINAL,
        minimal: true,
        hideDefaultError: true,
        isMutable: true,
        input: z.object({
            command: z.array(z.string()).describe('The command array to execute'),
            cwd: z.string().optional().describe('Current working directory')
        }).partial().loose(),
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            if (opts.tool.input?.command && Array.isArray(opts.tool.input.command)) {
                let cmdArray = opts.tool.input.command;
                // Remove shell wrapper prefix if present (bash/zsh with -lc flag)
                if (cmdArray.length >= 3 && (cmdArray[0] === 'bash' || cmdArray[0] === '/bin/bash' || cmdArray[0] === 'zsh' || cmdArray[0] === '/bin/zsh') && cmdArray[1] === '-lc') {
                    return cmdArray[2];
                }
                return cmdArray.join(' ');
            }
            return null;
        }
    },
    'GeminiPatch': {
        title: t('tools.names.applyChanges'),
        icon: ICON_EDIT,
        minimal: true,
        hideDefaultError: true,
        isMutable: true,
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
    },
    'GeminiDiff': {
        title: t('tools.names.viewDiff'),
        icon: ICON_EDIT,
        minimal: false,  // Show full diff view
        hideDefaultError: true,
        noStatus: true,  // Always successful, stateless like Task
        input: z.object({
            unified_diff: z.string().optional().describe('Unified diff content'),
            filePath: z.string().optional().describe('File path'),
            description: z.string().optional().describe('Edit description')
        }).partial().loose(),
        result: z.object({
            status: z.literal('completed').describe('Always completed')
        }).partial().loose(),
        extractSubtitle: (opts: { metadata: Metadata | null, tool: ToolCall }) => {
            // Try to extract filename from filePath first
            if (opts.tool.input?.filePath && typeof opts.tool.input.filePath === 'string') {
                const basename = opts.tool.input.filePath.split('/').pop() || opts.tool.input.filePath;
                return basename;
            }
            // Fall back to extracting from unified diff
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
    },
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
