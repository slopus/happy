import { deriveServerRpcKey } from '@/api/encryption';
import type { ServerLaneConfig } from './types';

/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R3 — the machine-scope
 * methods the server's own key may call. Each one answers with status the
 * server routes or schedules by, or relays a body sealed to a key the server
 * does not hold. None reads or writes a file, runs a command, starts or
 * resumes an agent, moves a transcript, touches a credential, schedules work
 * or opens a terminal.
 *
 * An allowlist, not a denylist: a method added later stays with the customer's
 * key until it is reviewed and listed here.
 */
export const SERVER_LANE_METHODS: ReadonlySet<string> = new Set([
    'daemon-session-state',
    'browser-session-waiting',
    'stop-session',
    'byos-offline:confirm-session-host',
    'byos-offline:deliver',
    'difficulty-routing:classify',
    'machine-resource-metrics',
    'claude-code-usage:read',
    'ai-credential:status',
    'ai-credential:capabilities',
    'browser-viewer:status',
    'browser-viewer:lookup',
    'allocate-port',
    'get-port',
    'release-port',
]);

/**
 * The server lane of a machine's RPC scope. A legacy machine gets none: its
 * secret is the account secret, which the server already holds.
 */
export function machineServerLane(machine: {
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
}): ServerLaneConfig | undefined {
    if (machine.encryptionVariant !== 'dataKey') return undefined;
    return {
        encryptionKey: deriveServerRpcKey(machine.encryptionKey),
        allows: (method) => SERVER_LANE_METHODS.has(method),
    };
}
