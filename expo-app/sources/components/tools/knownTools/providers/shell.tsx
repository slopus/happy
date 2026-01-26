import type { Metadata } from '@/sync/storageTypes';
import type { ToolCall } from '@/sync/typesMessage';
import { resolvePath } from '@/utils/pathUtils';
import * as z from 'zod';
import { t } from '@/text';
import { ICON_TERMINAL } from '../icons';
import type { KnownToolDefinition } from '../_types';
import { extractShellCommand } from '../../utils/shellCommand';

export const providerShellTools = {
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
} satisfies Record<string, KnownToolDefinition>;

