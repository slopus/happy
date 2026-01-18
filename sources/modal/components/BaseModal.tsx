import React, { useEffect, useRef } from 'react';
import {
    View,
    Modal,
    TouchableWithoutFeedback,
    Animated,
    KeyboardAvoidingView,
    Platform
} from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

// On web, stop events from propagating to expo-router's modal overlay
// which intercepts clicks when it applies pointer-events: none to body
const stopPropagation = (e: { stopPropagation: () => void }) => e.stopPropagation();
const webEventHandlers = Platform.OS === 'web'
    ? { onClick: stopPropagation, onPointerDown: stopPropagation, onTouchStart: stopPropagation }
    : {};

interface BaseModalProps {
    visible: boolean;
    onClose?: () => void;
    children: React.ReactNode;
    animationType?: 'fade' | 'slide' | 'none';
    transparent?: boolean;
    closeOnBackdrop?: boolean;
}

export function BaseModal({
    visible,
    onClose,
    children,
    animationType = 'fade',
    transparent = true,
    closeOnBackdrop = true
}: BaseModalProps) {
    const fadeAnim = useRef(new Animated.Value(0)).current;

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

    // IMPORTANT:
    // On iOS, stacking native modals (expo-router / react-navigation modal screens + RN <Modal>)
    // can lead to the RN modal rendering behind the navigation modal, while still blocking touches.
    // To avoid this, we render "portal style" overlays on native (no RN <Modal>) and keep RN <Modal>
    // for web where we need to escape expo-router's body pointer-events behavior.
    if (Platform.OS !== 'web') {
        if (!visible) return null;
        return (
            <View style={styles.portalRoot} pointerEvents="auto">
                <KeyboardAvoidingView
                    style={styles.container}
                    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                >
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

    return (
        <Modal
            visible={visible}
            transparent={transparent}
            animationType={animationType}
            onRequestClose={onClose}
        >
            <KeyboardAvoidingView
                style={styles.container}
                behavior={Platform.OS === 'web' ? undefined : ((Platform as any).OS === 'ios' ? 'padding' : 'height')}
                {...webEventHandlers}
            >
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
                    {/* See comment above: keep web interactive */}
                    <View pointerEvents="auto" style={{ width: '100%', alignItems: 'center' }}>
                        {children}
                    </View>
                </Animated.View>
            </KeyboardAvoidingView>
        </Modal>
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
        // On web, ensure modal can receive pointer events when body has pointer-events: none
        ...Platform.select({ web: { pointerEvents: 'auto' as const } })
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
