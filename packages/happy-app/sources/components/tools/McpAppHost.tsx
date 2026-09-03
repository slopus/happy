import * as React from 'react';
import { Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { McpAppPresentationV1, McpAppResultV1 } from '@slopus/happy-wire';
import { useSession } from '@/sync/storage';
import type { ToolCall } from '@/sync/typesMessage';
import { getCurrentLanguage, t } from '@/text';
import { Modal } from '@/modal';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { createMcpAppHostController, type McpAppHostState } from './mcpApps/hostController';
import { createMcpAppExternalLinkHandler } from './mcpApps/linkPolicy';
import { createMcpAppRemotePort } from './mcpApps/remotePort';
import { createMcpAppFrameAdapter, McpAppFrameView } from './mcpApps/frameAdapter';
import type { McpAppHostContext } from './mcpApps/types';
import { tracking } from '@/track/tracking';
import type { McpAppTelemetrySink } from './mcpApps/mcpAppTelemetry';

const mcpAppProductTelemetrySink: McpAppTelemetrySink = (eventName, payload) => {
    tracking?.capture(eventName, payload);
};

type Props = {
    sessionId?: string;
    toolCall: ToolCall;
    presentation: McpAppPresentationV1;
    result?: McpAppResultV1;
};

export function McpAppHost({ sessionId, toolCall, presentation, result }: Props) {
    const session = useSession(sessionId ?? '');
    const online = Boolean(sessionId) && session?.presence === 'online';
    const dimensions = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const { theme } = useUnistyles();
    const frameAdapter = React.useMemo(() => createMcpAppFrameAdapter(), []);
    const remotePort = React.useMemo(() => createMcpAppRemotePort({ sessionId: sessionId ?? '' }), [sessionId]);
    const controllerRef = React.useRef<ReturnType<typeof createMcpAppHostController> | undefined>(undefined);
    const unavailable = result?.state === 'unavailable' || !toolCall.callId;
    const unsupported = frameAdapter.support === 'unsupported';
    const [hostState, setHostState] = React.useState<McpAppHostState>({ type: 'fallback' });

    const hostContext = React.useMemo<McpAppHostContext>(() => ({
        theme: theme.dark ? 'dark' : 'light',
        locale: getCurrentLanguage(),
        platform: Platform.OS === 'android' || Platform.OS === 'ios' ? Platform.OS : Platform.OS === 'web' ? 'web' : 'desktop',
        touch: Platform.OS === 'android' || Platform.OS === 'ios',
        hover: Platform.OS === 'web',
        container: { width: dimensions.width, height: dimensions.height },
        safeAreaInsets: { top: insets.top, right: insets.right, bottom: insets.bottom, left: insets.left },
        displayMode: 'inline',
    }), [dimensions.height, dimensions.width, insets.bottom, insets.left, insets.right, insets.top, theme.dark]);

    const openExternalLink = React.useMemo(() => createMcpAppExternalLinkHandler({
        development: typeof __DEV__ !== 'undefined' && __DEV__,
        confirm: (title, message, options) => Modal.confirm(title, message, options),
        open: openExternalUrl,
        copy: {
            title: t('mcpApps.openLinkTitle'),
            message: t('mcpApps.openLinkMessage'),
            confirm: t('mcpApps.openLinkConfirm'),
            cancel: t('mcpApps.openLinkCancel'),
        },
    }), [hostContext.locale]);

    React.useEffect(() => {
        if (!online || unavailable || unsupported) {
            setHostState({ type: 'fallback' });
            return;
        }
        const controller = createMcpAppHostController({
            callId: toolCall.callId!,
            presentation,
            input: toolCall.input && typeof toolCall.input === 'object' ? toolCall.input : {},
            result,
            hostContext,
            remotePort,
            frameAdapter,
            openExternalLink,
            telemetry: mcpAppProductTelemetrySink,
            onStateChange: setHostState,
        });
        controllerRef.current = controller;
        void controller.start();
        return () => {
            if (controllerRef.current === controller) controllerRef.current = undefined;
            void controller.dispose();
        };
        // A call ID identifies one immutable tool invocation; live state/context updates use the effects below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [frameAdapter, online, openExternalLink, presentation.resourceUri, remotePort, toolCall.callId, unavailable, unsupported]);

    React.useEffect(() => {
        controllerRef.current?.updateHostContext(hostContext);
    }, [hostContext]);

    React.useEffect(() => {
        void controllerRef.current?.updateToolCall({
            state: toolCall.state,
            result,
            cancellationReason: toolCall.cancellationReason,
        });
    }, [result, toolCall.cancellationReason, toolCall.state]);

    const retry = React.useCallback(() => { void controllerRef.current?.retry(); }, []);

    if (!online) {
        return <SafeFallback message={t('mcpApps.offline')} />;
    }
    if (unavailable) {
        return <SafeFallback message={t('mcpApps.unavailable')} />;
    }
    if (unsupported) {
        return <SafeFallback message={t('mcpApps.unsupported')} />;
    }
    if (hostState.type === 'failed') {
        const message = hostState.error.code === 'MCP_APP_UNSUPPORTED'
            ? t('mcpApps.unsupported')
            : t('mcpApps.unavailable');
        return (
            <SafeFallback message={message}>
                {hostState.error.retryable ? (
                    <Pressable testID="mcp-app-retry" onPress={retry} style={({ pressed }) => [styles.retry, pressed && styles.retryPressed]}>
                        <Text style={styles.retryText}>{t('mcpApps.retry')}</Text>
                    </Pressable>
                ) : null}
            </SafeFallback>
        );
    }

    return (
        <View style={styles.host}>
            {hostState.type === 'active' ? null : <Text style={styles.message}>{t('mcpApps.loading')}</Text>}
            <McpAppFrameView adapter={frameAdapter} />
        </View>
    );
}

function SafeFallback({ message, children }: { message: string; children?: React.ReactNode }) {
    return (
        <View testID="mcp-app-error" style={styles.fallback}>
            <Text style={styles.message}>{message}</Text>
            {children}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    host: {
        width: '100%',
        backgroundColor: theme.colors.surface,
    },
    fallback: {
        alignItems: 'flex-start',
        gap: 8,
        padding: 12,
        backgroundColor: theme.colors.surface,
    },
    message: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
    },
    retry: {
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        backgroundColor: theme.colors.surfacePressed,
    },
    retryPressed: {
        opacity: 0.8,
    },
    retryText: {
        color: theme.colors.text,
        fontSize: 13,
        fontWeight: '500',
    },
}));
