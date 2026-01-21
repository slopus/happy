import type { Metadata } from '@/sync/storageTypes';

export function getAttachCommandForSession(params: {
    sessionId: string;
    terminal: Metadata['terminal'] | null | undefined;
}): string | null {
    const { sessionId, terminal } = params;
    if (!terminal) return null;
    if (terminal.mode !== 'tmux') return null;
    if (!terminal.tmux?.target) return null;
    return `happy attach ${sessionId}`;
}

export function getTmuxTargetForSession(terminal: Metadata['terminal'] | null | undefined): string | null {
    if (!terminal) return null;
    if (terminal.mode !== 'tmux') return null;
    return terminal.tmux?.target ?? null;
}

export function getTmuxFallbackReason(terminal: Metadata['terminal'] | null | undefined): string | null {
    if (!terminal) return null;
    if (terminal.mode !== 'plain') return null;
    if (terminal.requested !== 'tmux') return null;
    return terminal.fallbackReason ?? null;
}

