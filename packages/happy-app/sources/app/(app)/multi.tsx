/**
 * Multi-session multiplexer.
 *
 * Renders a horizontal tab strip of session IDs and the SessionView for the
 * active tab. Tabs come from the `ids` URL query param (comma-separated session
 * IDs) and the active tab from `active`. Closing a tab updates the URL.
 *
 * This is a minimum-viable scaffold:
 *   - No multi-pane / side-by-side rendering (one SessionView at a time —
 *     others are unmounted on tab switch).
 *   - No "add session" picker UI; populate `ids` by navigating to
 *     `/multi?ids=cmm1,cmm2&active=cmm1` or by future integration in the
 *     sessions list (long-press → "open in multi").
 *   - Tab strings are English-only; run the i18n-translator agent before
 *     shipping.
 */

import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SessionView } from '@/-session/SessionView';
import { useSession } from '@/sync/storage';
import { getSessionName } from '@/utils/sessionUtils';

const SEPARATOR = ',';

function parseIds(raw: string | string[] | undefined): string[] {
    if (!raw) return [];
    const flat = Array.isArray(raw) ? raw.join(SEPARATOR) : raw;
    return flat
        .split(SEPARATOR)
        .map((s) => s.trim())
        .filter(Boolean);
}

function buildUrl(ids: string[], active: string | null): string {
    if (ids.length === 0) return '/multi';
    const params = new URLSearchParams();
    params.set('ids', ids.join(SEPARATOR));
    if (active && ids.includes(active)) {
        params.set('active', active);
    }
    return `/multi?${params.toString()}`;
}

export default React.memo(() => {
    const router = useRouter();
    const params = useLocalSearchParams<{ ids?: string | string[]; active?: string | string[] }>();

    const ids = React.useMemo(() => parseIds(params.ids), [params.ids]);
    const activeFromUrl = React.useMemo(() => {
        const a = Array.isArray(params.active) ? params.active[0] : params.active;
        return a && ids.includes(a) ? a : ids[0] ?? null;
    }, [params.active, ids]);

    const setActive = React.useCallback((id: string) => {
        router.setParams({ ids: ids.join(SEPARATOR), active: id });
    }, [router, ids]);

    const closeTab = React.useCallback((id: string) => {
        const next = ids.filter((x) => x !== id);
        const nextActive = next.includes(activeFromUrl ?? '') ? activeFromUrl : next[0] ?? null;
        router.replace(buildUrl(next, nextActive));
    }, [ids, activeFromUrl, router]);

    if (ids.length === 0) {
        return (
            <View style={styles.empty}>
                <Text style={styles.emptyTitle}>No sessions open</Text>
                <Text style={styles.emptyHint}>
                    Open multi-tab view with{'\n'}
                    /multi?ids=session1,session2&active=session1
                </Text>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.tabStrip}
                contentContainerStyle={styles.tabStripContent}
            >
                {ids.map((id) => (
                    <Tab
                        key={id}
                        id={id}
                        active={id === activeFromUrl}
                        onPress={() => setActive(id)}
                        onClose={() => closeTab(id)}
                    />
                ))}
            </ScrollView>
            <View style={styles.body}>
                {activeFromUrl ? <SessionView id={activeFromUrl} /> : null}
            </View>
        </View>
    );
});

const Tab = React.memo((props: { id: string; active: boolean; onPress: () => void; onClose: () => void }) => {
    const session = useSession(props.id);
    const label = session ? getSessionName(session) : props.id.slice(0, 6);
    return (
        <Pressable
            onPress={props.onPress}
            style={[styles.tab, props.active && styles.tabActive]}
        >
            <Text style={[styles.tabLabel, props.active && styles.tabLabelActive]} numberOfLines={1}>
                {label}
            </Text>
            <Pressable
                onPress={(e) => { e.stopPropagation(); props.onClose(); }}
                hitSlop={8}
                style={styles.tabClose}
            >
                <Ionicons name="close" size={14} />
            </Pressable>
        </Pressable>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    tabStrip: {
        flexGrow: 0,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
        backgroundColor: theme.colors.header.background,
    },
    tabStripContent: {
        paddingHorizontal: 8,
        paddingVertical: 6,
        gap: 6,
        alignItems: 'center',
    },
    tab: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 12,
        paddingRight: 6,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: theme.colors.surface,
        maxWidth: 220,
        gap: 6,
    },
    tabActive: {
        backgroundColor: theme.colors.surfaceHighest,
    },
    tabLabel: {
        color: theme.colors.text,
        fontSize: 13,
        flexShrink: 1,
    },
    tabLabelActive: {
        fontWeight: '600',
    },
    tabClose: {
        padding: 2,
        borderRadius: 4,
    },
    body: {
        flex: 1,
    },
    empty: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        backgroundColor: theme.colors.surface,
    },
    emptyTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 8,
    },
    emptyHint: {
        fontSize: 13,
        color: theme.colors.text,
        opacity: 0.6,
        textAlign: 'center',
    },
}));
