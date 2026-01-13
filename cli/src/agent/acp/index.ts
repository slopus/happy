/**
 * ACP Module - Agent Client Protocol implementations
 *
 * This module exports all ACP-related functionality including
 * the base AcpBackend and factory helpers.
 *
 * Uses the official @agentclientprotocol/sdk from Zed Industries.
 *
 * For agent-specific backends, use the factories in src/agent/factories/.
 */

// Core ACP backend
export { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from './AcpBackend';

// Factory helper for generic ACP backends
export { createAcpBackend, type CreateAcpBackendOptions } from './createAcpBackend';

// Legacy aliases for backwards compatibility
export { AcpBackend as AcpSdkBackend } from './AcpBackend';
export type { AcpBackendOptions as AcpSdkBackendOptions } from './AcpBackend';

