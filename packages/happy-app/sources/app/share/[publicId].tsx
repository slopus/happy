import * as React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { PublicSessionTranscript } from '@/components/PublicSessionTranscript';
import { getPublicSessionShareSnapshot } from '@/sync/publicSessionShareViewer';
import type { PublicSessionSnapshotV1 } from '@/sync/publicSessionShareTypes';
import { publicSessionShareText as t } from '@/text/publicSessionShareText';

type PublicShareLoadState =
    | { status: 'loading' }
    | { status: 'ready'; snapshot: PublicSessionSnapshotV1; publishedAt: number }
    | { status: 'unavailable' };

export default function PublicSessionSharePage() {
    const params = useLocalSearchParams<{ publicId?: string | string[] }>();
    const publicId = Array.isArray(params.publicId) ? params.publicId[0] : params.publicId;
    const [state, setState] = React.useState<PublicShareLoadState>({ status: 'loading' });

    React.useEffect(() => {
        let active = true;
        if (!publicId) {
            setState({ status: 'unavailable' });
            return () => { active = false; };
        }
        setState({ status: 'loading' });
        void getPublicSessionShareSnapshot(publicId)
            .then((result) => {
                if (active) setState({ status: 'ready', ...result });
            })
            .catch(() => {
                if (active) setState({ status: 'unavailable' });
            });
        return () => { active = false; };
    }, [publicId]);

    React.useEffect(() => {
        if (typeof document === 'undefined') return;
        const previousTitle = document.title;
        document.title = state.status === 'ready' ? `${state.snapshot.title} · Paws` : 'Paws';
        let robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
        const created = !robots;
        if (!robots) {
            robots = document.createElement('meta');
            robots.name = 'robots';
            document.head.appendChild(robots);
        }
        const previousRobots = robots.content;
        robots.content = 'noindex,nofollow,noarchive';
        return () => {
            document.title = previousTitle;
            if (created) robots?.remove();
            else if (robots) robots.content = previousRobots;
        };
    }, [state]);

    if (state.status === 'loading') {
        return (
            <View style={styles.centered} testID="public-session-share-loading">
                <Stack.Screen options={{ title: 'Paws' }} />
                <ActivityIndicator size="small" color={styles.loadingIcon.color} />
            </View>
        );
    }
    if (state.status === 'unavailable' || !publicId) {
        return (
            <View style={styles.centered} testID="public-session-share-unavailable">
                <Stack.Screen options={{ title: t('sessionShare.notFoundTitle') }} />
                <View style={styles.unavailableIcon}>
                    <Ionicons name="link-outline" size={28} color={styles.unavailableIconGlyph.color} />
                </View>
                <Text style={styles.unavailableTitle}>{t('sessionShare.notFoundTitle')}</Text>
                <Text style={styles.unavailableMessage}>{t('sessionShare.notFoundMessage')}</Text>
            </View>
        );
    }
    return (
        <>
            <Stack.Screen options={{ title: state.snapshot.title }} />
            <PublicSessionTranscript
                publicId={publicId}
                publishedAt={state.publishedAt}
                snapshot={state.snapshot}
            />
        </>
    );
}

const styles = StyleSheet.create((theme) => ({
    centered: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
        backgroundColor: theme.colors.groupped.background,
    },
    loadingIcon: { color: theme.colors.accent },
    unavailableIcon: {
        width: 58,
        height: 58,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 18,
        backgroundColor: theme.colors.surfaceHigh,
    },
    unavailableIconGlyph: { color: theme.colors.textSecondary },
    unavailableTitle: {
        color: theme.colors.text,
        fontSize: 22,
        lineHeight: 29,
        fontWeight: '600' as const,
        textAlign: 'center',
        marginTop: 20,
    },
    unavailableMessage: {
        maxWidth: 420,
        color: theme.colors.textSecondary,
        fontSize: 15,
        lineHeight: 22,
        textAlign: 'center',
        marginTop: 8,
    },
}));
