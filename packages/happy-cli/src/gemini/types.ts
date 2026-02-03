/**
 * Gemini Types
 *
 * Centralized type definitions for Gemini integration.
 */

import type { ImageContent, PermissionMode } from '@/api/types';

/**
 * Mode configuration for Gemini messages
 */
export interface GeminiMode {
  permissionMode: PermissionMode;
  model?: string;
  originalUserMessage?: string; // Original user message without system prompt
  images?: ImageContent[]; // Optional images for multimodal messages
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
