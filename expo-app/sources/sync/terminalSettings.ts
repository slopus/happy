import type { Settings } from './settings';

export type TerminalSpawnOptions = {
    mode: 'tmux';
    tmux: {
        sessionName: string;
        isolated: boolean;
        tmpDir: string | null;
    };
};

function normalizeTmuxSessionName(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    return value.trim();
}

function normalizeOptionalString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function resolveTerminalSpawnOptions(params: {
    settings: Settings;
    machineId: string | null;
}): TerminalSpawnOptions | null {
    const { settings, machineId } = params;

    const override = machineId ? settings.terminalTmuxByMachineId?.[machineId] : undefined;

    const useTmux = override ? override.useTmux : settings.terminalUseTmux;
    if (!useTmux) return null;

    // NOTE: empty string means "use current/most recent tmux session".
    const sessionName = (override ? normalizeTmuxSessionName(override.sessionName) : null)
        ?? normalizeTmuxSessionName(settings.terminalTmuxSessionName)
        ?? 'happy';

    const isolated = override ? override.isolated : settings.terminalTmuxIsolated;

    const tmpDir = (override ? normalizeOptionalString(override.tmpDir) : null)
        ?? normalizeOptionalString(settings.terminalTmuxTmpDir)
        ?? null;

    return {
        mode: 'tmux',
        tmux: {
            sessionName,
            isolated,
            tmpDir,
        },
    };
}
