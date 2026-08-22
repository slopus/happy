/**
 * Agy Backend Factory
 *
 * Automatically selects between:
 *  1. AgySdkBackend: High-performance, persistent process backed by google-antigravity Python SDK.
 *     Activated when GEMINI_API_KEY / GOOGLE_API_KEY is present or HAPPY_AGY_ENGINE=sdk.
 *  2. AgyBackend: Robust Stream-JSON CLI runner with automatic retry on transient startup EOF.
 *     Default mode for Google OAuth subscription logins via `agy` binary.
 */

import type { AgentBackend, AgentMessageHandler } from '@/agent/core/AgentBackend';
import { AgyBackend, type AgyBackendOptions } from './AgyBackend';
import { AgySdkBackend } from './AgySdkBackend';
import type { PermissionMode } from '@/api/types';
import type { DiscoveredModel } from './discoverModels';

export interface CreateAgyBackendOptions extends AgyBackendOptions {
  apiKey?: string;
  forceEngine?: 'sdk' | 'cli';
}

export type AnyAgyBackend = AgentBackend & {
  getConversationId: () => string | null;
  setConversationId: (id: string | null) => void;
  onConversationId: (cb: (id: string) => void) => () => void;
  setPermissionMode: (mode: PermissionMode) => void;
  setModel: (model: string | undefined) => void;
  getModel: () => string | undefined;
  setDiscoveredModels: (models: DiscoveredModel[]) => void;
  reset: () => void;
  offMessage: (handler: AgentMessageHandler) => void;
  dispose: () => Promise<void>;
};

/**
 * Determine whether the Python SDK engine should be preferred.
 */
export function shouldUseSdkEngine(opts: CreateAgyBackendOptions): boolean {
  if (opts.forceEngine === 'sdk' || process.env.HAPPY_AGY_ENGINE === 'sdk') {
    return true;
  }
  if (opts.forceEngine === 'cli' || process.env.HAPPY_AGY_ENGINE === 'cli') {
    return false;
  }
  const hasApiKey = Boolean(opts.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  return hasApiKey;
}

/**
 * Instantiate the optimal Agy backend.
 */
export function createAgyBackend(opts: CreateAgyBackendOptions): AnyAgyBackend {
  if (shouldUseSdkEngine(opts)) {
    opts.log?.('Using Antigravity Python SDK Engine (persistent live session)');
    return new AgySdkBackend(opts);
  }
  opts.log?.('Using Antigravity Stream-JSON CLI Engine (per-turn CLI runner with auto-retry)');
  return new AgyBackend(opts);
}
