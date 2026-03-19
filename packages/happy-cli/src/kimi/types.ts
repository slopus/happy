/**
 * Kimi Types
 *
 * Type definitions for Kimi CLI integration.
 */

import type { PermissionMode } from '@/api/types';

/**
 * Mode configuration for Kimi messages
 */
export interface KimiMode {
  permissionMode: PermissionMode;
  model?: string;
  originalUserMessage?: string;
}
