import type { ReasoningEffort } from './codexAppServerTypes';
import type { CodexPermissionMode } from './modeState';

const VALID_CODEX_EFFORTS: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const VALID_CODEX_PERMISSION_MODES: readonly CodexPermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];

export type CodexStartupArgs = {
    resumeThreadId: string | null;
    model?: string;
    effort?: ReasoningEffort;
    permissionMode?: CodexPermissionMode;
    args: string[];
};

function readFlagValue(args: string[], index: number, flag: string, usage: string): { value: string; nextIndex: number } {
    const arg = args[index];
    const equalsPrefix = `${flag}=`;
    if (arg.startsWith(equalsPrefix)) {
        const value = arg.slice(equalsPrefix.length).trim();
        if (!value) {
            throw new Error(usage);
        }
        return { value, nextIndex: index };
    }

    const nextArg = args[index + 1];
    if (!nextArg || nextArg.startsWith('-')) {
        throw new Error(usage);
    }

    return { value: nextArg, nextIndex: index + 1 };
}

function parseEffort(value: string): ReasoningEffort {
    if (VALID_CODEX_EFFORTS.includes(value as ReasoningEffort)) {
        return value as ReasoningEffort;
    }

    throw new Error(`Invalid Codex effort "${value}". Expected one of: ${VALID_CODEX_EFFORTS.join(', ')}.`);
}

function parsePermissionMode(value: string): CodexPermissionMode {
    if (VALID_CODEX_PERMISSION_MODES.includes(value as CodexPermissionMode)) {
        return value as CodexPermissionMode;
    }

    throw new Error(`Invalid Codex permission mode "${value}". Expected one of: ${VALID_CODEX_PERMISSION_MODES.join(', ')}.`);
}

function setPermissionMode(current: CodexPermissionMode | undefined, next: CodexPermissionMode): CodexPermissionMode {
    if (current !== undefined) {
        throw new Error('Codex permission mode can only be provided once.');
    }
    return next;
}

export function parseCodexStartupArgs(args: string[]): CodexStartupArgs {
    const remainingArgs: string[] = [];
    let resumeThreadId: string | null = null;
    let model: string | undefined = undefined;
    let effort: ReasoningEffort | undefined = undefined;
    let permissionMode: CodexPermissionMode | undefined = undefined;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--resume' || arg === '-r') {
            if (resumeThreadId !== null) {
                throw new Error('Codex resume flag can only be provided once.');
            }

            const nextArg = args[i + 1];
            if (!nextArg || nextArg.startsWith('-')) {
                throw new Error('Codex resume requires a thread ID: happy codex --resume <thread-id>');
            }

            resumeThreadId = nextArg;
            i++;
            continue;
        }

        if (arg.startsWith('--resume=')) {
            if (resumeThreadId !== null) {
                throw new Error('Codex resume flag can only be provided once.');
            }

            const value = arg.slice('--resume='.length).trim();
            if (!value) {
                throw new Error('Codex resume requires a thread ID: happy codex --resume <thread-id>');
            }

            resumeThreadId = value;
            continue;
        }

        if (arg === '--model' || arg.startsWith('--model=')) {
            const parsed = readFlagValue(args, i, '--model', 'Codex model requires a value: happy codex --model <model>');
            model = parsed.value;
            i = parsed.nextIndex;
            continue;
        }

        if (arg === '--effort' || arg.startsWith('--effort=')) {
            const parsed = readFlagValue(args, i, '--effort', 'Codex effort requires a value: happy codex --effort <level>');
            effort = parseEffort(parsed.value);
            i = parsed.nextIndex;
            continue;
        }

        if (arg === '--permission-mode' || arg.startsWith('--permission-mode=')) {
            const parsed = readFlagValue(args, i, '--permission-mode', 'Codex permission mode requires a value: happy codex --permission-mode <mode>');
            permissionMode = setPermissionMode(permissionMode, parsePermissionMode(parsed.value));
            i = parsed.nextIndex;
            continue;
        }

        if (arg === '--yolo') {
            permissionMode = setPermissionMode(permissionMode, 'yolo');
            continue;
        }

        remainingArgs.push(arg);
    }

    return {
        resumeThreadId,
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(permissionMode !== undefined ? { permissionMode } : {}),
        args: remainingArgs,
    };
}

export const extractCodexResumeFlag = parseCodexStartupArgs;
