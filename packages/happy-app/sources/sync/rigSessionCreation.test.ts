import { describe, expect, it } from 'vitest';

import type { Machine, MachineMetadata } from './storageTypes';
import {
    buildRigSpawnConfiguration,
    findConnectedRigMachine,
    getRigMachineSessionCreation,
    isRigMachine,
    resolveRigPendingRetryDelayMs,
} from './rigSessionCreation';

const rigMachine = {
    host: 'rig-host',
    platform: 'darwin',
    happyCliVersion: '0.0.30',
    happyHomeDir: '/Users/rig/.happy/rig',
    homeDir: '/Users/rig',
    machineKind: 'rig',
    rigOnly: true,
    cliAvailability: {
        claude: false,
        codex: false,
        gemini: false,
        openclaw: false,
        agy: false,
        rig: true,
        detectedAt: 1,
    },
    capabilities: { newSession: true, resume: false, worktrees: false },
    defaults: {
        providerId: 'codex',
        modelId: 'shared-model',
        permissionMode: 'auto',
        effort: 'high',
    },
    models: [
        {
            providerId: 'codex',
            id: 'shared-model',
            name: 'GPT Shared',
            providerName: 'OpenAI Codex',
            thinkingLevels: ['low', 'medium', 'high'],
            defaultThinkingLevel: 'high',
        },
        {
            providerId: 'claude',
            id: 'shared-model',
            name: 'Claude Shared',
            providerName: 'Anthropic Claude',
            thinkingLevels: ['low', 'max'],
            defaultThinkingLevel: 'max',
        },
    ],
    operatingModes: [
        { code: 'auto', value: 'Auto', description: 'Safe default', kind: 'safe-yolo' },
        { code: 'read_only', value: 'Read only', description: 'No writes', kind: 'read-only' },
    ],
} as unknown as MachineMetadata;

describe('Rig machine session creation', () => {
    it('recognizes only Rig-published machines', () => {
        expect(isRigMachine(rigMachine)).toBe(true);
        expect(isRigMachine({
            host: 'future-rig-host',
            platform: 'darwin',
            happyCliVersion: '1.0.0',
            happyHomeDir: '/Users/me/.happy',
            homeDir: '/Users/me',
            client: { id: 'rig', name: 'Rig', version: '1.0.0' },
        })).toBe(true);
        expect(isRigMachine({
            host: 'cli-host',
            platform: 'darwin',
            happyCliVersion: '1.0.0',
            happyHomeDir: '/Users/me/.happy',
            homeDir: '/Users/me',
        })).toBe(false);
    });

    it('returns provider-qualified dynamic options and model-specific defaults', () => {
        const creation = getRigMachineSessionCreation(rigMachine);

        expect(creation).toMatchObject({
            defaultModelKey: 'codex:shared-model',
            defaultPermissionMode: 'auto',
            supportsWorktrees: false,
            models: [
                { key: 'codex:shared-model', description: 'OpenAI Codex' },
                { key: 'claude:shared-model', description: 'Anthropic Claude' },
            ],
            permissionModes: [
                { key: 'auto', semanticKind: 'safe-yolo' },
                { key: 'read_only', semanticKind: 'read-only' },
            ],
        });
        expect(creation?.effortsForModel('claude:shared-model')).toEqual(['low', 'max']);
        expect(creation?.defaultEffortForModel('claude:shared-model')).toBe('max');
    });

    it('finds an online Rig machine for automatic composer selection', () => {
        const machine = (id: string, active: boolean, metadata: MachineMetadata): Machine => ({
            id,
            active,
            metadata,
        } as Machine);
        const regularMetadata = {
            host: 'happy-host',
            platform: 'darwin',
            happyCliVersion: '1.0.0',
            happyHomeDir: '/Users/happy/.happy',
            homeDir: '/Users/happy',
        } satisfies MachineMetadata;

        expect(findConnectedRigMachine([
            machine('regular', true, regularMetadata),
            machine('offline-rig', false, rigMachine),
            machine('online-rig', true, rigMachine),
        ])?.id).toBe('online-rig');
        expect(findConnectedRigMachine([
            machine('regular', true, regularMetadata),
            machine('offline-rig', false, rigMachine),
        ])).toBeNull();
    });

    it("builds Rig's exact provider-qualified spawn payload", () => {
        expect(buildRigSpawnConfiguration(rigMachine, {
            directory: '/Users/rig/project',
            clientRequestId: 'mobile-request-1',
            approvedNewDirectoryCreation: true,
            modelKey: 'claude:shared-model',
            permissionMode: 'read_only',
            effort: 'max',
        })).toEqual({
            type: 'spawn-in-directory',
            agent: 'rig',
            directory: '/Users/rig/project',
            clientRequestId: 'mobile-request-1',
            approvedNewDirectoryCreation: true,
            providerId: 'claude',
            modelId: 'shared-model',
            permissionMode: 'read_only',
            effort: 'max',
        });
    });

    it('rejects a model/effort combination absent from the published catalog', () => {
        expect(() => buildRigSpawnConfiguration(rigMachine, {
            directory: '/Users/rig/project',
            clientRequestId: 'mobile-request-2',
            modelKey: 'claude:shared-model',
            effort: 'high',
        })).toThrow('reasoning level is unavailable');
    });

    it('has an empty catalog when the machine publishes no operating modes', () => {
        const creation = getRigMachineSessionCreation({
            ...rigMachine,
            operatingModes: undefined,
        } as unknown as MachineMetadata);

        expect(creation?.permissionModes).toEqual([]);
        expect(creation?.defaultPermissionMode).toBeNull();
        expect(creation?.pendingRetryAfterMs).toBeNull();
    });

    it('reads the retry backoff the machine publishes', () => {
        const creation = getRigMachineSessionCreation({
            ...rigMachine,
            sessionCreation: {
                idempotencyKey: 'clientRequestId',
                pendingRetryAfterMs: 2_000,
                resultKinds: ['success', 'pending'],
            },
        } as unknown as MachineMetadata);

        expect(creation?.pendingRetryAfterMs).toBe(2_000);
    });

    it('never turns a missing pending retry delay into an instant retry', () => {
        // `retryAfterMs` comes from an unvalidated RPC payload: a Rig that omits
        // it used to produce Math.max(250, undefined) === NaN, and delay(NaN)
        // resolves immediately.
        expect(resolveRigPendingRetryDelayMs(undefined, null)).toBe(1_000);
        expect(resolveRigPendingRetryDelayMs(Number.NaN, null)).toBe(1_000);
        expect(resolveRigPendingRetryDelayMs('soon', null)).toBe(1_000);
        expect(resolveRigPendingRetryDelayMs(undefined, 2_000)).toBe(2_000);
    });

    it('clamps the pending retry delay to a sane window', () => {
        expect(resolveRigPendingRetryDelayMs(0, null)).toBe(250);
        expect(resolveRigPendingRetryDelayMs(-5_000, null)).toBe(250);
        expect(resolveRigPendingRetryDelayMs(60_000, null)).toBe(10_000);
        expect(resolveRigPendingRetryDelayMs(3_000, 250)).toBe(3_000);
    });
});
