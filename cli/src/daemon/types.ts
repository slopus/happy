/**
 * Types and interfaces for the Happy daemon functionality
 */

export interface MachineIdentity {
  machineId: string;
  machineHost: string;
  platform: string;
  happyCliVersion: string;
  happyHomeDirectory: string;
}

export interface MachineMetadata {
  host: string;
  platform: string;
  happyCliVersion: string;
  happyHomeDirectory: string;
}

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
    machineId: string;
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