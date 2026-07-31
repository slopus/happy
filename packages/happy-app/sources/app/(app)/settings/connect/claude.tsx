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
import { Platform, Pressable, View } from 'react-native';
import { Text } from '@/components/StyledText';
import { StyleSheet } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';

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

export const OAuthViewUnsupported = React.memo((props: {
    name: string;
    command?: string;
}) => {
    const command = props.command || `happy connect ${props.name.toLowerCase()}`;
    const [copied, setCopied] = React.useState(false);
    const feedbackTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => () => {
        if (feedbackTimer.current) {
            clearTimeout(feedbackTimer.current);
        }
    }, []);

    const handleCopy = React.useCallback(async () => {
        try {
            await Clipboard.setStringAsync(command);
            setCopied(true);
            if (feedbackTimer.current) {
                clearTimeout(feedbackTimer.current);
            }
            feedbackTimer.current = setTimeout(() => setCopied(false), 2_000);
        } catch (error) {
            console.error('Failed to copy Claude connection command:', error);
        }
    }, [command]);

    return (
        <View style={styles.unsupportedContainer}>
            <Text style={styles.unsupportedTitle}>{t('connectClaude.title')}</Text>
            <Text style={styles.unsupportedText}>
                {t('connectClaude.instruction')}
            </Text>
            <View style={styles.terminalContainer}>
                <View style={styles.terminalRow}>
                    <Text style={styles.terminalCommand}>
                        <Text style={styles.terminalPrompt}>$ </Text>
                        {command}
                    </Text>
                    <Pressable
                        accessibilityLabel={t(copied ? 'common.copied' : 'common.copy')}
                        accessibilityRole="button"
                        onPress={handleCopy}
                        style={({ pressed }) => [styles.copyButton, pressed && styles.copyButtonPressed]}
                        tabIndex={0}
                        testID="claude-connect-copy-button"
                    >
                        <Text accessibilityLiveRegion="polite" style={styles.copyButtonText}>
                            {t(copied ? 'common.copied' : 'common.copy')}
                        </Text>
                    </Pressable>
                </View>
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
        backgroundColor: theme.colors.accent,
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
    terminalRow: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 12,
        justifyContent: 'space-between',
    },
    terminalPrompt: {
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        fontSize: 14,
        color: '#00ff00',
    },
    terminalCommand: {
        flex: 1,
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        fontSize: 14,
        color: '#ffffff',
        minWidth: 0,
    },
    copyButton: {
        alignItems: 'center',
        backgroundColor: 'rgba(255, 255, 255, 0.12)',
        borderColor: 'rgba(255, 255, 255, 0.2)',
        borderRadius: 6,
        borderWidth: 1,
        justifyContent: 'center',
        minHeight: 32,
        minWidth: 64,
        paddingHorizontal: 10,
    },
    copyButtonPressed: {
        opacity: 0.72,
    },
    copyButtonText: {
        color: '#ffffff',
        fontSize: 13,
        fontWeight: '600',
    },
}));
