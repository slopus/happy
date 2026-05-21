/**
 * Multi-session multiplexer.
 *
 * Renders a horizontal tab strip plus a stack of SessionViews — only the
 * active one is visible (display: 'flex'); the others are kept mounted
 * (display: 'none') so scroll position, draft input, and pending operations
 * survive tab switching.
 *
 * State (open tab ids + active id) is persisted in localSettings so the
 * workspace survives app relaunches. URL query params (?ids=&active=) still
 * work for direct linking and override the persisted state on first mount.
 *
 * Keyboard (web/desktop only):
 *   Cmd/Ctrl-1..9          Switch to tab N
 *   Cmd/Ctrl-W             Close active tab
 *   Cmd/Ctrl-Shift-]       Cycle to next tab
 *   Cmd/Ctrl-Shift-[       Cycle to previous tab
 *   Cmd/Ctrl-T             Open the "add session" picker
 */

import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SessionView } from '@/-session/SessionView';
import { useSession, useSessions, useLocalSettingMutable } from '@/sync/storage';
import { getSessionName } from '@/utils/sessionUtils';
import { Modal } from '@/modal';

const SEPARATOR = ',';

function parseIds(raw: string | string[] | undefined): string[] {
    if (!raw) return [];
    const flat = Array.isArray(raw) ? raw.join(SEPARATOR) : raw;
    return flat
        .split(SEPARATOR)
        .map((s) => s.trim())
        .filter(Boolean);
}

export default React.memo(() => {
    const router = useRouter();
    const params = useLocalSearchParams<{ ids?: string | string[]; active?: string | string[] }>();
    const [persistedIds, setPersistedIds] = useLocalSettingMutable('multiSessionIds');
    const [persistedActive, setPersistedActive] = useLocalSettingMutable('multiActiveId');

    // URL params win on first mount so deep-links work; afterwards user
    // edits go through state + the localSettings sink.
    const urlIds = React.useMemo(() => parseIds(params.ids), [params.ids]);
    const urlActive = React.useMemo(() => {
        const a = Array.isArray(params.active) ? params.active[0] : params.active;
        return typeof a === 'string' && a.length > 0 ? a : null;
    }, [params.active]);

    React.useEffect(() => {
        if (urlIds.length > 0) {
            setPersistedIds(urlIds);
            if (urlActive && urlIds.includes(urlActive)) {
                setPersistedActive(urlActive);
            } else {
                setPersistedActive(urlIds[0]);
            }
            // Strip the params so subsequent navigation doesn't reapply them.
            router.setParams({ ids: undefined, active: undefined });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const ids = persistedIds ?? [];
    const activeId = persistedActive && ids.includes(persistedActive) ? persistedActive : (ids[0] ?? null);

    const setActive = React.useCallback((id: string) => {
        if (!ids.includes(id)) return;
        setPersistedActive(id);
    }, [ids, setPersistedActive]);

    const closeTab = React.useCallback((id: string) => {
        const next = ids.filter((x) => x !== id);
        setPersistedIds(next);
        if (activeId === id) {
            setPersistedActive(next[0] ?? null);
        }
    }, [ids, activeId, setPersistedIds, setPersistedActive]);

    const allSessions = useSessions();
    const openPicker = React.useCallback(() => {
        // useSessions returns SessionListItem = string | Session — strings are
        // section headers/dividers, Session objects are the rows we want.
        const candidates = (allSessions ?? [])
            .filter((item): item is Exclude<typeof item, string> => typeof item !== 'string')
            .filter((s) => !ids.includes(s.id))
            .slice(0, 30); // cap the action sheet length
        if (candidates.length === 0) {
            Modal.alert('No sessions', 'All your active sessions are already open in tabs.', [{ text: 'OK' }]);
            return;
        }
        Modal.alert(
            'Add tab',
            'Pick a session to add to the multi-tab view.',
            candidates.map((s) => ({
                text: getSessionName(s) || s.id.slice(0, 8),
                onPress: () => {
                    const next = [...ids, s.id];
                    setPersistedIds(next);
                    setPersistedActive(s.id);
                },
            })).concat([{ text: 'Cancel', style: 'cancel' as const, onPress: () => {} }] as any)
        );
    }, [allSessions, ids, setPersistedIds, setPersistedActive]);

    const cycleTab = React.useCallback((delta: 1 | -1) => {
        if (ids.length < 2 || !activeId) return;
        const i = ids.indexOf(activeId);
        const next = ids[(i + delta + ids.length) % ids.length];
        setPersistedActive(next);
    }, [ids, activeId, setPersistedActive]);

    // Web/desktop keyboard shortcuts.
    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return;
        const handler = (e: KeyboardEvent) => {
            const mod = e.metaKey || e.ctrlKey;
            if (!mod) return;

            // Cmd-1..9 → switch tab
            if (!e.shiftKey && e.key >= '1' && e.key <= '9') {
                const idx = Number(e.key) - 1;
                if (idx < ids.length) {
                    e.preventDefault();
                    setPersistedActive(ids[idx]);
                }
                return;
            }
            // Cmd-W → close active
            if (!e.shiftKey && e.key.toLowerCase() === 'w' && activeId) {
                e.preventDefault();
                closeTab(activeId);
                return;
            }
            // Cmd-T → picker
            if (!e.shiftKey && e.key.toLowerCase() === 't') {
                e.preventDefault();
                openPicker();
                return;
            }
            // Cmd-Shift-] / Cmd-Shift-[ → cycle
            if (e.shiftKey && e.key === ']') { e.preventDefault(); cycleTab(1); return; }
            if (e.shiftKey && e.key === '[') { e.preventDefault(); cycleTab(-1); return; }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [ids, activeId, closeTab, openPicker, cycleTab, setPersistedActive]);

    if (ids.length === 0) {
        return (
            <View style={styles.empty}>
                <Text style={styles.emptyTitle}>No sessions open</Text>
                <Text style={styles.emptyHint}>
                    Add a session with the + button below, or open with{'\n'}
                    /multi?ids=session1,session2&active=session1
                </Text>
                <Pressable onPress={openPicker} style={styles.emptyAddButton}>
                    <Ionicons name="add" size={18} />
                    <Text style={styles.emptyAddButtonLabel}>Add tab</Text>
                </Pressable>
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
                        active={id === activeId}
                        onPress={() => setActive(id)}
                        onClose={() => closeTab(id)}
                    />
                ))}
                <Pressable onPress={openPicker} style={styles.addButton} hitSlop={6}>
                    <Ionicons name="add" size={18} />
                </Pressable>
            </ScrollView>
            <View style={styles.body}>
                {ids.map((id) => (
                    <View
                        key={id}
                        style={[styles.pane, { display: id === activeId ? 'flex' : 'none' }]}
                    >
                        <SessionView id={id} />
                    </View>
                ))}
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
    addButton: {
        paddingHorizontal: 8,
        paddingVertical: 6,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    body: {
        flex: 1,
        position: 'relative',
    },
    pane: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
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
        marginBottom: 16,
    },
    emptyAddButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceHighest,
    },
    emptyAddButtonLabel: {
        ...{ fontSize: 14 },
        color: theme.colors.text,
    },
}));
