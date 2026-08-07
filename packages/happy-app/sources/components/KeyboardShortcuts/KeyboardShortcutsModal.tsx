import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { ShortcutRow, ShortcutSection } from './shortcutCatalog';

type KeyboardShortcutsModalProps = {
    onClose: () => void;
    sections: readonly ShortcutSection[];
};

const FOCUSABLE_SELECTOR = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(', ');

function ShortcutKeycap({ token }: { token: string }) {
    return (
        <View style={styles.keycap} testID={`keyboard-shortcut-keycap-${token}`}>
            <Text style={styles.keycapText}>{token}</Text>
        </View>
    );
}

function ShortcutAlternatives({ alternatives }: Pick<ShortcutRow, 'alternatives'>) {
    return (
        <View style={styles.alternatives}>
            {alternatives.map((chord, alternativeIndex) => (
                <React.Fragment key={`${alternativeIndex}-${chord.join('-')}`}>
                    {alternativeIndex > 0 ? (
                        <Text
                            accessibilityElementsHidden
                            importantForAccessibility="no-hide-descendants"
                            style={styles.alternativeSeparator}
                            testID="keyboard-shortcut-alternative-separator"
                        >
                            /
                        </Text>
                    ) : null}
                    <View style={styles.chord}>
                        {chord.map((token, tokenIndex) => (
                            <ShortcutKeycap key={`${tokenIndex}-${token}`} token={token} />
                        ))}
                    </View>
                </React.Fragment>
            ))}
        </View>
    );
}

function ShortcutReferenceRow({ row }: { row: ShortcutRow }) {
    const { theme } = useUnistyles();

    return (
        <View style={styles.row} testID={`keyboard-shortcut-row-${row.id}`}>
            <Ionicons
                accessibilityElementsHidden
                color={theme.colors.textSecondary}
                importantForAccessibility="no-hide-descendants"
                name={row.icon}
                size={18}
            />
            <View style={styles.rowCopy}>
                <Text style={styles.rowLabel}>{row.label}</Text>
                {row.detail ? <Text style={styles.rowDetail}>{row.detail}</Text> : null}
            </View>
            <ShortcutAlternatives alternatives={row.alternatives} />
        </View>
    );
}

function ShortcutReferenceSection({ section }: { section: ShortcutSection }) {
    return (
        <View style={styles.section} testID={`keyboard-shortcut-section-${section.id}`}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>
                {section.title}
            </Text>
            {section.rows.map((row) => <ShortcutReferenceRow key={row.id} row={row} />)}
        </View>
    );
}

export const KeyboardShortcutsModal = React.memo(function KeyboardShortcutsModal({
    onClose,
    sections,
}: KeyboardShortcutsModalProps) {
    const { theme } = useUnistyles();
    const closeRef = React.useRef<any>(null);
    const panelRef = React.useRef<any>(null);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof document === 'undefined') return;

        const panel = panelRef.current as HTMLElement | null;
        const savedFocus = document.activeElement as HTMLElement | null;
        closeRef.current?.focus?.();

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Tab') return;

            if (!panel) return;

            const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (!first || !last) {
                event.preventDefault();
                closeRef.current?.focus?.();
                return;
            }

            const activeElement = document.activeElement;
            if (!panel.contains(activeElement)) {
                event.preventDefault();
                first.focus();
            } else if (event.shiftKey && activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };

        panel?.addEventListener('keydown', handleKeyDown, true);
        return () => {
            panel?.removeEventListener('keydown', handleKeyDown, true);
            savedFocus?.focus?.({ preventScroll: true });
        };
    }, []);

    return (
        <View
            ref={panelRef}
            accessibilityLabel={t('keyboardShortcuts.title')}
            accessibilityViewIsModal
            role="dialog"
            style={styles.panel}
            testID="keyboard-shortcuts-dialog"
        >
            <View style={styles.header} testID="keyboard-shortcuts-header">
                <Text style={styles.title} testID="keyboard-shortcuts-title">
                    {t('keyboardShortcuts.title')}
                </Text>
                <Pressable
                    ref={closeRef}
                    accessibilityLabel={t('keyboardShortcuts.close')}
                    accessibilityRole="button"
                    onPress={onClose}
                    style={({ pressed }) => [styles.closeButton, pressed && styles.closeButtonPressed]}
                    testID="keyboard-shortcuts-close"
                >
                    <Ionicons
                        accessibilityElementsHidden
                        color={theme.colors.textSecondary}
                        importantForAccessibility="no-hide-descendants"
                        name="close"
                        size={20}
                    />
                </Pressable>
            </View>
            <ScrollView
                contentContainerStyle={styles.scrollContent}
                style={styles.scroll}
                testID="keyboard-shortcuts-scroll"
            >
                {sections.map((section) => (
                    <ShortcutReferenceSection key={section.id} section={section} />
                ))}
            </ScrollView>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    panel: {
        width: Platform.OS === 'web' ? 'calc(100vw - 32px)' as any : '100%',
        maxWidth: 720,
        maxHeight: Platform.OS === 'web' ? '76vh' as any : 560,
        overflow: 'hidden',
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 8 },
        elevation: 10,
    },
    header: {
        minHeight: 56,
        paddingLeft: 20,
        paddingRight: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    title: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text,
        fontSize: 18,
        ...Typography.default('semiBold'),
    },
    closeButton: {
        width: 36,
        height: 36,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 8,
    },
    closeButtonPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    scroll: {
        flexShrink: 1,
        minHeight: 0,
    },
    scrollContent: {
        paddingHorizontal: 20,
        paddingTop: 18,
        paddingBottom: 22,
    },
    section: {
        marginBottom: 20,
    },
    sectionTitle: {
        marginBottom: 6,
        color: theme.colors.groupped.sectionTitle,
        fontSize: 12,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        ...Typography.default('semiBold'),
    },
    row: {
        minHeight: 46,
        paddingVertical: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 11,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    rowCopy: {
        flex: 1,
        minWidth: 0,
    },
    rowLabel: {
        color: theme.colors.text,
        fontSize: 14,
        ...Typography.default('semiBold'),
    },
    rowDetail: {
        marginTop: 2,
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 16,
        ...Typography.default(),
    },
    alternatives: {
        maxWidth: '48%',
        flexShrink: 0,
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 7,
    },
    alternativeSeparator: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        ...Typography.mono(),
    },
    chord: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    keycap: {
        minWidth: 28,
        height: 28,
        paddingHorizontal: 7,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 6,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.groupped.background,
    },
    keycapText: {
        color: theme.colors.text,
        fontSize: 12,
        ...Typography.mono('semiBold'),
    },
}));
