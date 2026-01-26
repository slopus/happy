import type { Update } from '../types';

export interface ServerToDaemonEvents {
  update: (data: Update) => void;
  'rpc-request': (data: { method: string; params: string }, callback: (response: string) => void) => void;
  'rpc-registered': (data: { method: string }) => void;
  'rpc-unregistered': (data: { method: string }) => void;
  'rpc-error': (data: { type: string; error: string }) => void;
  auth: (data: { success: boolean; user: string }) => void;
  error: (data: { message: string }) => void;
}

export interface DaemonToServerEvents {
  'machine-alive': (data: { machineId: string; time: number }) => void;
  'session-end': (data: { sid: string; time: number; exit?: any }) => void;

  'machine-update-metadata': (
    data: { machineId: string; metadata: string; expectedVersion: number },
    cb: (
      answer:
        | { result: 'error' }
        | { result: 'version-mismatch'; version: number; metadata: string }
        | { result: 'success'; version: number; metadata: string }
    ) => void
  ) => void;

  'machine-update-state': (
    data: { machineId: string; daemonState: string; expectedVersion: number },
    cb: (
      answer:
        | { result: 'error' }
        | { result: 'version-mismatch'; version: number; daemonState: string }
        | { result: 'success'; version: number; daemonState: string }
    ) => void
  ) => void;

  'rpc-register': (data: { method: string }) => void;
  'rpc-unregister': (data: { method: string }) => void;
  'rpc-call': (
    data: { method: string; params: any },
    callback: (response: { ok: boolean; result?: any; error?: string }) => void
  ) => void;
}

