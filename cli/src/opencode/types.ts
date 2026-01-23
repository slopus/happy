/**
 * OpenCode Types
 *
 * Centralized type definitions for OpenCode integration.
 */

import type { PermissionMode } from '@/api/types';

/**
 * Mode configuration for OpenCode messages
 */
export interface OpencodeMode {
  permissionMode: PermissionMode;
  model?: string;
  originalUserMessage?: string; // Original user message without system prompt
}

/**
 * OpenCode message payload for sending messages to mobile app
 */
export interface OpencodeMessagePayload {
  type: 'message';
  message: string;
  id: string;
  options?: string[];
}
