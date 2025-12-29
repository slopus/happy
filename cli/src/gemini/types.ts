/**
 * Gemini Types
 * 
 * Centralized type definitions for Gemini integration.
 */

/**
 * Permission mode for tool approval
 */
export type PermissionMode = 'default' | 'read-only' | 'safe-yolo' | 'yolo';

/**
 * Mode configuration for Gemini messages
 */
export interface GeminiMode {
  permissionMode: PermissionMode;
  model?: string;
  originalUserMessage?: string; // Original user message without system prompt
}

/**
 * Codex message payload for sending messages to mobile app
 */
export interface CodexMessagePayload {
  type: 'message';
  message: string;
  id: string;
  options?: string[];
}
