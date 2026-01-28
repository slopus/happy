/**
 * Message Adapters
 *
 * Transforms agent messages to different formats.
 *
 * @module adapters
 */

// Mobile format types
export type {
  MobileAgentType,
  MobileMessageRole,
  MobileMessageMeta,
  MobileUserContent,
  MobileUserMessage,
  MobileAgentContent,
  MobileAgentMessage,
  MobileEventContent,
  MobileSessionEvent,
  MobileEventMessage,
  MobileMessage,
  NormalizedMobilePayload,
} from './MobileMessageFormat';

// Message adapter
export type { MessageAdapterConfig } from './MessageAdapter';
export { MessageAdapter, createMessageAdapter, adapters } from './MessageAdapter';
