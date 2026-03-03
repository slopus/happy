/**
 * Daemon-specific types (not related to API/server communication)
 */

import { Metadata } from '@/api/types';
import { ChildProcess } from 'child_process';

/**
 * Session tracking for daemon
 */
export interface TrackedSession {
  startedBy: 'daemon' | string;
  happySessionId?: string;
  happySessionMetadataFromLocalWebhook?: Metadata;
  pid: number;
  childProcess?: ChildProcess;
  error?: string;
  directoryCreated?: boolean;
  message?: string;
  /** tmux session identifier (format: session:window) */
  tmuxSessionId?: string;
  /** Directory the session was spawned in (for recovery) */
  directory?: string;
  /** Claude Code session ID for --resume (for recovery) */
  claudeResumeSessionId?: string;
}

export interface SessionRecoveryEntry {
  claudeSessionId: string;
  path: string;
  machineId: string;
}