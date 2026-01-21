export type DetectCliName = 'claude' | 'codex' | 'gemini';

export interface DetectCliEntry {
    available: boolean;
    resolvedPath?: string;
    version?: string;
    isLoggedIn?: boolean | null;
}

export interface DetectTmuxEntry {
    available: boolean;
    resolvedPath?: string;
    version?: string;
}

export interface DetectCliResponse {
    path: string | null;
    clis: Record<DetectCliName, DetectCliEntry>;
    tmux?: DetectTmuxEntry;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseCliEntry(raw: unknown): DetectCliEntry | null {
    if (!isPlainObject(raw) || typeof raw.available !== 'boolean') return null;
    const resolvedPath = raw.resolvedPath;
    const version = raw.version;
    const isLoggedInRaw = (raw as any).isLoggedIn;
    return {
        available: raw.available,
        ...(typeof resolvedPath === 'string' ? { resolvedPath } : {}),
        ...(typeof version === 'string' ? { version } : {}),
        ...((typeof isLoggedInRaw === 'boolean' || isLoggedInRaw === null) ? { isLoggedIn: isLoggedInRaw } : {}),
    };
}

function parseTmuxEntry(raw: unknown): DetectTmuxEntry | null {
    if (!isPlainObject(raw) || typeof raw.available !== 'boolean') return null;
    const resolvedPath = raw.resolvedPath;
    const version = raw.version;
    return {
        available: raw.available,
        ...(typeof resolvedPath === 'string' ? { resolvedPath } : {}),
        ...(typeof version === 'string' ? { version } : {}),
    };
}

export function parseDetectCliRpcResponse(result: unknown): DetectCliResponse | null {
    if (!isPlainObject(result)) return null;

    const clisRaw = result.clis;
    if (!isPlainObject(clisRaw)) return null;

    const claude = parseCliEntry((clisRaw as Record<string, unknown>).claude);
    const codex = parseCliEntry((clisRaw as Record<string, unknown>).codex);
    const gemini = parseCliEntry((clisRaw as Record<string, unknown>).gemini);
    if (!claude || !codex || !gemini) return null;

    const tmux = parseTmuxEntry((result as Record<string, unknown>).tmux);

    const pathValue = (result as Record<string, unknown>).path;
    return {
        path: typeof pathValue === 'string' ? pathValue : null,
        clis: { claude, codex, gemini },
        ...(tmux ? { tmux } : {}),
    };
}

