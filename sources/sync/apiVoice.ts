import { Platform } from 'react-native';
import { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';
import { config } from '@/config';

export interface VoiceTokenResponse {
    allowed: boolean;
    token?: string;
    agentId?: string;
}

export async function fetchVoiceToken(
    credentials: AuthCredentials,
    sessionId: string
): Promise<VoiceTokenResponse> {
    const serverUrl = getServerUrl();
    
    // Get agent ID from config
    const agentId = __DEV__ 
        ? config.elevenLabsAgentIdDev
        : config.elevenLabsAgentIdProd;
    
    if (!agentId) {
        throw new Error('Agent ID not configured');
    }
    
    // Get RevenueCat public API key from config
    let revenueCatPublicKey: string | undefined;
    
    if (Platform.OS === 'ios') {
        revenueCatPublicKey = config.revenueCatAppleKey;
    } else if (Platform.OS === 'android') {
        revenueCatPublicKey = config.revenueCatGoogleKey;
    } else if (Platform.OS === 'web') {
        revenueCatPublicKey = config.revenueCatStripeKey;
    }
    
    const response = await fetch(`${serverUrl}/v1/voice/token`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
            sessionId, 
            agentId,
            revenueCatPublicKey // Send the public API key
        })
    });
    
    if (!response.ok) {
        throw new Error(`Voice token request failed: ${response.status}`);
    }
    
    return await response.json();
}