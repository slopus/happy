import * as React from 'react';
import { Modal, Platform, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { BrowserStepsPanel } from './BrowserStepsPanel';
import type { BrowserStep } from './browserStepsModel';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SessionImageViewer } from '../SessionImageViewer';
import type { ImageViewerSource } from '@/sync/imageViewer';

export type BrowserStepsAnchorRect = {
    height: number;
    width: number;
    x: number;
    y: number;
};

const VIEWPORT_GUTTER = 12;
const ANCHOR_GAP = 8;
const DESKTOP_WIDTH = 520;
type SafeAreaInsets = { bottom: number; left: number; right: number; top: number };
const NO_SAFE_AREA: SafeAreaInsets = { bottom: 0, left: 0, right: 0, top: 0 };

export function getBrowserStepsPopoverLayout(
    anchor: BrowserStepsAnchorRect | undefined,
    viewport: { height: number; width: number },
    safeArea: SafeAreaInsets = NO_SAFE_AREA,
): { height: number; left: number; top: number; width: number } {
    const narrow = viewport.width < 600;
    const minimumLeft = safeArea.left + VIEWPORT_GUTTER;
    const minimumTop = safeArea.top + VIEWPORT_GUTTER;
    const maximumWidth = Math.max(0, viewport.width - safeArea.left - safeArea.right - VIEWPORT_GUTTER * 2);
    const maximumHeight = Math.max(0, viewport.height - safeArea.top - safeArea.bottom - VIEWPORT_GUTTER * 2);
    const width = narrow
        ? maximumWidth
        : Math.min(DESKTOP_WIDTH, maximumWidth);
    const height = narrow
        ? maximumHeight
        : Math.min(720, Math.floor(viewport.height * 0.72), maximumHeight);

    if (narrow || !anchor) {
        return {
            height,
            left: narrow ? minimumLeft : Math.max(minimumLeft, Math.floor((viewport.width - width) / 2)),
            top: narrow ? minimumTop : Math.max(minimumTop, Math.floor((viewport.height - height) / 2)),
            width,
        };
    }

    const roomOnRight = viewport.width - safeArea.right - VIEWPORT_GUTTER - (anchor.x + anchor.width + ANCHOR_GAP);
    const preferredLeft = roomOnRight >= width
        ? anchor.x + anchor.width + ANCHOR_GAP
        : anchor.x - width - ANCHOR_GAP;
    const left = Math.min(
        Math.max(minimumLeft, preferredLeft),
        Math.max(minimumLeft, viewport.width - safeArea.right - width - VIEWPORT_GUTTER),
    );
    const roomBelow = viewport.height - safeArea.bottom - VIEWPORT_GUTTER - (anchor.y + anchor.height + ANCHOR_GAP);
    const preferredTop = roomBelow >= height
        ? anchor.y + anchor.height + ANCHOR_GAP
        : anchor.y - height - ANCHOR_GAP;
    const top = Math.min(
        Math.max(minimumTop, preferredTop),
        Math.max(minimumTop, viewport.height - safeArea.bottom - height - VIEWPORT_GUTTER),
    );

    return { height, left, top, width };
}

export const BrowserStepsPopover = React.memo(function BrowserStepsPopover(props: {
    anchor?: BrowserStepsAnchorRect;
    dialogId?: string;
    open: boolean;
    onClose: () => void;
    returnFocusRef?: React.RefObject<{ focus?: () => void } | null>;
    sessionId?: string;
    steps: BrowserStep[];
}) {
    const { theme } = useUnistyles();
    const viewport = useWindowDimensions();
    const safeArea = useSafeAreaInsets();
    const [gallery, setGallery] = React.useState<{ sources: ImageViewerSource[]; index: number }>();
    const imageButtonRef = React.useRef<View>(null);
    const closeGallery = React.useCallback(() => {
        setGallery(undefined);
        if (Platform.OS === 'web') requestAnimationFrame(() => imageButtonRef.current?.focus());
    }, []);
    const openImage = React.useCallback((source: ImageViewerSource) => {
        const index = props.steps.findIndex(step => step.ref === (source.attachmentRef ?? source.uri));
        if (index < 0 || source.sessionId !== props.sessionId) return;
        const sources = props.steps.map(step => ({
            uri: props.sessionId ? (step.ref === source.attachmentRef ? source.uri : '') : step.ref,
            ...(props.sessionId ? { sessionId: props.sessionId, attachmentRef: step.ref } : {}), filename: step.name,
            width: step.width, height: step.height,
        }));
        setGallery({ sources, index });
    }, [props.sessionId, props.steps]);
    const layout = React.useMemo(
        () => getBrowserStepsPopoverLayout(props.anchor, viewport, safeArea),
        [props.anchor, safeArea, viewport.height, viewport.width],
    );
    const closeAndRestoreFocus = React.useCallback(() => {
        props.onClose();
        if (Platform.OS === 'web') {
            setTimeout(() => props.returnFocusRef?.current?.focus?.(), 0);
        }
    }, [props.onClose, props.returnFocusRef]);

    if (!props.open) return null;
    return (
        <Modal
            accessibilityLabel={t('rightPanelCapabilityHub.browserProgress.title')}
            animationType={Platform.OS === 'web' ? 'none' : 'fade'}
            nativeID={props.dialogId}
            onRequestClose={gallery ? closeGallery : closeAndRestoreFocus}
            transparent
            visible
        >
            {gallery ? (
                <GestureHandlerRootView style={styles.fullscreen}>
                    <SessionImageViewer sources={gallery.sources} initialIndex={gallery.index} onClose={closeGallery} paginate={false} />
                </GestureHandlerRootView>
            ) : null}
            <View style={[styles.overlay, gallery && styles.hidden]}>
                <Pressable
                    accessibilityLabel={t('rightPanelCapabilityHub.browserProgress.close')}
                    onPress={closeAndRestoreFocus}
                    style={[styles.scrim, { backgroundColor: theme.colors.shadow.color }]}
                    testID="browser-steps-popover-backdrop"
                />
                <View
                    style={[
                        styles.card,
                        layout,
                        {
                            backgroundColor: theme.colors.surface,
                            borderColor: theme.colors.divider,
                            shadowColor: theme.colors.shadow.color,
                            shadowOpacity: theme.colors.shadow.opacity,
                        },
                    ]}
                    testID="browser-steps-popover"
                >
                    <View
                        style={[styles.header, { borderBottomColor: theme.colors.divider }]}
                        testID="browser-steps-popover-header"
                    >
                        <Text style={[styles.title, { color: theme.colors.text }]}>
                            {t('rightPanelCapabilityHub.browserProgress.title')}
                        </Text>
                        <Pressable
                            accessibilityLabel={t('rightPanelCapabilityHub.browserProgress.close')}
                            accessibilityRole="button"
                            hitSlop={8}
                            onPress={closeAndRestoreFocus}
                            style={({ pressed }) => [
                                styles.closeButton,
                                { backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface },
                            ]}
                            testID="browser-steps-popover-close"
                        >
                            <Ionicons color={theme.colors.textSecondary} name="close" size={18} />
                        </Pressable>
                    </View>
                    <View style={styles.body} testID="browser-steps-popover-content">
                        <BrowserStepsPanel sessionId={props.sessionId} steps={props.steps} onOpenImage={openImage} imageButtonRef={imageButtonRef} />
                    </View>
                </View>
            </View>
        </Modal>
    );
});

const styles = StyleSheet.create(() => ({
    fullscreen: { flex: 1 },
    hidden: { display: 'none' },
    overlay: { flex: 1, position: 'relative' },
    scrim: { ...StyleSheet.absoluteFillObject, opacity: 0.28 },
    card: {
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        elevation: 12,
        overflow: 'hidden',
        position: 'absolute',
        shadowOffset: { height: 12, width: 0 },
        shadowRadius: 32,
    },
    header: { alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 11 },
    body: { flex: 1, minHeight: 0 },
    closeButton: { alignItems: 'center', borderRadius: 8, height: 30, justifyContent: 'center', width: 30 },
    title: { fontSize: 15, fontWeight: '700' },
}));
