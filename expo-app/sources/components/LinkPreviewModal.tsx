import * as React from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView from 'react-native-webview';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withTiming,
    runOnJS,
} from 'react-native-reanimated';
import { Text } from './StyledText';
import { t } from '@/text';
import { Modal } from '@/modal';
import { Ionicons } from '@expo/vector-icons';

export interface LinkPreviewModalProps {
    url: string;
    id?: string;
}

/**
 * Modal component that displays a WebView for previewing URLs.
 * Includes a navigation bar with close, refresh, and open-in-browser actions.
 */
export const LinkPreviewModal = React.memo((props: LinkPreviewModalProps) => {
    const { url, id } = props;
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const webViewRef = React.useRef<WebView>(null);

    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [currentUrl, setCurrentUrl] = React.useState(url);
    const [htmlContent, setHtmlContent] = React.useState<string | null>(null);

    // Check if URL might have Content-Disposition: attachment (e.g., object storage)
    // and fetch HTML content directly to bypass download behavior
    React.useEffect(() => {
        const fetchHtmlIfNeeded = async () => {
            // Check if it's an HTML file from known object storage domains
            const isObjectStorage = url.includes('.volces.com/') ||
                                    url.includes('.aliyuncs.com/') ||
                                    url.includes('.myqcloud.com/') ||
                                    url.includes('.amazonaws.com/');
            const isHtmlFile = url.toLowerCase().endsWith('.html') || url.toLowerCase().endsWith('.htm');

            if (isObjectStorage && isHtmlFile) {
                try {
                    const response = await fetch(url);
                    const contentDisposition = response.headers.get('Content-Disposition');

                    // If server forces download, fetch content and render directly
                    if (contentDisposition?.includes('attachment')) {
                        const html = await response.text();
                        setHtmlContent(html);
                    }
                } catch (err) {
                    console.error('Failed to fetch HTML content:', err);
                    // Fall back to normal WebView loading
                }
            }
        };

        fetchHtmlIfNeeded();
    }, [url]);

    // Animation for loading overlay
    const loadingOpacity = useSharedValue(1);

    const loadingAnimatedStyle = useAnimatedStyle(() => ({
        opacity: loadingOpacity.value,
    }));

    // Get display URL (truncated for header)
    const displayUrl = React.useMemo(() => {
        try {
            const parsed = new URL(currentUrl);
            const host = parsed.hostname;
            const path = parsed.pathname;
            const display = host + (path !== '/' ? path : '');
            return display.length > 40 ? display.slice(0, 37) + '...' : display;
        } catch {
            return currentUrl.slice(0, 40);
        }
    }, [currentUrl]);

    const handleClose = React.useCallback(() => {
        if (id) {
            Modal.hide(id);
        }
    }, [id]);

    const handleRefresh = React.useCallback(() => {
        setError(null);
        setLoading(true);
        loadingOpacity.value = withTiming(1, { duration: 100 });
        webViewRef.current?.reload();
    }, [loadingOpacity]);

    const handleOpenInBrowser = React.useCallback(async () => {
        try {
            const canOpen = await Linking.canOpenURL(currentUrl);
            if (canOpen) {
                await Linking.openURL(currentUrl);
            }
        } catch (err) {
            console.error('Failed to open URL:', err);
        }
    }, [currentUrl]);

    const handleLoadEnd = React.useCallback(() => {
        loadingOpacity.value = withTiming(0, { duration: 200 }, () => {
            runOnJS(setLoading)(false);
        });
    }, [loadingOpacity]);

    const handleLoadError = React.useCallback((syntheticEvent: any) => {
        const { nativeEvent } = syntheticEvent;
        console.error('WebView error:', nativeEvent);
        setError(t('linkPreview.loadFailed'));
        loadingOpacity.value = withTiming(0, { duration: 200 }, () => {
            runOnJS(setLoading)(false);
        });
    }, [loadingOpacity]);

    const handleNavigationStateChange = React.useCallback((navState: { url: string }) => {
        setCurrentUrl(navState.url);
    }, []);

    // Don't render WebView on web platform
    if (Platform.OS === 'web') {
        return null;
    }

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            {/* Navigation Bar */}
            <View style={styles.navBar}>
                <Pressable
                    onPress={handleClose}
                    style={({ pressed }) => [styles.navButton, pressed && styles.navButtonPressed]}
                    hitSlop={8}
                >
                    <Ionicons name="close" size={24} color={theme.colors.text} />
                </Pressable>

                <View style={styles.urlContainer}>
                    <Text style={styles.urlText} numberOfLines={1}>
                        {displayUrl}
                    </Text>
                </View>

                <View style={styles.navActions}>
                    <Pressable
                        onPress={handleRefresh}
                        style={({ pressed }) => [styles.navButton, pressed && styles.navButtonPressed]}
                        hitSlop={8}
                    >
                        <Ionicons name="refresh-outline" size={22} color={theme.colors.text} />
                    </Pressable>

                    <Pressable
                        onPress={handleOpenInBrowser}
                        style={({ pressed }) => [styles.navButton, pressed && styles.navButtonPressed]}
                        hitSlop={8}
                    >
                        <Ionicons name="open-outline" size={22} color={theme.colors.text} />
                    </Pressable>
                </View>
            </View>

            {/* WebView */}
            <View style={styles.webViewContainer}>
                {error ? (
                    <View style={styles.errorContainer}>
                        <Text style={styles.errorText}>{error}</Text>
                        <Pressable
                            onPress={handleRefresh}
                            style={({ pressed }) => [styles.retryButton, pressed && styles.retryButtonPressed]}
                        >
                            <Text style={styles.retryButtonText}>{t('common.retry')}</Text>
                        </Pressable>
                    </View>
                ) : (
                    <WebView
                        ref={webViewRef}
                        source={htmlContent ? { html: htmlContent, baseUrl: url } : { uri: url }}
                        style={styles.webView}
                        onLoadEnd={handleLoadEnd}
                        onError={handleLoadError}
                        onNavigationStateChange={handleNavigationStateChange}
                        startInLoadingState={false}
                        javaScriptEnabled={true}
                        domStorageEnabled={true}
                        sharedCookiesEnabled={true}
                        thirdPartyCookiesEnabled={true}
                        allowsInlineMediaPlayback={true}
                        mediaPlaybackRequiresUserAction={false}
                    />
                )}

                {/* Loading Overlay */}
                {loading && !error && (
                    <Animated.View style={[styles.loadingOverlay, loadingAnimatedStyle]}>
                        <ActivityIndicator size="large" color={theme.colors.text} />
                        <Text style={styles.loadingText}>{t('common.loading')}</Text>
                    </Animated.View>
                )}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    navBar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    navButton: {
        padding: 8,
        borderRadius: 8,
    },
    navButtonPressed: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    urlContainer: {
        flex: 1,
        marginHorizontal: 8,
        paddingHorizontal: 12,
        paddingVertical: 6,
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 8,
    },
    urlText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
    navActions: {
        flexDirection: 'row',
        gap: 4,
    },
    webViewContainer: {
        flex: 1,
    },
    webView: {
        flex: 1,
        backgroundColor: 'transparent',
    },
    loadingOverlay: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: theme.colors.surface,
        justifyContent: 'center',
        alignItems: 'center',
    },
    loadingText: {
        marginTop: 12,
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
    errorContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
    },
    errorText: {
        fontSize: 16,
        color: theme.colors.textDestructive,
        textAlign: 'center',
        marginBottom: 16,
    },
    retryButton: {
        paddingHorizontal: 20,
        paddingVertical: 10,
        backgroundColor: theme.colors.button.primary.background,
        borderRadius: 8,
    },
    retryButtonPressed: {
        opacity: 0.8,
    },
    retryButtonText: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.button.primary.tint,
    },
}));
