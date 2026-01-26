/**
 * Realtime Voice Provider
 * Initializes and registers voice providers at app startup
 */

import React, { useEffect } from 'react';
import { registerVoiceProvider } from './RealtimeSession';
import { createStepFunAdapter } from './StepFunVoiceAdapter';

// Flag to ensure providers are only initialized once
let providersInitialized = false;

/**
 * Initialize and register all available voice providers
 */
function initializeProviders() {
    if (providersInitialized) {
        return;
    }

    // Register StepFun provider
    registerVoiceProvider('stepfun', createStepFunAdapter);

    // Note: ElevenLabs provider can be added here when needed
    // registerVoiceProvider('elevenlabs', createElevenLabsAdapter);

    providersInitialized = true;
    console.log('[RealtimeProvider] Voice providers initialized');
}

/**
 * RealtimeProvider component
 * Initializes voice providers when mounted
 */
export const RealtimeProvider = ({ children }: { children: React.ReactNode }) => {
    useEffect(() => {
        initializeProviders();
    }, []);

    return <>{children}</>;
};
