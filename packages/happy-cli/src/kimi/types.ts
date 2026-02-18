/**
 * Kimi Types
 *
 * Type definitions for Kimi CLI integration via ACP protocol.
 */

import type { PermissionMode } from '@/api/types';
import type { McpServerConfig } from '@/agent/core';

/**
 * Mode configuration for Kimi messages
 */
export interface KimiMode {
  permissionMode: PermissionMode;
  model?: string;
}

/**
 * Kimi session configuration for ACP
 */
export interface KimiSessionConfig {
  /** Working directory */
  cwd: string;
  /** Model to use */
  model?: string;
  /** MCP server configurations */
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * Kimi local config (from ~/.kimi/config.toml)
 */
export interface KimiLocalConfig {
  /** Default model */
  defaultModel?: string;
  /** API key (rarely stored in config, usually via kimi login) */
  apiKey?: string;
  /** Other config fields */
  [key: string]: string | undefined;
}
