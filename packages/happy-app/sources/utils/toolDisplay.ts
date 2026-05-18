import { ToolCall } from '@/sync/typesMessage';
import { stringifyToolCommand } from './toolCommand';

const TERMINAL_TOOL_NAMES = new Set([
    'Bash',
    'CodexBash',
    'GeminiBash',
    'shell',
    'execute',
]);

export function isTerminalToolName(name: string): boolean {
    return TERMINAL_TOOL_NAMES.has(name);
}

export function shouldRenderToolCardHeader(toolName: string, platformOS: string): boolean {
    return !(platformOS === 'web' && toolName === 'CodexPatch');
}

export function getTerminalToolCommand(tool: Pick<ToolCall, 'name' | 'input'>): string | null {
    if (!isTerminalToolName(tool.name)) {
        return null;
    }

    const parsedCmd = tool.input?.parsed_cmd;
    if (Array.isArray(parsedCmd) && parsedCmd.length > 0) {
        const cmd = parsedCmd.find((item) => typeof item?.cmd === 'string' && item.cmd.trim().length > 0)?.cmd;
        if (cmd) {
            return cmd.trim();
        }
    }

    const directCommand = stringifyToolCommand(tool.input?.command);
    if (directCommand) {
        return directCommand;
    }

    const title = tool.input?.toolCall?.title;
    if (typeof title === 'string') {
        const bracketIdx = title.indexOf(' [');
        const command = bracketIdx > 0 ? title.substring(0, bracketIdx) : title;
        const trimmed = command.trim();
        if (trimmed.length > 0) {
            return trimmed;
        }
    }

    return null;
}
