import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';

import {
  EXTERNALLY_STARTED_SESSION_LABEL,
  onHappySessionWebhook,
  stopTrackedSession,
} from '../sessionTracking';
import type { TrackedSession } from '../types';

function createMetadata(overrides: Partial<Metadata> = {}): Metadata {
  return {
    path: '/workspace/project',
    host: 'test-host',
    homeDir: '/Users/test',
    happyHomeDir: '/Users/test/.happy',
    happyLibDir: '/Users/test/.happy/lib',
    happyToolsDir: '/Users/test/.happy/tools',
    startedBy: 'terminal',
    hostPid: 4242,
    ...overrides,
  };
}

describe('daemon session tracking', () => {
  it('replaces externally-started sessions when the same pid reports a different session id', () => {
    const pidToTrackedSession = new Map<number, TrackedSession>();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    const firstMetadata = createMetadata({ machineId: 'machine-a' });
    const secondMetadata = createMetadata({ machineId: 'machine-b', name: 'switched-session' });

    onHappySessionWebhook(pidToTrackedSession, pidToAwaiter, 'session-1', firstMetadata);
    onHappySessionWebhook(pidToTrackedSession, pidToAwaiter, 'session-2', secondMetadata);

    expect(pidToTrackedSession.size).toBe(1);
    expect(pidToTrackedSession.get(4242)).toEqual({
      startedBy: EXTERNALLY_STARTED_SESSION_LABEL,
      happySessionId: 'session-2',
      happySessionMetadataFromLocalWebhook: secondMetadata,
      pid: 4242,
    });
  });

  it('stops the replacement session using the new session id after a same-pid switch', () => {
    const pidToTrackedSession = new Map<number, TrackedSession>();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
    const killExternalProcess = vi.fn();

    onHappySessionWebhook(pidToTrackedSession, pidToAwaiter, 'session-1', createMetadata());
    onHappySessionWebhook(pidToTrackedSession, pidToAwaiter, 'session-2', createMetadata({ machineId: 'machine-b' }));

    expect(stopTrackedSession(pidToTrackedSession, 'session-1', killExternalProcess)).toBe(false);
    expect(stopTrackedSession(pidToTrackedSession, 'session-2', killExternalProcess)).toBe(true);
    expect(killExternalProcess).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(pidToTrackedSession.size).toBe(0);
  });

  it('still updates daemon-spawned sessions and resolves pending awaiters', () => {
    const childProcess = {
      kill: vi.fn(),
    } as unknown as NonNullable<TrackedSession['childProcess']>;

    const trackedSession: TrackedSession = {
      startedBy: 'daemon',
      pid: 5150,
      childProcess,
    };

    const pidToTrackedSession = new Map<number, TrackedSession>([[5150, trackedSession]]);
    const awaiter = vi.fn();
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>([[5150, awaiter]]);
    const metadata = createMetadata({ hostPid: 5150, machineId: 'daemon-machine' });

    onHappySessionWebhook(pidToTrackedSession, pidToAwaiter, 'daemon-session-1', metadata);

    expect(trackedSession.happySessionId).toBe('daemon-session-1');
    expect(trackedSession.happySessionMetadataFromLocalWebhook).toEqual(metadata);
    expect(awaiter).toHaveBeenCalledWith(trackedSession);
    expect(pidToAwaiter.has(5150)).toBe(false);
  });
});
