/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R3 — what the server's
 * own key may call on a machine. Nothing on the server lane reads files, runs a
 * command, starts or resumes an agent, moves transcripts, touches credentials,
 * schedules work or opens a terminal.
 */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { deriveServerRpcKey } from '@/api/encryption';
import { machineServerLane, SERVER_LANE_METHODS } from './serverLane';

const CONTENT_CAPABLE = [
    'bash', 'readFile', 'readFileChunk', 'writeFile', 'deleteFile', 'renameFile', 'copyFile', 'ensureDirectory',
    'listDirectory', 'getDirectoryTree', 'listWorkspaceDirectory', 'readWorkspaceFile', 'ripgrep', 'difftastic',
    'file-discovery', 'worktree-dependencies:reclaim',
    'spawn-happy-session', 'resume-happy-session', 'recover-happy-session', 'stop-daemon',
    'claude-session-transfer', 'codex-thread-transfer', 'claude-fork-session', 'claude-list-rewind-points',
    'claude-duplicate-session', 'codex-fork-thread', 'codex-list-rewind-points', 'codex-duplicate-thread',
    'ai-credential:group-sync', 'ai-credential:export', 'ai-credential:apply', 'ai-credential:purge', 'ai-credential:rotation', 'ai-credential:verify',
    'start-server', 'stop-server', 'automation-upsert', 'automation-remove', 'automation-list',
    'checkpoint:execute', 'checkpoint:restart', 'browser-setup:install-chrome', 'browser-setup:launch',
    'browser-viewer:install', 'browser-viewer:start', 'gui-display:ensure', 'lesson-host-v1', 'channel-host:call',
    'autonomous-quality-gate:start', 'read-opencode-models',
];

describe('machineServerLane', () => {
    it('gives a legacy machine no server lane, since the server already holds its secret', () => {
        expect(machineServerLane({ encryptionKey: new Uint8Array(randomBytes(32)), encryptionVariant: 'legacy' })).toBeUndefined();
    });

    it('keys a dataKey machine server lane with the key derived from its machine key', () => {
        const machineKey = new Uint8Array(randomBytes(32));
        const lane = machineServerLane({ encryptionKey: machineKey, encryptionVariant: 'dataKey' });
        expect(lane?.encryptionKey).toEqual(deriveServerRpcKey(machineKey));
    });

    it('admits only the server lane methods', () => {
        const lane = machineServerLane({ encryptionKey: new Uint8Array(randomBytes(32)), encryptionVariant: 'dataKey' })!;
        for (const method of SERVER_LANE_METHODS) expect(lane.allows(method), method).toBe(true);
        for (const method of CONTENT_CAPABLE) expect(lane.allows(method), method).toBe(false);
    });

    it('lists no content-capable method', () => {
        for (const method of CONTENT_CAPABLE) expect(SERVER_LANE_METHODS.has(method), method).toBe(false);
    });
});
