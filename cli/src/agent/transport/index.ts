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

// Agent-specific handlers
export { GeminiTransport, geminiTransport } from './handlers';
export { OpencodeTransport, opencodeTransport } from './handlers';
