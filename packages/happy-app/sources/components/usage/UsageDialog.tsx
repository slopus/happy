import * as React from 'react';
import { Modal, Platform, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@/text';
import { UsagePanel } from './UsagePanel';

const VIEWPORT_GUTTER = 12;
const DESKTOP_WIDTH = 1100;
const DESKTOP_MAX_HEIGHT = 900;

type SafeAreaInsets = { bottom: number; left: number; right: number; top: number };

const NO_SAFE_AREA: SafeAreaInsets = { bottom: 0, left: 0, right: 0, top: 0 };

export function getUsageDialogLayout(viewport: { height: number; width: number }, safeArea: SafeAreaInsets = NO_SAFE_AREA): {
    height: number;
    width: number;
} {
    const availableWidth = Math.max(0, viewport.width - safeArea.left - safeArea.right - VIEWPORT_GUTTER * 2);
    const availableHeight = Math.max(0, viewport.height - safeArea.top - safeArea.bottom - VIEWPORT_GUTTER * 2);
    const narrow = viewport.width < 600;

    return {
        height: narrow
            ? availableHeight
            : Math.min(DESKTOP_MAX_HEIGHT, Math.floor(viewport.height * 0.92), availableHeight),
        width: narrow ? availableWidth : Math.min(DESKTOP_WIDTH, availableWidth),
    };
}

export const UsageDialog = React.memo(function UsageDialog(props: {
    onClose: () => void;
    open: boolean;
    returnFocusRef?: React.RefObject<{ focus?: () => void } | null>;
}) {
    const viewport = useWindowDimensions();
    const safeArea = useSafeAreaInsets();
    const closeButtonRef = React.useRef<any>(null);
    const dialogRef = React.useRef<any>(null);
    const [closeFocused, setCloseFocused] = React.useState(false);
    const [closeHovered, setCloseHovered] = React.useState(false);
    const layout = React.useMemo(
        () => getUsageDialogLayout(viewport, safeArea),
        [safeArea, viewport.height, viewport.width],
    );
    const closeAndRestoreFocus = React.useCallback(() => {
        setCloseFocused(false);
        setCloseHovered(false);
        props.onClose();
        if (Platform.OS === 'web') {
            setTimeout(() => props.returnFocusRef?.current?.focus?.(), 0);
        }
    }, [props.onClose, props.returnFocusRef]);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || !props.open) return;
        const timeout = setTimeout(() => closeButtonRef.current?.focus?.(), 0);
        return () => clearTimeout(timeout);
    }, [props.open]);

    const keepTabFocusInsideDialog = React.useCallback((event: any) => {
        const nativeEvent = event.nativeEvent ?? event;
        if (Platform.OS !== 'web' || nativeEvent.key !== 'Tab' || typeof document === 'undefined') return;

        const dialog = dialogRef.current as HTMLElement | null;
        if (!dialog) return;
        const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
            'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )).filter((element) => (
            element.tabIndex >= 0
            && !element.hasAttribute('disabled')
            && element.getAttribute('aria-hidden') !== 'true'
        ));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;

        const backwards = Boolean(nativeEvent.shiftKey ?? event.shiftKey);
        if (backwards && document.activeElement === first) {
            event.preventDefault?.();
            last.focus();
        } else if (!backwards && document.activeElement === last) {
            event.preventDefault?.();
            first.focus();
        }
    }, []);

    if (!props.open) return null;

    return (
        <Modal
            accessibilityLabel={t('settings.usage')}
            animationType={Platform.OS === 'web' ? 'none' : 'fade'}
            onRequestClose={closeAndRestoreFocus}
            transparent
            visible
        >
            <View style={[
                styles.overlay,
                {
                    paddingBottom: safeArea.bottom + VIEWPORT_GUTTER,
                    paddingLeft: safeArea.left + VIEWPORT_GUTTER,
                    paddingRight: safeArea.right + VIEWPORT_GUTTER,
                    paddingTop: safeArea.top + VIEWPORT_GUTTER,
                },
            ]}>
                <View
                    accessible={false}
                    onTouchEnd={Platform.OS === 'web' ? undefined : closeAndRestoreFocus}
                    style={styles.scrim}
                    testID="sidebar-account-usage-dialog-backdrop"
                    {...(Platform.OS === 'web' ? { onClick: closeAndRestoreFocus } as any : {})}
                />
                <View
                    ref={dialogRef}
                    style={[
                        styles.dialog,
                        layout,
                    ]}
                    testID="sidebar-account-usage-dialog"
                    {...(Platform.OS === 'web' ? { onKeyDown: keepTabFocusInsideDialog } as any : {})}
                >
                    <View style={styles.header}>
                        <Text style={styles.title}>{t('settings.usage')}</Text>
                        <Pressable
                            ref={closeButtonRef}
                            accessibilityLabel={t('common.cancel')}
                            accessibilityRole="button"
                            hitSlop={8}
                            onBlur={Platform.OS === 'web' ? () => setCloseFocused(false) : undefined}
                            onFocus={Platform.OS === 'web' ? () => setCloseFocused(true) : undefined}
                            onHoverIn={Platform.OS === 'web' ? () => setCloseHovered(true) : undefined}
                            onHoverOut={Platform.OS === 'web' ? () => setCloseHovered(false) : undefined}
                            onPress={closeAndRestoreFocus}
                            style={({ pressed }) => [
                                styles.closeButton,
                                closeFocused && styles.closeButtonFocused,
                                (pressed || closeHovered) && styles.closeButtonPressed,
                            ]}
                            testID="sidebar-account-usage-dialog-close"
                        >
                            <Text style={styles.closeGlyph}>×</Text>
                        </Pressable>
                    </View>
                    <View style={styles.body} testID="sidebar-account-usage-dialog-content">
                        <UsagePanel />
                    </View>
                </View>
            </View>
        </Modal>
    );
});

const styles = StyleSheet.create((theme) => ({
    overlay: {
        alignItems: 'center',
        flex: 1,
        justifyContent: 'center',
        padding: VIEWPORT_GUTTER,
        position: 'relative',
    },
    scrim: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: theme.colors.shadow.color,
        opacity: 0.34,
    },
    dialog: {
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.divider,
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        elevation: 12,
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { height: 12, width: 0 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 32,
    },
    header: {
        alignItems: 'center',
        borderBottomColor: theme.colors.divider,
        borderBottomWidth: StyleSheet.hairlineWidth,
        flexDirection: 'row',
        justifyContent: 'space-between',
        minHeight: 64,
        paddingHorizontal: 24,
    },
    title: {
        color: theme.colors.text,
        fontSize: 20,
        fontWeight: '700',
    },
    closeButton: {
        alignItems: 'center',
        backgroundColor: theme.colors.surface,
        borderRadius: 8,
        color: theme.colors.textSecondary,
        height: 30,
        justifyContent: 'center',
        width: 30,
    },
    closeButtonFocused: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    closeButtonPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    closeGlyph: {
        color: theme.colors.textSecondary,
        fontSize: 22,
        lineHeight: 24,
    },
    body: {
        flex: 1,
        minHeight: 0,
    },
}));
