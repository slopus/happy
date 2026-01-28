import React from 'react';
import { useRouter } from 'expo-router';
import { OAuthView } from '@/components/OAuthView';
import { buildAuthorizationUrl, ClaudeAuthTokens, exchangeCodeForTokens } from '@/utils/oauth';
import { Modal } from '@/modal';
import { t } from '@/text';
import { StatusBar } from 'expo-status-bar';
import { useAuth } from '@/auth/AuthContext';
import { connectService } from '@/sync/apiServices';
import { sync } from '@/sync/sync';
import { View } from 'react-native';
import { Text } from '@/components/StyledText';
import { StyleSheet } from 'react-native-unistyles';
import { Platform } from 'react-native';

export default function ClaudeOAuth() {
    // const router = useRouter();
    // const auth = useAuth();

    // const handleSuccess = async (tokens: ClaudeAuthTokens) => {
    //     try {
    //         // Send tokens to server which will update profile.connectedServices
    //         // Pass the raw token response to the server
    //         await connectService(auth.credentials!, 'anthropic', tokens);
    //         await sync.refreshProfile();

    //         // The server will handle updating the profile's connectedServices array
    //         // and it will sync back to the client automatically
    //         Modal.alert(
    //             t('common.success'),
    //             t('settings.claudeAuthSuccess'),
    //             [
    //                 {
    //                     text: t('common.ok'),
    //                     onPress: () => router.back(),
    //                 }
    //             ]
    //         );
    //     } catch (error) {
    //         console.error('Failed to connect Claude account:', error);
    //         Modal.alert(
    //             t('common.error'),
    //             t('errors.connectServiceFailed', { service: 'Claude' })
    //         );
    //     }
    // };

    return (
        <>
            <OAuthViewUnsupported name="Claude" command="happy connect claude" />
            {/* <OAuthView
                name="Claude"
                command="happy connect claude"
                backgroundColor={'#1F1E1C'}
                foregroundColor={'#FFFFFF'}
                config={{
                    authUrl: (pkce, state, _redirectUri) =>
                        buildAuthorizationUrl(pkce.challenge, state),
                    tokenExchange: exchangeCodeForTokens,
                    onSuccess: handleSuccess,
                }}
            /> */}
        </>
    );
}

const OAuthViewUnsupported = React.memo((props: {
    name: string;
    command?: string;
}) => {
    const command = props.command || `happy connect ${props.name.toLowerCase()}`;

    return (
        <View style={styles.unsupportedContainer}>
            <Text style={styles.unsupportedTitle}>Connect {props.name}</Text>
            <Text style={styles.unsupportedText}>
                Run the following command in your terminal:
            </Text>
            <View style={styles.terminalContainer}>
                <Text style={styles.terminalCommand}>
                    <Text style={styles.terminalPrompt}>$ </Text>
                    {command}
                </Text>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    webview: {
        flex: 1,
        backgroundColor: 'rgba(255, 255, 255, 0)',
    },
    loadingContainer: {
        ...StyleSheet.absoluteFillObject,
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: theme.colors.surface,
    },
    loadingOverlay: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: theme.colors.surface,
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 1000,
    },
    loadingText: {
        marginTop: 16,
        fontSize: 16,
        color: theme.colors.text,
    },
    errorContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
        backgroundColor: theme.colors.surface,
    },
    errorText: {
        fontSize: 16,
        color: theme.colors.textDestructive,
        textAlign: 'center',
        marginBottom: 20,
    },
    retryButton: {
        paddingHorizontal: 20,
        paddingVertical: 10,
        backgroundColor: '#007AFF',
        borderRadius: 8,
    },
    retryButtonText: {
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: '600',
    },
    unsupportedContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
        backgroundColor: theme.colors.surface,
    },
    unsupportedTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 20,
    },
    unsupportedText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginBottom: 24,
    },
    terminalContainer: {
        backgroundColor: '#1e1e1e',
        borderRadius: 8,
        padding: 16,
        minWidth: 280,
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.1)',
    },
    terminalPrompt: {
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        fontSize: 14,
        color: '#00ff00',
    },
    terminalCommand: {
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        fontSize: 14,
        color: '#ffffff',
    },
}));
