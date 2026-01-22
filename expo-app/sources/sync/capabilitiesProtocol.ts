export type CapabilityId = 'cli.codex' | 'cli.claude' | 'cli.gemini' | 'tool.tmux' | 'dep.codex-mcp-resume';

export type CapabilityKind = 'cli' | 'tool' | 'dep';

export type ChecklistId = 'new-session' | 'machine-details' | 'resume.codex';

export type CapabilityDetectRequest = {
    id: CapabilityId;
    params?: Record<string, unknown>;
};

export type CapabilityDescriptor = {
    id: CapabilityId;
    kind: CapabilityKind;
    title?: string;
    methods?: Record<string, { title?: string }>;
};

export type CapabilitiesDescribeResponse = {
    protocolVersion: 1;
    capabilities: CapabilityDescriptor[];
    checklists: Record<string, CapabilityDetectRequest[]>;
};

export type CapabilityDetectResult =
    | { ok: true; checkedAt: number; data: unknown }
    | { ok: false; checkedAt: number; error: { message: string; code?: string } };

export type CapabilitiesDetectResponse = {
    protocolVersion: 1;
    results: Partial<Record<CapabilityId, CapabilityDetectResult>>;
};

export type CapabilitiesDetectRequest = {
    checklistId?: ChecklistId | string;
    requests?: CapabilityDetectRequest[];
    overrides?: Partial<Record<CapabilityId, { params?: Record<string, unknown> }>>;
};

export type CapabilitiesInvokeRequest = {
    id: CapabilityId;
    method: string;
    params?: Record<string, unknown>;
};

export type CapabilitiesInvokeResponse =
    | { ok: true; result: unknown }
    | { ok: false; error: { message: string; code?: string }; logPath?: string };

export type CliCapabilityData = {
    available: boolean;
    resolvedPath?: string;
    version?: string;
    isLoggedIn?: boolean | null;
};

export type TmuxCapabilityData = {
    available: boolean;
    resolvedPath?: string;
    version?: string;
};

export type CodexMcpResumeDepData = {
    installed: boolean;
    installDir: string;
    binPath: string | null;
    installedVersion: string | null;
    distTag: string;
    lastInstallLogPath: string | null;
    registry?: { ok: true; latestVersion: string | null } | { ok: false; errorMessage: string };
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseCapabilityId(raw: unknown): CapabilityId | null {
    if (raw === 'cli.codex' || raw === 'cli.claude' || raw === 'cli.gemini' || raw === 'tool.tmux' || raw === 'dep.codex-mcp-resume') {
        return raw;
    }
    return null;
}

function parseDescriptor(raw: unknown): CapabilityDescriptor | null {
    if (!isPlainObject(raw)) return null;
    const id = parseCapabilityId(raw.id);
    const kind = raw.kind;
    if (!id) return null;
    if (!(kind === 'cli' || kind === 'tool' || kind === 'dep')) return null;

    const out: CapabilityDescriptor = { id, kind };
    if (typeof raw.title === 'string') out.title = raw.title;
    if (isPlainObject(raw.methods)) {
        const methods: Record<string, { title?: string }> = {};
        for (const [k, v] of Object.entries(raw.methods)) {
            if (!isPlainObject(v)) continue;
            methods[k] = typeof v.title === 'string' ? { title: v.title } : {};
        }
        out.methods = methods;
    }
    return out;
}

function parseDetectRequest(raw: unknown): CapabilityDetectRequest | null {
    if (!isPlainObject(raw)) return null;
    const id = parseCapabilityId(raw.id);
    if (!id) return null;
    const params = raw.params;
    return {
        id,
        ...(isPlainObject(params) ? { params } : {}),
    };
}

function parseDetectResult(raw: unknown): CapabilityDetectResult | null {
    if (!isPlainObject(raw)) return null;
    const ok = raw.ok;
    const checkedAt = raw.checkedAt;
    if (typeof ok !== 'boolean') return null;
    if (typeof checkedAt !== 'number') return null;
    if (ok) {
        return { ok: true, checkedAt, data: (raw as any).data };
    }
    const error = (raw as any).error;
    if (!isPlainObject(error) || typeof error.message !== 'string') return null;
    const code = (error as any).code;
    return { ok: false, checkedAt, error: { message: error.message, ...(typeof code === 'string' ? { code } : {}) } };
}

export function parseCapabilitiesDescribeResponse(raw: unknown): CapabilitiesDescribeResponse | null {
    if (!isPlainObject(raw)) return null;
    if (raw.protocolVersion !== 1) return null;

    const capabilitiesRaw = raw.capabilities;
    const checklistsRaw = raw.checklists;
    if (!Array.isArray(capabilitiesRaw)) return null;
    if (!isPlainObject(checklistsRaw)) return null;

    const capabilities: CapabilityDescriptor[] = [];
    for (const c of capabilitiesRaw) {
        const parsed = parseDescriptor(c);
        if (parsed) capabilities.push(parsed);
    }

    const checklists: Record<string, CapabilityDetectRequest[]> = {};
    for (const [k, v] of Object.entries(checklistsRaw)) {
        if (!Array.isArray(v)) continue;
        const list: CapabilityDetectRequest[] = [];
        for (const entry of v) {
            const parsed = parseDetectRequest(entry);
            if (parsed) list.push(parsed);
        }
        checklists[k] = list;
    }

    return {
        protocolVersion: 1,
        capabilities,
        checklists,
    };
}

export function parseCapabilitiesDetectResponse(raw: unknown): CapabilitiesDetectResponse | null {
    if (!isPlainObject(raw)) return null;
    if (raw.protocolVersion !== 1) return null;
    const resultsRaw = raw.results;
    if (!isPlainObject(resultsRaw)) return null;

    const results: Partial<Record<CapabilityId, CapabilityDetectResult>> = {};
    for (const [k, v] of Object.entries(resultsRaw)) {
        const id = parseCapabilityId(k);
        if (!id) continue;
        const parsed = parseDetectResult(v);
        if (parsed) results[id] = parsed;
    }

    return { protocolVersion: 1, results };
}

export function parseCapabilitiesInvokeResponse(raw: unknown): CapabilitiesInvokeResponse | null {
    if (!isPlainObject(raw)) return null;
    const ok = raw.ok;
    if (typeof ok !== 'boolean') return null;
    if (ok) {
        return { ok: true, result: (raw as any).result };
    }
    const error = (raw as any).error;
    if (!isPlainObject(error) || typeof error.message !== 'string') return null;
    const code = (error as any).code;
    const logPath = (raw as any).logPath;
    return {
        ok: false,
        error: { message: error.message, ...(typeof code === 'string' ? { code } : {}) },
        ...((typeof logPath === 'string') ? { logPath } : {}),
    };
}

