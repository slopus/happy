import type { EnhancedMode } from '@/claude/loop';
import type { PendingAttachment } from '@/utils/MessageQueue2';

export type InteractiveClaudeRuntimeState =
    | 'starting'
    | 'interactive'
    | 'degraded'
    | 'unsupported'
    | 'failed';

export type InteractiveClaudeTerminalBackend = 'tmux' | 'pty';

export type InteractiveClaudeTerminalCapability =
    | 'remote-control'
    | 'local-attach';

export type InteractiveClaudeTerminalEvent =
    | 'permission_prompt_visible'
    | 'input_prompt_visible'
    | 'usage_or_auth_error'
    | 'spinner_without_transcript'
    | 'terminal_process_error';

export interface InteractiveClaudeRuntimeMetadata {
    kind: 'interactive';
    state: InteractiveClaudeRuntimeState;
    backend?: InteractiveClaudeTerminalBackend;
    capabilities?: InteractiveClaudeTerminalCapability[];
    claudeSessionId?: string;
    terminalId?: string;
    message?: string;
    updatedAt: number;
}

export interface InteractiveClaudeBatch {
    message: string;
    mode: EnhancedMode;
    hash: string;
    isolate: boolean;
    attachments?: PendingAttachment[];
}

export type InteractiveClaudeUnsupportedReason =
    | 'attachments'
    | 'mode-change'
    | 'control-character'
    | 'empty-message';

export type InteractiveClaudeBatchValidation =
    | { ok: true }
    | { ok: false; reason: InteractiveClaudeUnsupportedReason; message: string };
