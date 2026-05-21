/**
 * Multi-session multiplexer.
 *
 * Layout model:
 *   - Top: a row of *tabs* (named workspaces) the user can add/rename/close.
 *   - Below: every session in the active tab is rendered simultaneously in a
 *     CSS grid, so the user can read + interact with several conversations
 *     side-by-side without the cost of mounting/unmounting on switch.
 *
 * Inactive tabs' SessionViews are still mounted (display: 'none') so scroll
 * position, draft input, and pending operations survive tab switches. The
 * grid columns auto-derive from session count (1→1col, 2→2col, 3-4→2col,
 * 5+→3col) and rows just flow. A future iteration will add drag-to-resize
 * and drag-to-rearrange; for now the grid is auto-flow.
 *
 * State is persisted in localSettings.multiTabs/multiActiveTabId. Legacy
 * multiSessionIds/multiActiveId is migrated into a single default tab on
 * first mount so the upgrade is transparent.
 *
 * Keyboard (web/desktop):
 *   Cmd/Ctrl-1..9          Switch to tab N
 *   Cmd/Ctrl-T             Add a new tab
 *   Cmd/Ctrl-W             Close active tab
 *   Cmd/Ctrl-Shift-]       Cycle to next tab
 *   Cmd/Ctrl-Shift-[       Cycle to previous tab
 *   Cmd/Ctrl-Shift-A       Add session to active tab (picker)
 */

import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { SessionView } from '@/-session/SessionView';
import { useSession, useSessions, useLocalSettingMutable } from '@/sync/storage';
import { getSessionName } from '@/utils/sessionUtils';
import { Modal } from '@/modal';

type MultiTab = {
    id: string;
    name: string;
    sessionIds: string[];
};

function newTabId(): string {
    return 'tab_' + Math.random().toString(36).slice(2, 10);
}

function makeDefaultTab(sessionIds: string[] = []): MultiTab {
    return { id: newTabId(), name: 'Workspace', sessionIds };
}

function gridColumnsFor(count: number): number {
    if (count <= 1) return 1;
    if (count <= 2) return 2;
    if (count <= 4) return 2;
    return 3;
}

export default React.memo(() => {
    const router = useRouter();
    const [tabs, setTabs] = useLocalSettingMutable('multiTabs');
    const [activeTabId, setActiveTabId] = useLocalSettingMutable('multiActiveTabId');
    // Legacy single-tab shape — read once on mount for migration only.
    const [legacyIds] = useLocalSettingMutable('multiSessionIds');
    const [legacyActive] = useLocalSettingMutable('multiActiveId');

    // One-shot migration of the v1 single-tab shape into the new multi-tab
    // shape. We only run when no tabs exist yet so a returning user keeps
    // whatever they already built up here.
    const migratedRef = React.useRef(false);
    React.useEffect(() => {
        if (migratedRef.current) return;
        migratedRef.current = true;
        if (tabs && tabs.length > 0) return;
        const seedIds = legacyIds ?? [];
        const seed = makeDefaultTab(seedIds);
        setTabs([seed]);
        setActiveTabId(seed.id);
        // We intentionally don't drop the legacy keys here — keeping them
        // means a downgrade to an older client still has access to its
        // sessions. Future cleanup can drop them once the migration is
        // load-bearing for everyone.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const safeTabs: MultiTab[] = tabs ?? [];
    const activeTab = safeTabs.find((t) => t.id === activeTabId) ?? safeTabs[0] ?? null;

    const allSessions = useSessions();

    const updateTab = React.useCallback((tabId: string, mut: (t: MultiTab) => MultiTab) => {
        setTabs((safeTabs).map((t) => (t.id === tabId ? mut(t) : t)));
    }, [safeTabs, setTabs]);

    const addTab = React.useCallback(() => {
        const t = makeDefaultTab();
        setTabs([...safeTabs, t]);
        setActiveTabId(t.id);
    }, [safeTabs, setTabs, setActiveTabId]);

    const closeTab = React.useCallback((tabId: string) => {
        const next = safeTabs.filter((t) => t.id !== tabId);
        setTabs(next);
        if (activeTabId === tabId) {
            setActiveTabId(next[0]?.id ?? null);
        }
    }, [safeTabs, activeTabId, setTabs, setActiveTabId]);

    const renameActiveTab = React.useCallback((name: string) => {
        if (!activeTab) return;
        updateTab(activeTab.id, (t) => ({ ...t, name }));
    }, [activeTab, updateTab]);

    const cycleTab = React.useCallback((delta: 1 | -1) => {
        if (safeTabs.length < 2 || !activeTab) return;
        const i = safeTabs.findIndex((t) => t.id === activeTab.id);
        const next = safeTabs[(i + delta + safeTabs.length) % safeTabs.length];
        setActiveTabId(next.id);
    }, [safeTabs, activeTab, setActiveTabId]);

    const openSessionPicker = React.useCallback(() => {
        if (!activeTab) return;
        const candidates = (allSessions ?? [])
            .filter((item): item is Exclude<typeof item, string> => typeof item !== 'string')
            .filter((s) => !activeTab.sessionIds.includes(s.id))
            .slice(0, 30);
        if (candidates.length === 0) {
            Modal.alert('No sessions', 'All your sessions are already in this tab.', [{ text: 'OK' }]);
            return;
        }
        Modal.alert(
            'Add session',
            'Pick a session to add to this tab.',
            candidates.map((s) => ({
                text: getSessionName(s) || s.id.slice(0, 8),
                onPress: () => {
                    updateTab(activeTab.id, (t) => ({ ...t, sessionIds: [...t.sessionIds, s.id] }));
                },
            })).concat([{ text: 'Cancel', style: 'cancel' as const, onPress: () => {} }] as any)
        );
    }, [activeTab, allSessions, updateTab]);

    const removeSessionFromTab = React.useCallback((sessionId: string) => {
        if (!activeTab) return;
        updateTab(activeTab.id, (t) => ({ ...t, sessionIds: t.sessionIds.filter((id) => id !== sessionId) }));
    }, [activeTab, updateTab]);

    // Web/desktop keyboard shortcuts. Tab-level Cmd-1..9, Cmd-T for new tab,
    // Cmd-W to close, Cmd-Shift-[/] to cycle, Cmd-Shift-A to add session.
    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return;
        const handler = (e: KeyboardEvent) => {
            const mod = e.metaKey || e.ctrlKey;
            if (!mod) return;

            if (!e.shiftKey && e.key >= '1' && e.key <= '9') {
                const idx = Number(e.key) - 1;
                if (idx < safeTabs.length) {
                    e.preventDefault();
                    setActiveTabId(safeTabs[idx].id);
                }
                return;
            }
            if (!e.shiftKey && e.key.toLowerCase() === 't') {
                e.preventDefault();
                addTab();
                return;
            }
            if (!e.shiftKey && e.key.toLowerCase() === 'w' && activeTab) {
                e.preventDefault();
                closeTab(activeTab.id);
                return;
            }
            if (e.shiftKey && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                openSessionPicker();
                return;
            }
            if (e.shiftKey && e.key === ']') { e.preventDefault(); cycleTab(1); return; }
            if (e.shiftKey && e.key === '[') { e.preventDefault(); cycleTab(-1); return; }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [safeTabs, activeTab, addTab, closeTab, cycleTab, openSessionPicker, setActiveTabId]);

    if (safeTabs.length === 0) {
        return (
            <View style={styles.empty}>
                <Text style={styles.emptyTitle}>No tabs yet</Text>
                <Text style={styles.emptyHint}>
                    Tabs let you group sessions into workspaces and view multiple at once.
                </Text>
                <Pressable onPress={addTab} style={styles.emptyAddButton}>
                    <Ionicons name="add" size={18} />
                    <Text style={styles.emptyAddButtonLabel}>New tab</Text>
                </Pressable>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <TabStrip
                tabs={safeTabs}
                activeId={activeTab?.id ?? null}
                onSelect={(id) => setActiveTabId(id)}
                onClose={(id) => closeTab(id)}
                onAdd={addTab}
                onRename={renameActiveTab}
            />
            <View style={styles.tabBody}>
                {safeTabs.map((tab) => (
                    <TabPane
                        key={tab.id}
                        visible={tab.id === activeTab?.id}
                        tab={tab}
                        onAddSession={openSessionPicker}
                        onRemoveSession={removeSessionFromTab}
                    />
                ))}
            </View>
        </View>
    );
});

const TabStrip = React.memo((props: {
    tabs: MultiTab[];
    activeId: string | null;
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
    onAdd: () => void;
    onRename: (name: string) => void;
}) => {
    const { theme } = useUnistyles();
    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.tabStrip}
            contentContainerStyle={styles.tabStripContent}
        >
            {props.tabs.map((tab) => (
                <TabChip
                    key={tab.id}
                    tab={tab}
                    active={tab.id === props.activeId}
                    onPress={() => props.onSelect(tab.id)}
                    onClose={() => props.onClose(tab.id)}
                    onRename={tab.id === props.activeId ? props.onRename : undefined}
                />
            ))}
            <Pressable onPress={props.onAdd} style={styles.addTabButton} hitSlop={6}>
                <Ionicons name="add" size={16} color={theme.colors.text} />
            </Pressable>
        </ScrollView>
    );
});

const TabChip = React.memo((props: {
    tab: MultiTab;
    active: boolean;
    onPress: () => void;
    onClose: () => void;
    onRename?: (name: string) => void;
}) => {
    const [editing, setEditing] = React.useState(false);
    const [draft, setDraft] = React.useState(props.tab.name);

    React.useEffect(() => { setDraft(props.tab.name); }, [props.tab.name]);

    const commit = () => {
        setEditing(false);
        if (props.onRename && draft.trim() && draft.trim() !== props.tab.name) {
            props.onRename(draft.trim());
        } else {
            setDraft(props.tab.name);
        }
    };

    return (
        <Pressable
            onPress={() => {
                if (!props.active) props.onPress();
                else if (props.onRename) setEditing(true);
            }}
            style={[styles.tab, props.active && styles.tabActive]}
        >
            {editing ? (
                <TextInput
                    autoFocus
                    value={draft}
                    onChangeText={setDraft}
                    onBlur={commit}
                    onSubmitEditing={commit}
                    style={[styles.tabLabel, styles.tabLabelActive, styles.tabInput]}
                />
            ) : (
                <Text style={[styles.tabLabel, props.active && styles.tabLabelActive]} numberOfLines={1}>
                    {props.tab.name}
                    {props.tab.sessionIds.length > 0 ? `  ·  ${props.tab.sessionIds.length}` : ''}
                </Text>
            )}
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

const TabPane = React.memo((props: {
    visible: boolean;
    tab: MultiTab;
    onAddSession: () => void;
    onRemoveSession: (sessionId: string) => void;
}) => {
    const cols = gridColumnsFor(props.tab.sessionIds.length);
    return (
        <View style={[styles.pane, { display: props.visible ? 'flex' : 'none' }]}>
            {props.tab.sessionIds.length === 0 ? (
                <View style={styles.paneEmpty}>
                    <Text style={styles.paneEmptyTitle}>No sessions in this tab</Text>
                    <Pressable onPress={props.onAddSession} style={styles.paneEmptyButton}>
                        <Ionicons name="add" size={16} />
                        <Text style={styles.paneEmptyButtonLabel}>Add session</Text>
                    </Pressable>
                </View>
            ) : (
                <View style={styles.grid}>
                    {props.tab.sessionIds.map((id) => (
                        <View
                            key={id}
                            style={[styles.gridCell, { width: `${100 / cols}%` }]}
                        >
                            <View style={styles.gridCellInner}>
                                <SessionPaneHeader
                                    sessionId={id}
                                    onRemove={() => props.onRemoveSession(id)}
                                />
                                <View style={styles.gridCellBody}>
                                    <SessionView id={id} />
                                </View>
                            </View>
                        </View>
                    ))}
                    <Pressable onPress={props.onAddSession} style={styles.addSessionFab} hitSlop={8}>
                        <Ionicons name="add" size={20} color="#fff" />
                    </Pressable>
                </View>
            )}
        </View>
    );
});

const SessionPaneHeader = React.memo((props: { sessionId: string; onRemove: () => void }) => {
    const session = useSession(props.sessionId);
    const label = session ? getSessionName(session) : props.sessionId.slice(0, 6);
    return (
        <View style={styles.gridCellHeader}>
            <Text style={styles.gridCellHeaderLabel} numberOfLines={1}>{label}</Text>
            <Pressable onPress={props.onRemove} hitSlop={8} style={styles.gridCellHeaderClose}>
                <Ionicons name="close" size={14} />
            </Pressable>
        </View>
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
    tabInput: {
        minWidth: 80,
        padding: 0,
        margin: 0,
    },
    tabClose: {
        padding: 2,
        borderRadius: 4,
    },
    addTabButton: {
        paddingHorizontal: 8,
        paddingVertical: 6,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    tabBody: {
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
    paneEmpty: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        gap: 12,
    },
    paneEmptyTitle: {
        fontSize: 16,
        color: theme.colors.text,
        opacity: 0.6,
    },
    paneEmptyButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceHighest,
    },
    paneEmptyButtonLabel: {
        fontSize: 14,
        color: theme.colors.text,
    },
    grid: {
        flex: 1,
        flexDirection: 'row',
        flexWrap: 'wrap',
        position: 'relative',
    },
    gridCell: {
        padding: 4,
    },
    gridCellInner: {
        flex: 1,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface,
    },
    gridCellHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 10,
        paddingVertical: 6,
        gap: 6,
        backgroundColor: theme.colors.header.background,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    gridCellHeaderLabel: {
        flex: 1,
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text,
    },
    gridCellHeaderClose: {
        padding: 2,
    },
    gridCellBody: {
        flex: 1,
    },
    addSessionFab: {
        position: 'absolute',
        right: 16,
        bottom: 16,
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: theme.colors.button.primary.background,
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 4,
        elevation: 4,
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
        fontSize: 14,
        color: theme.colors.text,
    },
}));
