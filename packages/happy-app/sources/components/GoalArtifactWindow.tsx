import * as React from 'react';
import { Modal, Platform, View, useWindowDimensions } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useUnistyles } from 'react-native-unistyles';
import { GoalArtifactViewer, type GoalArtifactViewerProps } from './GoalArtifactViewer';
import { SessionImageViewer } from './SessionImageViewer';
import type { ImageViewerSource } from '@/sync/imageViewer';

/** A separate reading surface. Modal owns keyboard trapping, Back/Escape and focus return. */
export const GoalArtifactWindow = React.memo(function GoalArtifactWindow(props: GoalArtifactViewerProps) {
    const { theme } = useUnistyles();
    const { height } = useWindowDimensions();
    const closeButtonRef = React.useRef<View>(null);
    const windowRef = React.useRef<View>(null);
    const [image, setImage] = React.useState<ImageViewerSource | null>(null);
    const imageOpener = React.useRef<HTMLElement | null>(null);
    const escapeFromReader = React.useRef(true);
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const keydown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.repeat) return;
            // The image handles keydown, RN Web Modal handles keyup. The same
            // gesture must not close the reader after its image has unmounted.
            escapeFromReader.current = !image && event.target instanceof Node
                && !!(windowRef.current as unknown as HTMLElement | null)?.contains(event.target);
        };
        document.addEventListener('keydown', keydown, true);
        return () => document.removeEventListener('keydown', keydown, true);
    }, [image]);
    React.useLayoutEffect(() => {
        if (!image && imageOpener.current) {
            imageOpener.current.focus({ preventScroll: true });
            imageOpener.current = null;
        }
    }, [image]);
    const closeImage = React.useCallback(() => setImage(null), []);
    const openImage = React.useCallback((source: ImageViewerSource) => {
        if (Platform.OS === 'web' && document.activeElement instanceof HTMLElement) imageOpener.current = document.activeElement;
        setImage(source);
    }, []);
    const requestClose = () => {
        if (Platform.OS === 'web' && !escapeFromReader.current) return;
        if (image) closeImage(); else props.onClose();
    };
    return (
        <Modal accessibilityLabel={props.artifact.name} animationType="fade" transparent visible
            onRequestClose={requestClose} onShow={() => closeButtonRef.current?.focus()}>
            <View style={{ flex: 1, padding: 24, alignItems: 'center', justifyContent: 'center' }}>
                <View testID="goal-artifact-backdrop" accessible={false} importantForAccessibility="no-hide-descendants"
                    onStartShouldSetResponder={() => true} onResponderRelease={props.onClose}
                    style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: theme.colors.modal.backdrop }} />
                <View ref={windowRef} testID="goal-artifact-window" accessibilityViewIsModal style={{
                    display: image ? 'none' : 'flex',
                    width: '100%', maxWidth: 1120, height: Math.max(0, Math.min(800, height - 48)),
                    borderRadius: 8, borderWidth: 1, borderColor: theme.colors.divider,
                    backgroundColor: theme.colors.surface, overflow: 'hidden',
                    shadowColor: theme.colors.shadow.color, shadowOpacity: theme.colors.shadow.opacity,
                    shadowOffset: { width: 0, height: 10 }, shadowRadius: 24,
                }}>
                    <GoalArtifactViewer {...props} closeButtonRef={closeButtonRef} onOpenImage={openImage} />
                </View>
                {image && <GestureHandlerRootView style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}>
                    <SessionImageViewer sources={[image]} initialIndex={0} onClose={closeImage} paginate={false} />
                </GestureHandlerRootView>}
            </View>
        </Modal>
    );
});
