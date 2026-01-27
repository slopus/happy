/**
 * Capability probe operations (machine RPC)
 */

import { apiSocket } from '../apiSocket';
import { isPlainObject } from './_shared';
import { RPC_METHODS, isRpcMethodNotFoundResult } from '@happy/protocol/rpc';
import {
    parseCapabilitiesDescribeResponse,
    parseCapabilitiesDetectResponse,
    parseCapabilitiesInvokeResponse,
    type CapabilitiesDescribeResponse,
    type CapabilitiesDetectRequest,
    type CapabilitiesDetectResponse,
    type CapabilitiesInvokeRequest,
    type CapabilitiesInvokeResponse,
} from '../capabilitiesProtocol';

export type {
    CapabilitiesDescribeResponse,
    CapabilitiesDetectRequest,
    CapabilitiesDetectResponse,
    CapabilitiesInvokeRequest,
    CapabilitiesInvokeResponse,
} from '../capabilitiesProtocol';

export type MachineCapabilitiesDescribeResult =
    | { supported: true; response: CapabilitiesDescribeResponse }
    | { supported: false; reason: 'not-supported' | 'error' };

export async function machineCapabilitiesDescribe(machineId: string): Promise<MachineCapabilitiesDescribeResult> {
    try {
        const result = await apiSocket.machineRPC<unknown, {}>(machineId, RPC_METHODS.CAPABILITIES_DESCRIBE, {});
        if (isRpcMethodNotFoundResult(result)) return { supported: false, reason: 'not-supported' };
        if (isPlainObject(result) && typeof result.error === 'string') return { supported: false, reason: 'error' };
        const parsed = parseCapabilitiesDescribeResponse(result);
        if (!parsed) return { supported: false, reason: 'error' };
        return { supported: true, response: parsed };
    } catch {
        return { supported: false, reason: 'error' };
    }
}

export type MachineCapabilitiesDetectResult =
    | { supported: true; response: CapabilitiesDetectResponse }
    | { supported: false; reason: 'not-supported' | 'error' };

export async function machineCapabilitiesDetect(
    machineId: string,
    request: CapabilitiesDetectRequest,
    options?: { timeoutMs?: number },
): Promise<MachineCapabilitiesDetectResult> {
    try {
        const timeoutMs = typeof options?.timeoutMs === 'number' ? options.timeoutMs : 2500;
        const result = await Promise.race([
            apiSocket.machineRPC<unknown, CapabilitiesDetectRequest>(machineId, RPC_METHODS.CAPABILITIES_DETECT, request),
            new Promise<{ error: string }>((resolve) => {
                setTimeout(() => resolve({ error: 'Timeout' }), timeoutMs);
            }),
        ]);

        if (isRpcMethodNotFoundResult(result)) return { supported: false, reason: 'not-supported' };
        if (isPlainObject(result) && typeof result.error === 'string') return { supported: false, reason: 'error' };

        const parsed = parseCapabilitiesDetectResponse(result);
        if (!parsed) return { supported: false, reason: 'error' };
        return { supported: true, response: parsed };
    } catch {
        return { supported: false, reason: 'error' };
    }
}

export type MachineCapabilitiesInvokeResult =
    | { supported: true; response: CapabilitiesInvokeResponse }
    | { supported: false; reason: 'not-supported' | 'error' };

export async function machineCapabilitiesInvoke(
    machineId: string,
    request: CapabilitiesInvokeRequest,
    options?: { timeoutMs?: number },
): Promise<MachineCapabilitiesInvokeResult> {
    try {
        const timeoutMs = typeof options?.timeoutMs === 'number' ? options.timeoutMs : 30_000;
        const result = await Promise.race([
            apiSocket.machineRPC<unknown, CapabilitiesInvokeRequest>(machineId, RPC_METHODS.CAPABILITIES_INVOKE, request),
            new Promise<{ error: string }>((resolve) => {
                setTimeout(() => resolve({ error: 'Timeout' }), timeoutMs);
            }),
        ]);

        if (isRpcMethodNotFoundResult(result)) return { supported: false, reason: 'not-supported' };
        if (isPlainObject(result) && typeof result.error === 'string') return { supported: false, reason: 'error' };

        const parsed = parseCapabilitiesInvokeResponse(result);
        if (!parsed) return { supported: false, reason: 'error' };
        return { supported: true, response: parsed };
    } catch {
        return { supported: false, reason: 'error' };
    }
}

/**
 * Stop the daemon on a specific machine
 */
