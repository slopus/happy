/**
 * Transport Handlers
 *
 * Agent-specific transport logic for ACP backends.
 *
 * @module transport
 */

// Core types and interfaces
export type {
  TransportHandler,
  ToolPattern,
  StderrContext,
  StderrResult,
  ToolNameContext,
} from './TransportHandler';

// Default implementation
export { DefaultTransport, defaultTransport } from './DefaultTransport';

// Note: provider-specific ACP transport handlers live with the provider
// implementation (e.g. `@/backends/gemini/acp/transport`).
