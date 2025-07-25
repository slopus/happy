/**
 * Types and interfaces for the Happy daemon functionality
 */

export interface MachineIdentity {
  machineId: string;
  machineHost: string;
  platform: string;
  version: string;
}

export interface EncryptedNewSessionRequest {
  requestId: string;
  directory: string;
  startingMode: 'interactive' | 'remote';
  metadata?: string; // encrypted
}

export interface DaemonToServerEvents {
  'machine-connect': (data: { 
    token: string; 
    machineIdentity: string; // encrypted MachineIdentity
  }) => void;
  'machine-alive': (data: { 
    time: number;
  }) => void;
  'session-spawn-result': (data: {
    requestId: string;
    result: string; // encrypted result
  }) => void;
}

export interface ServerToDaemonEvents {
  'spawn-session': (
    data: string, // encrypted EncryptedNewSessionRequest
    callback: (response: string) => void // encrypted response
  ) => void;
  'daemon-command': (data: {
    command: 'shutdown' | 'status';
  }) => void;
}