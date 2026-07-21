/**
 * Agy Types
 *
 * Centralized type definitions for the agy integration.
 */

import type { PermissionMode } from '@/api/types';

/**
 * Mode configuration for an agy turn, derived from the incoming user message meta.
 */
export interface AgyMode {
  permissionMode: PermissionMode;
  model?: string;
  originalUserMessage?: string; // Original user message without system prompt
}
