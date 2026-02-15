/**
 * MockDataProvider
 *
 * Injects fake sessions and machines into the Zustand store,
 * and wraps children in a mock AgentConfigContext that returns
 * configs instantly (no RPC).
 *
 * Usage:
 *   <MockDataProvider fixture={getFixture('multipleProjects')}>
 *     <App />
 *   </MockDataProvider>
 */

import * as React from 'react';
import { storage } from '@/sync/storage';
import { AgentConfigContext } from '@/arc/agent/context';
import {
    ArcConfig,
    AgentConfigState,
    DEFAULT_AGENT_CONFIG,
    getAgentDisplayName,
    getAgentAvatarUrl,
    getAgentVoiceId,
} from '@/arc/agent/types';
import type { MockFixture } from './fixtures';
import { FIXTURE_MESSAGES } from './messages';

interface MockDataProviderProps {
    children: React.ReactNode;
    fixture: MockFixture;
}

export function MockDataProvider({ children, fixture }: MockDataProviderProps) {
    // Inject data into Zustand store on mount
    React.useEffect(() => {
        const state = storage.getState();
        state.applyMachines(fixture.machines, true);
        state.applySessions(fixture.sessions);
        state.applyReady();

        // Inject messages for each session
        const messageMap = fixture.name ? FIXTURE_MESSAGES[fixture.name] : undefined;
        if (messageMap) {
            for (const [sessionId, generator] of Object.entries(messageMap)) {
                const session = fixture.sessions.find(s => s.id === sessionId);
                const baseTime = session?.createdAt ?? Date.now();
                const messages = generator(baseTime);
                state.applyMessages(sessionId, messages);
            }
        }

        return () => {
            // Clean up on unmount
            const s = storage.getState();
            s.applyMachines([], true);
            s.applySessions([]);
        };
    }, [fixture]);

    // Build mock agent config context value
    const contextValue = React.useMemo(() => {
        const configs = fixture.agentConfigs;

        const getConfig = (sessionId: string): ArcConfig => {
            return configs[sessionId] ?? DEFAULT_AGENT_CONFIG;
        };

        const getConfigState = (sessionId: string): AgentConfigState => {
            const config = configs[sessionId];
            if (config) {
                return { status: 'loaded', config, loadedAt: Date.now() };
            }
            return { status: 'not_found', config: null };
        };

        return {
            getConfigState,
            getConfig,
            getDisplayName: (sessionId: string, fallback: string) =>
                getAgentDisplayName(getConfig(sessionId), fallback),
            getAvatarUrl: (sessionId: string) =>
                getAgentAvatarUrl(getConfig(sessionId)),
            getVoiceId: (sessionId: string) =>
                getAgentVoiceId(getConfig(sessionId)),
            isLoading: () => false,
            loadConfig: () => {},
            clearConfig: () => {},
            setSessionRPC: () => {},
        };
    }, [fixture.agentConfigs]);

    return (
        <AgentConfigContext.Provider value={contextValue}>
            {children}
        </AgentConfigContext.Provider>
    );
}
