export type CapabilityKind = 'cli' | 'tool' | 'dep';

// Capability IDs are namespaced strings returned by the daemon.
// Keep this flexible so new capabilities (including new `cli.<agent>` ids) do not require UI code changes.
export type CapabilityId = `cli.${string}` | `tool.${string}` | `dep.${string}`;

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
  checklistId?: string;
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

