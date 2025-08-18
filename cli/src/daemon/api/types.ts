/**
 * Types and interfaces for the Happy daemon functionality
 */

import { z } from 'zod';

/**
 * Used for create, get all, get by id
 */
export const MachineCreateSchema = z.object({
  id: z.string(),
  metadata: z.string(), // Base64 encoded encrypted metadata
  metadataVersion: z.number(),
  activeAt: z.number(),
  createdAt: z.number(),
  updatedAt: z.number()
})

export type MachineResponse = z.infer<typeof MachineResponseSchema>


/**
 * Machine metadata
 */
export const MachineMetadataSchema = z.object({
  host: z.string(),
  platform: z.string(),
  happyCliVersion: z.string(),
  homeDir: z.string(),
  happyHomeDir: z.string(),

  daemonState: z.object({
    lastKnownStatus: z.enum(['running', 'shutting-down']).optional(),
    lastKnownPid: z.number().optional(),
    lastKnownHttpPort: z.number().optional(),
    shutdownRequestedAt: z.number().optional(),
    shutdownSource: z.union([
      z.enum(['happy-app', 'happy-cli', 'os-signal', 'unknown']),
      z.string() // We might add more in the future
    ]).optional()
  })
})

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>

export const Machine

export interface DaemonState {
  pid: number;
  httpPort: number;
  startTime: string;
  startedWithCliVersion: string;
}

export const UpdateSessionBodySchema = z.object({
  t: z.literal('update-session'),
  sid: z.string(),
  metadata: z.object({
    version: z.number(),
    value: z.string()
  }).nullish(),
  agentState: z.object({
    version: z.number(),
    value: z.string()
  }).nullish()
})

export type UpdateSessionBody = z.infer<typeof UpdateSessionBodySchema>

/**
 * Update event from server
 */
export const UpdateSchema = z.object({
  id: z.string(),
  seq: z.number(),
  body: z.union([UpdateBodySchema, UpdateSessionBodySchema]),
  createdAt: z.number()
})

export type Update = z.infer<typeof UpdateSchema>

export interface ServerToDaemonEvents {
  'spawn-session': (
    data: string, // encrypted EncryptedNewSessionRequest
    callback: (response: string) => void // encrypted response
  ) => void;
  update: (data: Update) => void
  'rpc-request': (data: { method: string, params: string }, callback: (response: string) => void) => void
  'rpc-registered': (data: { method: string }) => void
  'rpc-unregistered': (data: { method: string }) => void
  'rpc-error': (data: { type: string, error: string }) => void
  auth: (data: { success: boolean, user: string }) => void
  error: (data: { message: string }) => void
}

export interface DaemonToServerEvents {
  'machine-alive': (data: {
    machineId: string;
    time: number;
  }) => void;
  'machine-update-metadata': (data: {
    machineId: string;
    metadata: string;
    expectedVersion: number
  }, cb: (answer: {
    result: 'error'
  } | {
    result: 'version-mismatch'
    version: number,
    metadata: string
  } | {
    result: 'success',
    version: number,
    metadata: string
  }) => void) => void;
  'rpc-register': (data: { method: string }) => void;
  'rpc-unregister': (data: { method: string }) => void;
  'rpc-call': (data: { method: string, params: any }, callback: (response: {
    ok: boolean
    result?: any
    error?: string
  }) => void) => void;
}
