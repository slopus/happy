import React, { useEffect, useRef } from 'react';
import {
    View,
    TouchableWithoutFeedback,
    Animated,
    KeyboardAvoidingView,
    Platform
} from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { requireRadixDialog, requireRadixDismissableLayer } from '@/utils/radixCjs';
import { ModalPortalTargetProvider } from '@/components/ModalPortalTarget';

interface BaseModalProps {
    visible: boolean;
    onClose?: () => void;
    children: React.ReactNode;
    closeOnBackdrop?: boolean;
    showBackdrop?: boolean;
    zIndexBase?: number;
}

export function BaseModal({
    visible,
    onClose,
    children,
    closeOnBackdrop = true,
    showBackdrop = true,
    zIndexBase,
}: BaseModalProps) {
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const baseZ = zIndexBase ?? 100000;
    const [modalPortalTarget, setModalPortalTarget] = React.useState<HTMLElement | null>(null);

    useEffect(() => {
        if (visible) {
            Animated.timing(fadeAnim, {
                toValue: 1,
                duration: 200,
                useNativeDriver: true
            }).start();
        } else {
            Animated.timing(fadeAnim, {
                toValue: 0,
                duration: 200,
                useNativeDriver: true
            }).start();
        }
    }, [visible, fadeAnim]);

    const handleBackdropPress = () => {
        if (closeOnBackdrop && onClose) {
            onClose();
        }
    };

    if (Platform.OS === 'web') {
        if (!visible) return null;

        // IMPORTANT:
        // Use the CJS entrypoints (`require`) so Radix singletons (DismissableLayer / FocusScope stacks)
        // are shared with Vaul / expo-router on web. With Metro, mixing ESM+CJS builds can lead to
        // duplicate Radix modules and broken stacking/focus behavior.
        const Dialog = requireRadixDialog();
        const { Branch: DismissableLayerBranch } = requireRadixDismissableLayer();

        const overlayStyle: React.CSSProperties = {
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            zIndex: baseZ,
        };

        const contentStyle: React.CSSProperties = {
            position: 'fixed',
            inset: 0,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            outline: 'none',
            zIndex: baseZ + 1,
        };

        const visuallyHiddenStyle: React.CSSProperties = {
            position: 'absolute',
            width: 1,
            height: 1,
            padding: 0,
            margin: -1,
            overflow: 'hidden',
            clip: 'rect(0, 0, 0, 0)',
            whiteSpace: 'nowrap',
            borderWidth: 0,
        };

        const portalHostStyle: React.CSSProperties = {
            position: 'absolute',
            top: 0,
            left: 0,
            width: 0,
            height: 0,
            overflow: 'visible',
        };

        return (
            <Dialog.Root
                open={visible}
                onOpenChange={(open) => {
                    if (!open && onClose) onClose();
                }}
            >
                <Dialog.Portal>
                    {showBackdrop ? <Dialog.Overlay style={overlayStyle} /> : null}
                    <DismissableLayerBranch asChild>
                        <Dialog.Content
                            aria-describedby={undefined}
                            style={contentStyle}
                            onClick={(e) => {
                                if (!closeOnBackdrop || !onClose) return;
                                // Close only when clicking the backdrop area (not inside the modal content).
                                // Since `Dialog.Content` covers the viewport, "backdrop" clicks are those where
                                // the event target is the container itself.
                                if (e.target === e.currentTarget) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    onClose();
                                }
                            }}
                            onPointerDownOutside={
                                closeOnBackdrop ? undefined : (e) => e.preventDefault()
                            }
                        >
                            <Dialog.Title style={visuallyHiddenStyle}>Dialog</Dialog.Title>
                            {/* Host for web portals (e.g. popovers) that must live inside the dialog subtree. */}
                            <div
                                data-happy-modal-portal-host=""
                                ref={(node) => {
                                    setModalPortalTarget((prev) => (prev === node ? prev : node));
                                }}
                                style={portalHostStyle}
                            />
                            <ModalPortalTargetProvider target={modalPortalTarget}>
                                <KeyboardAvoidingView
                                    pointerEvents="box-none"
                                    style={styles.container}
                                    behavior={undefined}
                                >
                                    <Animated.View
                                        pointerEvents="box-none"
                                        style={[
                                            styles.content,
                                            {
                                                opacity: fadeAnim,
                                                transform: [{
                                                    scale: fadeAnim.interpolate({
                                                        inputRange: [0, 1],
                                                        outputRange: [0.9, 1]
                                                    })
                                                }]
                                            }
                                        ]}
                                    >
                                        <View pointerEvents="box-none" style={{ width: '100%', alignItems: 'center' }}>
                                            {children}
                                        </View>
                                    </Animated.View>
                                </KeyboardAvoidingView>
                            </ModalPortalTargetProvider>
                        </Dialog.Content>
                    </DismissableLayerBranch>
                </Dialog.Portal>
            </Dialog.Root>
        );
    }

    // IMPORTANT:
    // On iOS, stacking native modals (expo-router / react-navigation modal screens + RN <Modal>)
    // can lead to the RN modal rendering behind the navigation modal, while still blocking touches.
    // To avoid this, we render "portal style" overlays on native (no RN <Modal>).
    if (!visible) return null;

    return (
        <View style={[styles.portalRoot, { zIndex: baseZ, elevation: baseZ }]} pointerEvents="auto">
            <KeyboardAvoidingView
                style={styles.container}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                {showBackdrop ? (
                    <TouchableWithoutFeedback onPress={handleBackdropPress}>
                        <Animated.View
                            style={[
                                styles.backdrop,
                                {
                                    opacity: fadeAnim.interpolate({
                                        inputRange: [0, 1],
                                        outputRange: [0, 0.5]
                                    })
                                }
                            ]}
                        />
                    </TouchableWithoutFeedback>
                ) : null}

                <Animated.View
                    pointerEvents="box-none"
                    style={[
                        styles.content,
                        {
                            opacity: fadeAnim,
                            transform: [{
                                scale: fadeAnim.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: [0.9, 1]
                                })
                            }]
                        }
                    ]}
                >
                    <View pointerEvents="auto" style={{ width: '100%', alignItems: 'center' }}>
                        {children}
                    </View>
                </Animated.View>
            </KeyboardAvoidingView>
        </View>
    );
}

const styles = StyleSheet.create({
    portalRoot: {
        ...StyleSheet.absoluteFillObject,
        zIndex: 100000,
        elevation: 100000,
    },
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'black'
    },
    content: {
        zIndex: 1,
        // On web, some modal children use percentage widths; ensure they center reliably.
        width: '100%',
        alignItems: 'center',
    }
});
