import type { MessageMeta } from '@/api/types';
import type { ReasoningEffort } from './codexAppServerTypes';

export type CodexPermissionMode = 'default' | 'read-only' | 'safe-yolo' | 'yolo';

export type CodexMode = {
    permissionMode: CodexPermissionMode;
    model?: string;
    effort?: ReasoningEffort;
};

export type CodexModeState = {
    currentPermissionMode?: CodexPermissionMode;
    currentModel?: string;
    effort?: ReasoningEffort;
    permissionSource: 'default' | 'startup' | 'remote';
    modelSource: 'default' | 'startup' | 'remote';
};

export function createCodexModeState(opts: {
    permissionMode?: CodexPermissionMode;
    model?: string;
    effort?: ReasoningEffort;
}): CodexModeState {
    return {
        currentPermissionMode: opts.permissionMode,
        currentModel: opts.model,
        effort: opts.effort,
        permissionSource: opts.permissionMode === undefined ? 'default' : 'startup',
        modelSource: opts.model === undefined ? 'default' : 'startup',
    };
}

const REMOTE_CODEX_PERMISSION_MODES: readonly CodexPermissionMode[] = [
    'default',
    'read-only',
    'safe-yolo',
    'yolo',
];

function isCodexPermissionMode(value: unknown): value is CodexPermissionMode {
    return REMOTE_CODEX_PERMISSION_MODES.includes(value as CodexPermissionMode);
}

export function resolveCodexMessageMode(
    state: CodexModeState,
    meta: Pick<MessageMeta, 'permissionMode' | 'model'> | undefined,
): { state: CodexModeState; mode: CodexMode; ignoredPermissionMode?: string } {
    const nextState: CodexModeState = { ...state };
    let ignoredPermissionMode: string | undefined;

    if (meta?.permissionMode) {
        if (isCodexPermissionMode(meta.permissionMode)) {
            const isRoutineDefault = meta.permissionMode === 'default';
            if (!isRoutineDefault || nextState.permissionSource === 'default') {
                nextState.currentPermissionMode = isRoutineDefault ? undefined : meta.permissionMode;
                nextState.permissionSource = isRoutineDefault ? 'default' : 'remote';
            }
        } else {
            ignoredPermissionMode = String(meta.permissionMode);
        }
    }

    if (meta && Object.prototype.hasOwnProperty.call(meta, 'model')) {
        const incomingModel = meta.model || undefined;
        if (incomingModel !== undefined || nextState.modelSource === 'default') {
            nextState.currentModel = incomingModel;
            nextState.modelSource = incomingModel === undefined ? 'default' : 'remote';
        }
    }

    return {
        state: nextState,
        mode: {
            permissionMode: nextState.currentPermissionMode ?? 'default',
            model: nextState.currentModel,
            effort: nextState.effort,
        },
        ...(ignoredPermissionMode !== undefined ? { ignoredPermissionMode } : {}),
    };
}
