import { describe, expect, it } from 'vitest';
import { encodeBase64 } from '@/api/encryption';
import type { Metadata } from '@/api/types';
import {
  hydrateRecoveredSessionFromPersisted,
  hydrateTrackedSessionFromPersisted,
  mergeTrackedSessionWebhook,
} from './persistedSessionHydration';
import type { PersistedSession } from '@/persistence';

const metadata = { path: '/work/repo', host: 'mac' } as unknown as Metadata;

function persisted(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    encryptionKey: encodeBase64(new Uint8Array([1, 2, 3, 4])),
    encryptionVariant: 'legacy',
    seq: 12,
    metadataVersion: 3,
    agentStateVersion: 4,
    metadata,
    savedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('hydrateTrackedSessionFromPersisted', () => {
  it('shouldReturnNothingWhenNoRecordExists', () => {
    expect(hydrateTrackedSessionFromPersisted(undefined)).toEqual({});
  });

  it('shouldRestoreEncryptionSoResumePreservationCanRun', () => {
    const hydrated = hydrateTrackedSessionFromPersisted(persisted());

    expect(hydrated.encryption).toEqual({
      encryptionKey: new Uint8Array([1, 2, 3, 4]),
      encryptionVariant: 'legacy',
      seq: 12,
      metadataVersion: 3,
      agentStateVersion: 4,
    });
  });

  it('shouldRestoreMetadataAndUserHomeDir', () => {
    const hydrated = hydrateTrackedSessionFromPersisted(persisted({ userHomeDir: '/tmp/happy-session-1' }));

    expect(hydrated.happySessionMetadataFromLocalWebhook).toBe(metadata);
    expect(hydrated.userHomeDir).toBe('/tmp/happy-session-1');
  });

  it('shouldRestoreTheResumeCursorWhenPresent', () => {
    expect(hydrateTrackedSessionFromPersisted(persisted({ lastProcessedSeq: 41 })).persistedLastProcessedSeq).toBe(41);
  });

  it('shouldRestoreDeferredContinuationContextAcrossDaemonRestarts', () => {
    expect(hydrateTrackedSessionFromPersisted(persisted({
      deferredContinuationContextFile: '/tmp/context-1.txt',
    })).deferredContinuationContextFile).toBe('/tmp/context-1.txt');
  });

  it('shouldRestoreTheSaycodeAgentCapabilityAcrossDaemonRestarts', () => {
    const agentEnvironment = {
      SAYCODE_AGENT_ENV: '1' as const,
      SAYCODE_AGENT_ROOT: 'root-session',
      SAYCODE_AGENT_DEPTH: '2',
      SAYCODE_AGENT_MAX_SPAWN: '4',
      SAYCODE_AGENT_ID: 'worker-1',
      HAPPY_PROJECT_SANDBOX_CONFIG: JSON.stringify({ enabled: true, extraWritePaths: ['/repo/.aplus/agent-lineage.jsonl'] }),
    };

    expect(hydrateTrackedSessionFromPersisted(persisted({ agentEnvironment })).agentEnvironment)
      .toEqual(agentEnvironment);
  });

  it('shouldRestoreAnImmutableSetupTokenBindingAcrossDaemonRestarts', () => {
    const binding = JSON.stringify({ version: 1, managedAccountId: '0b6f2c1e-1111-4a2b-8c3d-000000000001', credentialGeneration: 3, groupScope: 'company-1', companyId: 'company-1', userId: 'user-1', machineId: 'machine-1', keyId: 'a'.repeat(64), nonce: '6a1f7d3e-2222-4b2b-8c3d-000000000009', issuedAt: 1_800_000_000_000 });
    expect(hydrateTrackedSessionFromPersisted(persisted({ agentEnvironment: { HAPPY_AI_AUTH_SETUP_TOKEN_BINDING: binding } as never })).agentEnvironment)
      .toEqual({ HAPPY_AI_AUTH_SETUP_TOKEN_BINDING: binding });
  });

  it('shouldValidatePersistedAgentCapabilityBeforeAddingItToTheChildEnvironment', () => {
    const agentEnvironment = {
      SAYCODE_AGENT_ENV: '1',
      SAYCODE_AGENT_ROOT: 'root-session',
      NODE_OPTIONS: '--require /tmp/untrusted.cjs',
    } as unknown as NonNullable<PersistedSession['agentEnvironment']>;

    expect(hydrateTrackedSessionFromPersisted(persisted({ agentEnvironment })).agentEnvironment)
      .toEqual({
        SAYCODE_AGENT_ENV: '1',
        SAYCODE_AGENT_ROOT: 'root-session',
      });
  });

  // Callers spread this over a session that may already hold fresher values, so
  // an absent field must stay absent instead of overwriting one with undefined.
  it('shouldOmitKeysTheRecordDoesNotCarry', () => {
    const hydrated = hydrateTrackedSessionFromPersisted(persisted());

    expect('persistedLastProcessedSeq' in hydrated).toBe(false);
    expect('userHomeDir' in hydrated).toBe(false);
    expect('agentEnvironment' in hydrated).toBe(false);
    expect('deferredContinuationContextFile' in hydrated).toBe(false);
  });

  // A fabricated runtime would make the idle guard treat a restored session as
  // one that has reported since this daemon started; its stale-runtime
  // protection depends on runtime being absent until a real report arrives.
  it('shouldNotFabricateRuntimeState', () => {
    expect('runtime' in hydrateTrackedSessionFromPersisted(persisted({ lastProcessedSeq: 41 }))).toBe(false);
  });
});

describe('hydrateRecoveredSessionFromPersisted', () => {
  it('shouldValidateCapabilitiesOnTheExplicitSameSessionRecoveryPath', () => {
    const agentEnvironment = {
      SAYCODE_AGENT_ENV: '1',
      SAYCODE_AGENT_ROOT: 'root-session',
      NODE_OPTIONS: '--require /tmp/untrusted.cjs',
    } as unknown as NonNullable<PersistedSession['agentEnvironment']>;

    expect(hydrateRecoveredSessionFromPersisted(
      persisted({
        userHomeDir: '/tmp/happy-session-1',
        lastProcessedSeq: 12,
        agentEnvironment,
      }),
      41,
    )).toEqual({
      userHomeDir: '/tmp/happy-session-1',
      persistedLastProcessedSeq: 41,
      agentEnvironment: {
        SAYCODE_AGENT_ENV: '1',
        SAYCODE_AGENT_ROOT: 'root-session',
      },
    });
  });
});

describe('mergeTrackedSessionWebhook', () => {
  it('shouldPreserveRecoveredEncryptionWhenAnOlderWebhookOmitsIt', () => {
    const encryption = hydrateTrackedSessionFromPersisted(persisted()).encryption;
    const merged = mergeTrackedSessionWebhook({
      tracked: { startedBy: 'daemon', pid: 4242, encryption },
      sessionId: 'sess-recovered',
      metadata,
      persistedLastProcessedSeq: 41,
    });

    expect(merged.encryption).toBe(encryption);
    expect(merged).toMatchObject({
      happySessionId: 'sess-recovered',
      happySessionMetadataFromLocalWebhook: metadata,
      persistedLastProcessedSeq: 41,
    });
  });
});
