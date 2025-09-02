import { parseCallbackUrl, generatePKCE, generateState, PKCECodes, ClaudeAuthTokens } from '@/utils/oauth';
import * as React from 'react';
import { ActivityIndicator, Platform, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withTiming,
} from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';
import WebView from 'react-native-webview';
import { t } from '@/text';
import { Modal } from '@/modal';

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

export type OAuthViewConfig = {
    authUrl: (pkce: PKCECodes, state: string, redirectUri: string) => string;
    tokenExchange: (code: string, verifier: string, state: string) => Promise<ClaudeAuthTokens>;
    onSuccess?: (tokens: ClaudeAuthTokens) => void;
    onError?: (error: string) => void;
    redirectUri?: string;
    backgroundColor?: string;
};

export const OAuthView = React.memo((props: {
    name: string;
    command?: string;
    backgroundColor?: string;
    foregroundColor?: string;
    config: OAuthViewConfig
}) => {
    // Unsupported on web
    if (Platform.OS === 'web') {
        return <OAuthViewUnsupported {...props} />;
    }

    const [parameters, setParameters] = React.useState<{
        pkce: PKCECodes;
        state: string;
        url: string;
        redirectUri: string;
    } | null>(null);
    const [generation, setGeneration] = React.useState(0);

    React.useEffect(() => {
        let mounted = true;

        (async () => {
            const pkce = await generatePKCE();
            const state = generateState();
            const redirectUri = props.config.redirectUri || 'http://localhost:54545/callback';
            const url = props.config.authUrl(pkce, state, redirectUri);

            if (mounted) {
                setParameters({ pkce, state, url, redirectUri });
            }
        })();

        return () => {
            mounted = false;
        };
    }, [generation]); // Only regenerate when generation changes

    if (!parameters) {
        // Return empty view while initializing (almost instant)
        return <View style={styles.container} />;
    }

    return (
        <View style={styles.container}>
            <OAuthViewRender
                key={`${props.name}-${generation}`}
                name={props.name}
                backgroundColor={props.backgroundColor}
                foregroundColor={props.foregroundColor}
                config={props.config}
                parameters={parameters}
                onRetry={() => {
                    setParameters(null);
                    setGeneration(generation + 1);
                }}
            />
        </View>
    );
});

export const OAuthViewRender = React.memo((props: {
    name: string;
    config: OAuthViewConfig;
    parameters: { pkce: PKCECodes; state: string; url: string; redirectUri: string };
    onRetry: () => void;
    backgroundColor?: string;
    foregroundColor?: string;
}) => {
    const { theme } = useUnistyles();
    const [exchangingTokens, setExchangingTokens] = React.useState(false);
    const [webViewLoading, setWebViewLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const isProcessingRef = React.useRef(false);

    // Reanimated shared values
    const tokenExchangeOpacity = useSharedValue(0);
    const webViewLoadingOpacity = useSharedValue(1);

    // Animated styles
    const tokenExchangeAnimatedStyle = useAnimatedStyle(() => ({
        opacity: tokenExchangeOpacity.value,
    }));

    const webViewLoadingAnimatedStyle = useAnimatedStyle(() => ({
        opacity: webViewLoadingOpacity.value,
    }));

    const handleWebViewLoad = React.useCallback(() => {
        // Fade out the WebView loading overlay when page loads
        webViewLoadingOpacity.value = withTiming(0, { duration: 300 }, () => {
            runOnJS(setWebViewLoading)(false);
        });
    }, [webViewLoadingOpacity]);

    const handleNavigationStateChange = React.useCallback(async (navState: any) => {
        console.log('handleNavigationStateChange', navState.url);
        // Prevent processing the same URL multiple times
        if (isProcessingRef.current) {
            return;
        }

        const { url } = navState;

        // Parse callback URL
        const callbackData = parseCallbackUrl(url);

        if (callbackData.code && callbackData.state) {
            // Prevent multiple processing
            isProcessingRef.current = true;

            // Validate state
            if (callbackData.state !== props.parameters.state) {
                setError(t('errors.oauthStateMismatch'));
                isProcessingRef.current = false;
                return false;
            }

            try {
                setExchangingTokens(true);
                // Fade in the loading overlay
                tokenExchangeOpacity.value = withTiming(1, { duration: 200 });

                // Exchange authorization code for tokens
                const tokens = await props.config.tokenExchange(
                    callbackData.code,
                    props.parameters.pkce.verifier,
                    props.parameters.state
                );

                // Keep the overlay visible on success (page will close)
                // Just call success handler without hiding overlay
                if (props.config.onSuccess) {
                    props.config.onSuccess(tokens);
                } else {
                    // Default success behavior
                    Modal.alert(
                        t('common.success'),
                        t('settings.claudeAuthSuccess')
                    );
                }
            } catch (err: any) {
                console.error('Token exchange failed:', err);
                const errorMessage = err.message || t('errors.tokenExchangeFailed');
                setError(errorMessage);
                props.config.onError?.(errorMessage);

                // Fade out on error too
                tokenExchangeOpacity.value = withTiming(0, { duration: 300 }, () => {
                    runOnJS(setExchangingTokens)(false);
                });
            } finally {
                isProcessingRef.current = false;
            }

            return false;
        }

        if (callbackData.error) {
            const errorMessage = t('errors.oauthAuthorizationDenied');
            setError(errorMessage);
            props.config.onError?.(errorMessage);
            return false;
        }

        return true;
    }, [props.parameters, props.config]);

    const handleWebViewError = React.useCallback((syntheticEvent: any) => {
        console.log('handleWebViewError', syntheticEvent);
        const { nativeEvent } = syntheticEvent;
        console.error('WebView error:', nativeEvent);

        // Ignore localhost connection errors (expected)
        if (nativeEvent.url?.includes('localhost')) {
            return;
        }

        const errorMessage = t('errors.webViewLoadFailed');
        setError(errorMessage);
        props.config.onError?.(errorMessage);
    }, [props.config]);

    if (error) {
        return (
            <View style={[styles.errorContainer]}>
                <Text style={[styles.errorText, { color: props.foregroundColor }]}>{error}</Text>
                <TouchableOpacity
                    style={styles.retryButton}
                    onPress={props.onRetry}
                >
                    <Text style={[styles.retryButtonText, { color: props.foregroundColor }]}>{t('common.retry')}</Text>
                </TouchableOpacity>
            </View>
        );
    }

    return (
        <>
            <WebView
                source={{ uri: props.parameters.url }}
                style={[styles.webview, { backgroundColor: props.backgroundColor }]}
                originWhitelist={['*']}
                limitsNavigationsToAppBoundDomains={false}
                onNavigationStateChange={handleNavigationStateChange}
                onShouldStartLoadWithRequest={(request) => {
                    const callbackData = parseCallbackUrl(request.url);
                    if (callbackData.code || callbackData.error) {
                        handleNavigationStateChange({ url: request.url });
                        return false;
                    }
                    return true;
                }}
                onError={handleWebViewError}
                onLoad={handleWebViewLoad}
                startInLoadingState={false}
                sharedCookiesEnabled={true}
                thirdPartyCookiesEnabled={true}
                javaScriptEnabled={true}
                domStorageEnabled={true}
                userAgent='Mozilla/5.0 (iPhone; CPU iPhone OS 10_3 like Mac OS X) AppleWebKit/602.1.50 (KHTML, like Gecko) CriOS/56.0.2924.75 Mobile/14E5239e Safari/602.1'
            />
            {webViewLoading && (
                <Animated.View style={[styles.loadingOverlay, webViewLoadingAnimatedStyle, { backgroundColor: props.backgroundColor }]}>
                    <ActivityIndicator size="large" color={props.foregroundColor || theme.colors.text} />
                    <Text style={[styles.loadingText, { color: props.foregroundColor }]}>{t('common.loading')}</Text>
                </Animated.View>
            )}
            {exchangingTokens && (
                <Animated.View style={[styles.loadingOverlay, tokenExchangeAnimatedStyle, { backgroundColor: props.backgroundColor }]}>
                    <ActivityIndicator size="large" color={props.foregroundColor || theme.colors.text} />
                    <Text style={[styles.loadingText, { color: props.foregroundColor }]}>{t('settings.exchangingTokens')}</Text>
                </Animated.View>
            )}
        </>
    );
});

export const OAuthViewUnsupported = React.memo((props: {
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