import type { Update } from '../types';
import { SOCKET_RPC_EVENTS } from '@happy/protocol/socketRpc';

export interface ServerToDaemonEvents {
  update: (data: Update) => void;
  [SOCKET_RPC_EVENTS.REQUEST]: (data: { method: string; params: string }, callback: (response: string) => void) => void;
  [SOCKET_RPC_EVENTS.REGISTERED]: (data: { method: string }) => void;
  [SOCKET_RPC_EVENTS.UNREGISTERED]: (data: { method: string }) => void;
  [SOCKET_RPC_EVENTS.ERROR]: (data: { type: string; error: string }) => void;
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

  [SOCKET_RPC_EVENTS.REGISTER]: (data: { method: string }) => void;
  [SOCKET_RPC_EVENTS.UNREGISTER]: (data: { method: string }) => void;
  [SOCKET_RPC_EVENTS.CALL]: (
    data: { method: string; params: any },
    callback: (response: { ok: boolean; result?: any; error?: string }) => void
  ) => void;
}
