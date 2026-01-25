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
  /** Vendor resume id (e.g. Claude/Codex session id) supplied/derived at spawn time. */
  vendorResumeId?: string;
  pid: number;
  /**
   * Hash of the observed process command line for PID reuse safety.
   * If present, we require this to match before sending SIGTERM by PID.
   */
  processCommandHash?: string;
  childProcess?: ChildProcess;
  error?: string;
  directoryCreated?: boolean;
  message?: string;
  /** tmux session identifier (format: session:window) */
  tmuxSessionId?: string;
  /**
   * Sessions reattached from disk markers after daemon restart are potentially unsafe to kill by PID
   * (avoids PID reuse killing unrelated processes). We keep them kill-protected.
   */
  reattachedFromDiskMarker?: boolean;
}
