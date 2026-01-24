/**
 * Wire up the AgentConfigProvider with the apiSocket RPC
 */

import { useEffect } from 'react';
import { apiSocket } from '@/sync/apiSocket';
import { useAgentConfigContext } from './context';

/**
 * Hook to wire up the apiSocket.sessionRPC to AgentConfigProvider.
 * Call this once in a component that renders after socket is ready.
 */
export function useAgentConfigRPC() {
  const { setSessionRPC } = useAgentConfigContext();

  useEffect(() => {
    // Wire up the RPC function
    setSessionRPC((sessionId, method, params) => {
      return apiSocket.sessionRPC(sessionId, method, params);
    });
  }, [setSessionRPC]);
}
