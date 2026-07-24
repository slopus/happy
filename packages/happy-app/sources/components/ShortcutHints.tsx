import * as React from 'react';
import { Platform, StyleProp, Text, View, ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import {
    formatShortcut,
    GLOBAL_SHORTCUTS,
    GlobalShortcutId,
    ShortcutModifier,
} from '@/keyboard/shortcuts';

interface ShortcutHintsContextValue {
    modifier: ShortcutModifier | null;
    visible: boolean;
    browserSafeShortcuts: boolean;
    sessionShortcutNumbers: Readonly<Record<string, number>>;
}

const EMPTY_SESSION_SHORTCUT_NUMBERS: Readonly<Record<string, number>> = {};

const ShortcutHintsContext = React.createContext<ShortcutHintsContextValue>({
    modifier: null,
    visible: false,
    browserSafeShortcuts: false,
    sessionShortcutNumbers: EMPTY_SESSION_SHORTCUT_NUMBERS,
});

const stylesheet = StyleSheet.create((theme) => ({
    overlay: {
        position: 'absolute',
        right: 20,
        bottom: 20,
        zIndex: 2000,
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
        gap: 6,
        maxWidth: 520,
        padding: 8,
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        ...(Platform.OS === 'web' ? {
            boxShadow: '0 10px 32px rgba(0, 0, 0, 0.16)',
        } as any : {}),
    },
    overlayItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        paddingVertical: 6,
        paddingHorizontal: 8,
        borderRadius: 9,
        backgroundColor: theme.colors.surfaceHigh,
    },
    overlayLabel: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 12,
    },
    keycap: {
        minWidth: 30,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 6,
        paddingVertical: 3,
        borderRadius: 6,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    keycapText: {
        ...Typography.mono(),
        color: theme.colors.text,
        fontSize: 11,
        fontWeight: '600',
    },
    badge: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: 6,
        backgroundColor: theme.colors.surfaceHighest,
    },
    badgeText: {
        ...Typography.mono(),
        color: theme.colors.textSecondary,
        fontSize: 10,
        fontWeight: '700',
    },
}));

const shortcutLabels: Record<GlobalShortcutId, () => string> = {
    commandPalette: () => t('settingsFeatures.commandPalette'),
    newSession: () => t('sidebar.newSession'),
    settings: () => t('settings.title'),
};

export function useShortcutHints() {
    return React.useContext(ShortcutHintsContext);
}

export function ShortcutHintsProvider({
    modifier,
    commandPaletteEnabled,
    recentSessionIds,
    browserSafeShortcuts,
    children,
}: {
    modifier: ShortcutModifier | null;
    commandPaletteEnabled: boolean;
    recentSessionIds: readonly string[];
    browserSafeShortcuts: boolean;
    children: React.ReactNode;
}) {
    const visible = Platform.OS === 'web' && modifier !== null;
    const sessionShortcutNumbers = React.useMemo(() => visible
        ? Object.fromEntries(recentSessionIds.map((sessionId, index) => [sessionId, index + 1]))
        : EMPTY_SESSION_SHORTCUT_NUMBERS,
    [recentSessionIds, visible]);
    const value = React.useMemo(() => ({
        modifier,
        visible,
        browserSafeShortcuts,
        sessionShortcutNumbers,
    }), [browserSafeShortcuts, modifier, visible, sessionShortcutNumbers]);

    return (
        <ShortcutHintsContext.Provider value={value}>
            {children}
            {visible && modifier && (
                <View pointerEvents="none" style={stylesheet.overlay} testID="shortcut-hints-overlay">
                    {GLOBAL_SHORTCUTS
                        .filter((shortcut) => shortcut.id !== 'commandPalette' || commandPaletteEnabled)
                        .map((shortcut) => (
                            <View key={shortcut.id} style={stylesheet.overlayItem}>
                                <View style={stylesheet.keycap}>
                                    <Text style={stylesheet.keycapText}>
                                        {formatShortcut(modifier, shortcut.keyLabel, browserSafeShortcuts)}
                                    </Text>
                                </View>
                                <Text style={stylesheet.overlayLabel}>{shortcutLabels[shortcut.id]()}</Text>
                            </View>
                        ))}
                </View>
            )}
        </ShortcutHintsContext.Provider>
    );
}

export function ShortcutHintBadge({
    shortcutKey,
    style,
}: {
    shortcutKey: string;
    style?: StyleProp<ViewStyle>;
}) {
    const { browserSafeShortcuts, modifier, visible } = useShortcutHints();
    if (!visible || !modifier) {
        return null;
    }

    return (
        <View pointerEvents="none" style={[stylesheet.badge, style]}>
            <Text style={stylesheet.badgeText}>
                {formatShortcut(modifier, shortcutKey, browserSafeShortcuts)}
            </Text>
        </View>
    );
}

export function SessionShortcutHintBadge({
    sessionId,
    style,
}: {
    sessionId: string;
    style?: StyleProp<ViewStyle>;
}) {
    const { sessionShortcutNumbers } = useShortcutHints();
    const shortcutNumber = sessionShortcutNumbers[sessionId];
    if (!shortcutNumber) {
        return null;
    }

    return <ShortcutHintBadge shortcutKey={String(shortcutNumber)} style={style} />;
}
