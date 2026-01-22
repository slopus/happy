import type {
    CapabilitiesDescribeResponse,
    CapabilitiesDetectRequest,
    CapabilitiesDetectResponse,
    CapabilitiesInvokeRequest,
    CapabilitiesInvokeResponse,
    CapabilityDescriptor,
    CapabilityDetectRequest,
    CapabilityDetectResult,
    CapabilityId,
    ChecklistId,
} from './types';
import { CapabilityError } from './errors';
import type { DetectCliSnapshot } from './snapshots/cliSnapshot';

export type CapabilitiesDetectContext = {
    cliSnapshot: DetectCliSnapshot | null;
};

export type CapabilitiesDetectContextBuilder = (requests: CapabilityDetectRequest[]) => Promise<CapabilitiesDetectContext>;

export type Capability = {
    descriptor: CapabilityDescriptor;
    detect: (args: { request: CapabilityDetectRequest; context: CapabilitiesDetectContext }) => Promise<unknown>;
    invoke?: (args: { method: string; params?: Record<string, unknown> }) => Promise<CapabilitiesInvokeResponse>;
};

export type CapabilitiesService = {
    describe: () => CapabilitiesDescribeResponse;
    detect: (data: CapabilitiesDetectRequest) => Promise<CapabilitiesDetectResponse>;
    invoke: (data: CapabilitiesInvokeRequest) => Promise<CapabilitiesInvokeResponse>;
};

function mergeOverrides(
    rawRequests: CapabilityDetectRequest[],
    overrides: CapabilitiesDetectRequest['overrides'] | undefined,
): CapabilityDetectRequest[] {
    const safeOverrides = overrides ?? {};
    return rawRequests.map((r) => {
        const overrideParams = safeOverrides[r.id]?.params;
        if (!overrideParams) return r;
        return { ...r, params: { ...(r.params ?? {}), ...overrideParams } };
    });
}

function selectRequestsFromChecklist(opts: {
    checklistId: ChecklistId | undefined;
    checklists: Record<ChecklistId, CapabilityDetectRequest[]>;
    requests: CapabilityDetectRequest[] | undefined;
}): CapabilityDetectRequest[] {
    if (opts.checklistId) return opts.checklists[opts.checklistId] ?? [];
    return Array.isArray(opts.requests) ? opts.requests : [];
}

export function createCapabilitiesService(opts: {
    capabilities: Capability[];
    checklists: Record<ChecklistId, CapabilityDetectRequest[]>;
    buildContext: CapabilitiesDetectContextBuilder;
}): CapabilitiesService {
    const capabilityMap = new Map<CapabilityId, Capability>();
    for (const cap of opts.capabilities) {
        capabilityMap.set(cap.descriptor.id, cap);
    }

    const describe = (): CapabilitiesDescribeResponse => ({
        protocolVersion: 1,
        capabilities: opts.capabilities.map((c) => c.descriptor),
        checklists: opts.checklists,
    });

    const detect = async (data: CapabilitiesDetectRequest): Promise<CapabilitiesDetectResponse> => {
        const selectedChecklistId = data?.checklistId;
        const rawRequests = selectRequestsFromChecklist({
            checklistId: selectedChecklistId,
            checklists: opts.checklists,
            requests: data?.requests,
        });

        const requests = mergeOverrides(rawRequests, data?.overrides);
        const checkedAt = Date.now();
        const context = await opts.buildContext(requests);

        const results: Partial<Record<CapabilityId, CapabilityDetectResult>> = {};
        for (const req of requests) {
            const cap = capabilityMap.get(req.id);
            if (!cap) {
                results[req.id] = { ok: false, checkedAt, error: { message: `Unknown capability: ${req.id}`, code: 'unknown-capability' } };
                continue;
            }

            try {
                const dataOut = await cap.detect({ request: req, context });
                results[req.id] = { ok: true, checkedAt, data: dataOut };
            } catch (e) {
                const message = e instanceof Error ? e.message : 'Detect failed';
                const code = e instanceof CapabilityError ? e.code : 'detect-failed';
                results[req.id] = { ok: false, checkedAt, error: { message, code } };
            }
        }

        return { protocolVersion: 1, results };
    };

    const invoke = async (data: CapabilitiesInvokeRequest): Promise<CapabilitiesInvokeResponse> => {
        const id = data?.id as CapabilityId | undefined;
        const method = typeof data?.method === 'string' ? data.method.trim() : '';
        if (!id || !method) {
            return { ok: false, error: { message: 'Invalid capabilities.invoke request', code: 'invalid-request' } };
        }

        const cap = capabilityMap.get(id);
        if (!cap || !cap.invoke) {
            return { ok: false, error: { message: `Unsupported capability: ${String(id)}`, code: 'unsupported-capability' } };
        }

        try {
            return await cap.invoke({ method, params: data?.params });
        } catch (e) {
            const message = e instanceof Error ? e.message : 'Invoke failed';
            const code = e instanceof CapabilityError ? e.code : 'invoke-failed';
            return { ok: false, error: { message, code } };
        }
    };

    return { describe, detect, invoke };
}
