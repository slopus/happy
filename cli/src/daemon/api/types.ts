/**
 * Daemon-specific types (not related to API/server communication)
 */

import { Metadata } from '@/api/types';
import { ChildProcess } from 'child_process';

/**
 * Daemon state stored to file (different from DaemonState in api/types.ts)
 */
export interface DaemonFileState {
  pid: number;
  httpPort: number;
  startTime: string;
  startedWithCliVersion: string;
}

/**
 * Session tracking for daemon
 */
export interface TrackedSession {
  startedBy: 'daemon' | string;
  happySessionId?: string;
  happySessionMetadataFromLocalWebhook?: Metadata;
  pid: number;
  childProcess?: ChildProcess;
}