import { describe, expect, it } from 'vitest';
import { encodeBase64, encrypt } from '@/api/encryption';
import type { Metadata } from '@/api/types';
import type { TrackedSession } from './types';
import { applyServerSessionSnapshot, parseServerSessionSnapshot } from './serverSessionSnapshot';

function makeMetadata(overrides: Partial<Metadata> = {}): Metadata {
  return {
    path: '/tmp/project',
    host: 'localhost',
    homeDir: '/home/user',
    happyHomeDir: '/home/user/.happy',
    happyLibDir: '/home/user/.happy/lib',
    happyToolsDir: '/home/user/.happy/tools',
    ...overrides,
  };
}

describe('server session snapshot', () => {
  it('parses metadata and seq from the server session list', () => {
    const encryptionKey = new Uint8Array(32);
    const encryptionVariant = 'legacy' as const;
    const metadata = makeMetadata({ claudeSessionId: 'claude-1' });

    const snapshot = parseServerSessionSnapshot(
      [
        {
          id: 'other-session',
          metadata: 'ignored',
          seq: 1,
        },
        {
          id: 'target-session',
          metadata: encodeBase64(encrypt(encryptionKey, encryptionVariant, metadata)),
          seq: 12,
          metadataVersion: 3,
          agentStateVersion: 4,
        },
      ],
      'target-session',
      { encryptionKey, encryptionVariant },
    );

    expect(snapshot).toEqual({
      metadata,
      seq: 12,
      metadataVersion: 3,
      agentStateVersion: 4,
    });
  });

  it('applies fresh server seq without moving stored values backward', () => {
    const tracked: Pick<TrackedSession, 'happySessionMetadataFromLocalWebhook' | 'encryption'> = {
      happySessionMetadataFromLocalWebhook: makeMetadata({ claudeSessionId: 'old-claude' }),
      encryption: {
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy',
        seq: 0,
        metadataVersion: 5,
        agentStateVersion: 2,
      },
    };
    const metadata = makeMetadata({ claudeSessionId: 'new-claude' });

    applyServerSessionSnapshot(tracked, {
      metadata,
      seq: 9,
      metadataVersion: 3,
      agentStateVersion: 7,
    });

    expect(tracked.happySessionMetadataFromLocalWebhook).toEqual(metadata);
    expect(tracked.encryption?.seq).toBe(9);
    expect(tracked.encryption?.metadataVersion).toBe(5);
    expect(tracked.encryption?.agentStateVersion).toBe(7);
  });
});
