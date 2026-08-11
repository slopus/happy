import type { TerminalStreamStatus } from '@/sync/terminalClient';

export type TerminalConnectionTone = 'success' | 'info' | 'warning' | 'danger';

export interface TerminalConnectionPresentation {
    label: string;
    tone: TerminalConnectionTone;
}

export interface TerminalNotice {
    key: 'epoch-reset' | 'control-reset' | 'truncated-output';
    message: string;
}

export type TerminalCollectionState =
    | 'offline'
    | 'loading'
    | 'disabled'
    | 'error'
    | 'empty'
    | 'ready';

export function getTerminalConnectionPresentation(
    status: TerminalStreamStatus,
    isWriter: boolean,
    errorMessage?: string | null,
): TerminalConnectionPresentation {
    switch (status) {
        case 'connecting':
            return { label: 'Connecting…', tone: 'warning' };
        case 'attached':
            return isWriter
                ? { label: 'You have control', tone: 'success' }
                : { label: 'View only', tone: 'info' };
        case 'reconnecting':
            return { label: 'Reconnecting…', tone: 'warning' };
        case 'exited':
            return { label: 'Session exited', tone: 'danger' };
        case 'error':
            return { label: errorMessage || 'Connection error', tone: 'danger' };
        case 'detached':
            return { label: 'Detached', tone: 'danger' };
    }
}

export function getTerminalNotices(options: {
    epochReset: boolean;
    controlReset: boolean;
    truncated: boolean;
}): TerminalNotice[] {
    const notices: TerminalNotice[] = [];
    if (options.epochReset) {
        notices.push({
            key: 'epoch-reset',
            message: 'Terminal restarted. Unsent keystrokes were discarded.',
        });
    }
    if (options.controlReset) {
        notices.push({
            key: 'control-reset',
            message: 'Connection recovered. Some pending keystrokes were discarded.',
        });
    }
    if (options.truncated) {
        notices.push({
            key: 'truncated-output',
            message: 'Older output was trimmed while you were away.',
        });
    }
    return notices;
}

export function getTerminalCollectionState(options: {
    online: boolean;
    loading: boolean;
    disabled: boolean;
    error: string | null;
    count: number;
}): TerminalCollectionState {
    if (!options.online) return 'offline';
    if (options.loading) return 'loading';
    if (options.disabled) return 'disabled';
    if (options.error) return 'error';
    if (options.count === 0) return 'empty';
    return 'ready';
}
