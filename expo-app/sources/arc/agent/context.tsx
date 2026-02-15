/**
 * Arc Agent Config Context
 *
 * Provides agent configuration to the entire app.
 * Manages config loading for all active sessions.
 */

import * as React from 'react';
import { createContext, useContext, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  ArcConfig,
  AgentConfigState,
  AgentConfigStatus,
  parseArcConfig,
  DEFAULT_AGENT_CONFIG,
  getAgentDisplayName,
  getAgentAvatarUrl,
  getAgentVoiceId,
} from './types';
import { apiSocket } from '@/sync/apiSocket';

// =============================================================================
// Configuration
// =============================================================================

const RPC_TIMEOUT_MS = 3000;
const CACHE_DURATION_MS = 5 * 60 * 1000;
const ARC_CONFIG_PATH = '.arc.yaml';

// =============================================================================
// Types
// =============================================================================

interface ReadFileResponse {
  success: boolean;
  content?: string;
  error?: string;
}

interface SessionRPCFunction {
  <R, A>(sessionId: string, method: string, params: A): Promise<R>;
}

interface AgentConfigContextValue {
  /**
   * Get config state for a session.
   * Returns loading state if not yet fetched.
   */
  getConfigState: (sessionId: string) => AgentConfigState;

  /**
   * Get effective config for a session (loaded or default).
   */
  getConfig: (sessionId: string) => ArcConfig;

  /**
   * Get display name for a session.
   */
  getDisplayName: (sessionId: string, fallback: string) => string;

  /**
   * Get avatar URL for a session (null = use generated).
   */
  getAvatarUrl: (sessionId: string) => string | null;

  /**
   * Get voice agent ID for a session.
   */
  getVoiceId: (sessionId: string) => string | null;

  /**
   * Check if config is still loading for a session.
   */
  isLoading: (sessionId: string) => boolean;

  /**
   * Trigger config load for a session.
   * Called when session becomes active/connected.
   */
  loadConfig: (sessionId: string) => void;

  /**
   * Clear cached config for a session.
   */
  clearConfig: (sessionId: string) => void;

  /**
   * Set the RPC function (called once when socket is ready).
   */
  setSessionRPC: (rpc: SessionRPCFunction) => void;
}

// =============================================================================
// Context
// =============================================================================

export const AgentConfigContext = createContext<AgentConfigContextValue | null>(null);

// =============================================================================
// Provider
// =============================================================================

interface AgentConfigProviderProps {
  children: React.ReactNode;
}

export function AgentConfigProvider({ children }: AgentConfigProviderProps) {
  // Store configs by session ID
  const [configs, setConfigs] = React.useState<Map<string, AgentConfigState>>(
    new Map()
  );

  // RPC function (set after socket connects)
  const rpcRef = useRef<SessionRPCFunction | null>(null);

  // Track loading sessions to prevent duplicate requests
  const loadingRef = useRef<Set<string>>(new Set());

  // Set RPC function
  const setSessionRPC = useCallback((rpc: SessionRPCFunction) => {
    rpcRef.current = rpc;
  }, []);

  // Auto-wire apiSocket.sessionRPC
  useEffect(() => {
    rpcRef.current = (sessionId, method, params) => {
      return apiSocket.sessionRPC(sessionId, method, params);
    };
  }, []);

  // Load config for a session
  const loadConfig = useCallback(async (sessionId: string) => {
    // Skip if already loading
    if (loadingRef.current.has(sessionId)) return;

    // Skip if already loaded and not expired
    const existing = configs.get(sessionId);
    if (
      existing?.status === 'loaded' &&
      existing.loadedAt &&
      Date.now() - existing.loadedAt < CACHE_DURATION_MS
    ) {
      return;
    }

    // Skip if no RPC function
    if (!rpcRef.current) {
      console.warn('[AgentConfig] No RPC function set, cannot load config');
      return;
    }

    loadingRef.current.add(sessionId);

    // Set loading state
    setConfigs((prev) => {
      const next = new Map(prev);
      next.set(sessionId, { status: 'loading', config: null });
      return next;
    });

    try {
      // Create timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), RPC_TIMEOUT_MS);
      });

      // RPC call
      const rpcPromise = rpcRef.current<ReadFileResponse, { path: string }>(
        sessionId,
        'readFile',
        { path: ARC_CONFIG_PATH }
      );

      const response = await Promise.race([rpcPromise, timeoutPromise]);

      if (response.success && response.content) {
        const decoded = atob(response.content);
        const config = parseArcConfig(decoded);

        setConfigs((prev) => {
          const next = new Map(prev);
          next.set(sessionId, {
            status: config ? 'loaded' : 'not_found',
            config,
            loadedAt: Date.now(),
          });
          return next;
        });
      } else {
        setConfigs((prev) => {
          const next = new Map(prev);
          next.set(sessionId, {
            status: 'not_found',
            config: null,
            error: response.error,
            loadedAt: Date.now(),
          });
          return next;
        });
      }
    } catch (err) {
      const isTimeout = err instanceof Error && err.message === 'timeout';

      setConfigs((prev) => {
        const next = new Map(prev);
        next.set(sessionId, {
          status: isTimeout ? 'timeout' : 'error',
          config: null,
          error: err instanceof Error ? err.message : 'Unknown error',
          loadedAt: Date.now(),
        });
        return next;
      });
    } finally {
      loadingRef.current.delete(sessionId);
    }
  }, [configs]);

  // Get config state
  const getConfigState = useCallback(
    (sessionId: string): AgentConfigState => {
      return configs.get(sessionId) ?? { status: 'idle', config: null };
    },
    [configs]
  );

  // Get effective config
  const getConfig = useCallback(
    (sessionId: string): ArcConfig => {
      const state = configs.get(sessionId);
      return state?.config ?? DEFAULT_AGENT_CONFIG;
    },
    [configs]
  );

  // Get display name
  const getDisplayName = useCallback(
    (sessionId: string, fallback: string): string => {
      const config = getConfig(sessionId);
      return getAgentDisplayName(config, fallback);
    },
    [getConfig]
  );

  // Get avatar URL
  const getAvatarUrl = useCallback(
    (sessionId: string): string | null => {
      const config = getConfig(sessionId);
      return getAgentAvatarUrl(config);
    },
    [getConfig]
  );

  // Get voice ID
  const getVoiceId = useCallback(
    (sessionId: string): string | null => {
      const config = getConfig(sessionId);
      return getAgentVoiceId(config);
    },
    [getConfig]
  );

  // Check loading state
  const isLoading = useCallback(
    (sessionId: string): boolean => {
      const state = configs.get(sessionId);
      return !state || state.status === 'idle' || state.status === 'loading';
    },
    [configs]
  );

  // Clear config
  const clearConfig = useCallback((sessionId: string) => {
    setConfigs((prev) => {
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  // Context value
  const value = useMemo<AgentConfigContextValue>(
    () => ({
      getConfigState,
      getConfig,
      getDisplayName,
      getAvatarUrl,
      getVoiceId,
      isLoading,
      loadConfig,
      clearConfig,
      setSessionRPC,
    }),
    [
      getConfigState,
      getConfig,
      getDisplayName,
      getAvatarUrl,
      getVoiceId,
      isLoading,
      loadConfig,
      clearConfig,
      setSessionRPC,
    ]
  );

  return (
    <AgentConfigContext.Provider value={value}>
      {children}
    </AgentConfigContext.Provider>
  );
}

// =============================================================================
// Hook
// =============================================================================

export function useAgentConfigContext(): AgentConfigContextValue {
  const context = useContext(AgentConfigContext);

  if (!context) {
    throw new Error(
      'useAgentConfigContext must be used within AgentConfigProvider'
    );
  }

  return context;
}

/**
 * Convenience hook for a single session's config.
 */
export function useSessionAgentConfig(sessionId: string) {
  const ctx = useAgentConfigContext();

  return {
    state: ctx.getConfigState(sessionId),
    config: ctx.getConfig(sessionId),
    isLoading: ctx.isLoading(sessionId),
    getDisplayName: (fallback: string) => ctx.getDisplayName(sessionId, fallback),
    getAvatarUrl: () => ctx.getAvatarUrl(sessionId),
    getVoiceId: () => ctx.getVoiceId(sessionId),
    reload: () => ctx.loadConfig(sessionId),
  };
}
