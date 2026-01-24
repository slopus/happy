/**
 * Arc Agent Config Hook
 *
 * Fetches .arc.yaml from the session's working directory via RPC.
 * Handles loading states, timeouts, and caching.
 */

import { useCallback, useEffect, useRef } from 'react';
import {
  ArcConfig,
  AgentConfigState,
  AgentConfigStatus,
  parseArcConfig,
  DEFAULT_AGENT_CONFIG,
} from './types';

// =============================================================================
// Configuration
// =============================================================================

/** Timeout for RPC call in milliseconds */
const RPC_TIMEOUT_MS = 3000;

/** Cache duration in milliseconds (5 minutes) */
const CACHE_DURATION_MS = 5 * 60 * 1000;

/** File path to read */
const ARC_CONFIG_PATH = '.arc.yaml';

// =============================================================================
// Types
// =============================================================================

interface ReadFileResponse {
  success: boolean;
  content?: string;  // Base64 encoded
  error?: string;
}

interface UseAgentConfigOptions {
  /** Session ID to fetch config for */
  sessionId: string;

  /** Whether session is currently connected/online */
  isConnected: boolean;

  /**
   * RPC function to call session methods.
   * Signature: (sessionId, method, params) => Promise<response>
   */
  sessionRPC: <R, A>(sessionId: string, method: string, params: A) => Promise<R>;

  /** Called when config is loaded (for voice binding, etc.) */
  onConfigLoaded?: (config: ArcConfig) => void;
}

interface UseAgentConfigResult {
  /** Current loading status */
  status: AgentConfigStatus;

  /** Loaded config (null if not loaded) */
  config: ArcConfig | null;

  /** Error message if status is 'error' */
  error?: string;

  /** Whether config is still loading */
  isLoading: boolean;

  /** Whether we have a usable config (loaded or default) */
  hasConfig: boolean;

  /** Effective config (loaded or default) */
  effectiveConfig: ArcConfig;

  /** Manually trigger a reload */
  reload: () => void;
}

// =============================================================================
// In-Memory Cache
// =============================================================================

interface CacheEntry {
  config: ArcConfig | null;
  status: AgentConfigStatus;
  loadedAt: number;
}

const configCache = new Map<string, CacheEntry>();

function getCacheKey(sessionId: string): string {
  return `agent-config:${sessionId}`;
}

function getCachedConfig(sessionId: string): CacheEntry | null {
  const key = getCacheKey(sessionId);
  const entry = configCache.get(key);

  if (!entry) return null;

  // Check if cache is still valid
  const age = Date.now() - entry.loadedAt;
  if (age > CACHE_DURATION_MS) {
    configCache.delete(key);
    return null;
  }

  return entry;
}

function setCachedConfig(
  sessionId: string,
  config: ArcConfig | null,
  status: AgentConfigStatus
): void {
  const key = getCacheKey(sessionId);
  configCache.set(key, {
    config,
    status,
    loadedAt: Date.now(),
  });
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useAgentConfig(
  options: UseAgentConfigOptions
): UseAgentConfigResult {
  const { sessionId, isConnected, sessionRPC, onConfigLoaded } = options;

  // State
  const [state, setState] = React.useState<AgentConfigState>(() => {
    // Check cache first
    const cached = getCachedConfig(sessionId);
    if (cached) {
      return {
        status: cached.status,
        config: cached.config,
        loadedAt: cached.loadedAt,
      };
    }
    return {
      status: 'idle',
      config: null,
    };
  });

  // Track if component is mounted
  const mountedRef = useRef(true);
  const loadingRef = useRef(false);

  // Fetch config via RPC
  const fetchConfig = useCallback(async () => {
    // Prevent concurrent fetches
    if (loadingRef.current) return;
    loadingRef.current = true;

    setState((prev) => ({ ...prev, status: 'loading' }));

    try {
      // Create timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), RPC_TIMEOUT_MS);
      });

      // Create RPC promise
      const rpcPromise = sessionRPC<ReadFileResponse, { path: string }>(
        sessionId,
        'readFile',
        { path: ARC_CONFIG_PATH }
      );

      // Race between RPC and timeout
      const response = await Promise.race([rpcPromise, timeoutPromise]);

      if (!mountedRef.current) return;

      if (response.success && response.content) {
        // Decode base64 content
        const decoded = atob(response.content);
        const config = parseArcConfig(decoded);

        if (config) {
          setState({
            status: 'loaded',
            config,
            loadedAt: Date.now(),
          });
          setCachedConfig(sessionId, config, 'loaded');
          onConfigLoaded?.(config);
        } else {
          // Parse failed, treat as not found
          setState({
            status: 'not_found',
            config: null,
            loadedAt: Date.now(),
          });
          setCachedConfig(sessionId, null, 'not_found');
        }
      } else {
        // File not found or read error
        setState({
          status: 'not_found',
          config: null,
          error: response.error,
          loadedAt: Date.now(),
        });
        setCachedConfig(sessionId, null, 'not_found');
      }
    } catch (err) {
      if (!mountedRef.current) return;

      const isTimeout = err instanceof Error && err.message === 'timeout';

      setState({
        status: isTimeout ? 'timeout' : 'error',
        config: null,
        error: err instanceof Error ? err.message : 'Unknown error',
        loadedAt: Date.now(),
      });

      // Cache errors briefly to avoid hammering
      setCachedConfig(sessionId, null, isTimeout ? 'timeout' : 'error');
    } finally {
      loadingRef.current = false;
    }
  }, [sessionId, sessionRPC, onConfigLoaded]);

  // Trigger fetch when session connects
  useEffect(() => {
    if (!isConnected) return;

    // Check if we already have a valid cached config
    const cached = getCachedConfig(sessionId);
    if (cached && cached.status === 'loaded') {
      // Use cached config
      setState({
        status: cached.status,
        config: cached.config,
        loadedAt: cached.loadedAt,
      });
      if (cached.config) {
        onConfigLoaded?.(cached.config);
      }
      return;
    }

    // Fetch fresh config
    fetchConfig();
  }, [sessionId, isConnected, fetchConfig, onConfigLoaded]);

  // Cleanup
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Computed values
  const isLoading = state.status === 'loading' || state.status === 'idle';
  const hasConfig = state.status === 'loaded' && state.config !== null;
  const effectiveConfig = state.config ?? DEFAULT_AGENT_CONFIG;

  return {
    status: state.status,
    config: state.config,
    error: state.error,
    isLoading,
    hasConfig,
    effectiveConfig,
    reload: fetchConfig,
  };
}

// =============================================================================
// Utility Hooks
// =============================================================================

/**
 * Get just the agent display name, with loading state
 */
export function useAgentDisplayName(
  options: UseAgentConfigOptions,
  fallbackName: string
): { name: string; isLoading: boolean } {
  const { effectiveConfig, isLoading } = useAgentConfig(options);

  const name =
    effectiveConfig.agent?.name && effectiveConfig.agent.name.trim() !== ''
      ? effectiveConfig.agent.name
      : fallbackName;

  return { name, isLoading };
}

/**
 * Get voice agent ID for the session
 */
export function useAgentVoiceId(
  options: UseAgentConfigOptions
): { voiceId: string | null; isLoading: boolean } {
  const { effectiveConfig, isLoading } = useAgentConfig(options);

  return {
    voiceId: effectiveConfig.voice?.elevenlabs_agent_id ?? null,
    isLoading,
  };
}

// Need React import for useState
import * as React from 'react';
