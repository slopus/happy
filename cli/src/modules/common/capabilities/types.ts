export type CapabilityId =
    | 'cli.codex'
    | 'cli.claude'
    | 'cli.gemini'
    | 'tool.tmux'
    | 'dep.codex-mcp-resume';

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
    checklists: Record<ChecklistId, CapabilityDetectRequest[]>;
};

export type CapabilityDetectResult =
    | { ok: true; checkedAt: number; data: unknown }
    | { ok: false; checkedAt: number; error: { message: string; code?: string } };

export type CapabilitiesDetectRequest = {
    checklistId?: ChecklistId;
    requests?: CapabilityDetectRequest[];
    overrides?: Partial<Record<CapabilityId, { params?: Record<string, unknown> }>>;
};

export type CapabilitiesDetectResponse = {
    protocolVersion: 1;
    results: Partial<Record<CapabilityId, CapabilityDetectResult>>;
};

export type CapabilitiesInvokeRequest = {
    id: CapabilityId;
    method: string;
    params?: Record<string, unknown>;
};

export type CapabilitiesInvokeResponse =
    | { ok: true; result: unknown }
    | { ok: false; error: { message: string; code?: string }; logPath?: string };

