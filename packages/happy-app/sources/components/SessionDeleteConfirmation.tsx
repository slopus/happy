import * as React from 'react';
import { Modal, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { SessionActionsAnchor } from './SessionActionsPopover';

const MARGIN = 12;
const GAP = 10;
const ARROW_SIZE = 10;
const styles = StyleSheet.create((theme) => ({
    overlay: { flex: 1 },
    outside: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    card: {
        position: 'absolute', padding: 4, borderRadius: 9,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider,
        shadowColor: theme.colors.shadow.color, shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
    },
    arrow: {
        position: 'absolute', width: ARROW_SIZE, height: ARROW_SIZE,
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.divider,
        transform: [{ rotate: '45deg' }],
    },
    arrowAbove: { top: -ARROW_SIZE / 2 - StyleSheet.hairlineWidth, borderLeftWidth: StyleSheet.hairlineWidth, borderTopWidth: StyleSheet.hairlineWidth },
    arrowBelow: { bottom: -ARROW_SIZE / 2 - StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
    actions: { flexDirection: 'row', gap: 4 },
    button: { flex: 1, minHeight: 32, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10, borderRadius: 6 },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    label: { color: theme.colors.text, fontSize: 13, ...Typography.default() },
    destructive: { color: theme.colors.status.error },
}));

/** A transparent, anchored confirmation; deletion only happens after an explicit second click. */
export function SessionDeleteConfirmation({ anchor, onCancel, onConfirm, onVisibilityChange }: {
    anchor: SessionActionsAnchor;
    onCancel: () => void;
    onConfirm: () => void;
    onVisibilityChange?: (visible: boolean) => void;
}) {
    const { width, height } = useWindowDimensions();
    const [cardHeight, setCardHeight] = React.useState(40);
    React.useEffect(() => {
        onVisibilityChange?.(true);
        return () => onVisibilityChange?.(false);
    }, [onVisibilityChange]);
    const committed = React.useRef(false);
    const cancelRef = React.useRef<any>(null);
    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof document === 'undefined') return;
        const previousFocus = document.activeElement as HTMLElement | null;
        cancelRef.current?.focus?.();
        const keydown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
        };
        // Scrolling the list would detach the confirmation from its row.
        const scroll = (event: Event) => {
            if (!(event.target as Element)?.closest?.('[data-testid="session-delete-confirmation"]')) onCancel();
        };
        document.addEventListener('keydown', keydown, true);
        document.addEventListener('scroll', scroll, true);
        return () => {
            document.removeEventListener('keydown', keydown, true);
            document.removeEventListener('scroll', scroll, true);
            if (previousFocus?.isConnected) previousFocus.focus();
        };
    }, [onCancel]);
    const cardWidth = Math.min(156, width - MARGIN * 2);
    const right = anchor.x + (anchor.type === 'rect' ? anchor.width : 0);
    const below = anchor.y + (anchor.type === 'rect' ? anchor.height : 0) + GAP;
    const opensBelow = below + cardHeight <= height - MARGIN;
    const top = opensBelow ? below : anchor.y - cardHeight - GAP;
    const left = Math.max(MARGIN, Math.min(width - cardWidth - MARGIN, right - cardWidth + 8));
    const triggerCenter = anchor.x + (anchor.type === 'rect' ? anchor.width / 2 : 0);
    const arrowLeft = Math.max(12, Math.min(cardWidth - ARROW_SIZE - 12, triggerCenter - left - ARROW_SIZE / 2));
    return (
        <Modal transparent animationType="none" visible onRequestClose={onCancel}>
            <View style={styles.overlay} {...(Platform.OS === 'web' ? {
                onClick: (event: any) => event.stopPropagation(),
            } as any : {})}>
                <Pressable accessibilityLabel={t('common.cancel')} onPress={(event) => { event.stopPropagation(); onCancel(); }} style={styles.outside} testID="session-delete-outside" />
                <View accessibilityLabel={t('sessionInfo.deleteSession')} onLayout={(event) => setCardHeight(event.nativeEvent.layout.height)}
                    testID="session-delete-confirmation" style={[styles.card, {
                        width: cardWidth,
                        left,
                        top: Math.max(MARGIN, Math.min(height - cardHeight - MARGIN, top)),
                    }]}>
                    <View accessible={false} pointerEvents="none" testID="session-delete-arrow"
                        style={[styles.arrow, opensBelow ? styles.arrowAbove : styles.arrowBelow, { left: arrowLeft }]} />
                    <View style={styles.actions}>
                        <Pressable ref={cancelRef} accessibilityRole="button" onPress={(event) => { event.stopPropagation(); onCancel(); }} testID="session-delete-cancel"
                            style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
                            <Text style={styles.label}>{t('common.cancel')}</Text>
                        </Pressable>
                        <Pressable accessibilityRole="button" testID="session-delete-confirm" onPress={(event) => {
                            event.stopPropagation();
                            if (committed.current) return;
                            committed.current = true;
                            onConfirm();
                        }} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
                            <Text style={[styles.label, styles.destructive]}>{t('common.delete')}</Text>
                        </Pressable>
                    </View>
                </View>
            </View>
        </Modal>
    );
}
