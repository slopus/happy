/**
 * Types and interfaces for the Happy daemon functionality
 */

import { ChildProcess } from 'child_process';
import { Metadata } from '@/api/types';

export interface MachineIdentity {
  // This ID is used as the actual database ID on the server
  // All machine operations use this ID
  machineId: string;
  machineHost: string;
  platform: string;
  happyCliVersion: string;
  happyHomeDirectory: string;
}

export interface MachineServerMetadata {
  host: string;
  platform: string;
  happyCliVersion: string;
  happyHomeDirectory: string;
}

export interface DaemonState {
  pid: number;
  httpPort: number;
  startTime: string;
  startedWithCliVersion: string;
}

export type TrackedSession = {
  startedBy: 'daemon';
  happySessionId?: string;  // Will be set when session reports
  happySessionMetadataFromLocalWebhook?: Metadata;
  pid: number;
  childProcess: ChildProcess;
} | {
  startedBy: 'happy directly - likely by user from terminal';
  happySessionId: string;
  happySessionMetadataFromLocalWebhook: Metadata;
  pid: number;
};

export interface EncryptedNewSessionRequest {
  requestId: string;
  directory: string;
  startingMode: 'local' | 'remote';
}

export interface DaemonToServerEvents {
  'machine-connect': (data: { 
    token: string; 
    machineIdentity: string; // encrypted MachineIdentity
  }) => void;
  'machine-alive': (data: {
    machineId: string; // Server expects this field name
    time: number;
  }) => void;
  'session-spawn-result': (data: {
    requestId: string;
    result: string; // encrypted result
  }) => void;
  'rpc-register': (data: { method: string }) => void;
  'rpc-unregister': (data: { method: string }) => void;
  'rpc-call': (data: { method: string, params: any }, callback: (response: {
    ok: boolean
    result?: any
    error?: string
  }) => void) => void;
  'update-machine': (data: { metadata: string }) => void;
}

export interface ServerToDaemonEvents {
  'spawn-session': (
    data: string, // encrypted EncryptedNewSessionRequest
    callback: (response: string) => void // encrypted response
  ) => void;
  'daemon-command': (data: {
    command: 'shutdown' | 'status';
  }) => void;
  'rpc-request': (data: { method: string, params: any }, callback: (response: any) => void) => void;
  'rpc-registered': (data: { method: string }) => void;
  'rpc-unregistered': (data: { method: string }) => void;
  'rpc-error': (data: { type: string, error: string }) => void;
  'ephemeral': (data: any) => void;
  'auth': (data: { success: boolean, user: string }) => void;
}