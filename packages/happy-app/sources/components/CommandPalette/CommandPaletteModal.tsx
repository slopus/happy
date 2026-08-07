import React, { useEffect, useRef } from 'react';
import {
    View,
    Modal,
    Pressable,
    Animated,
    StyleSheet,
    KeyboardAvoidingView,
    Platform
} from 'react-native';

interface CommandPaletteModalProps {
    visible: boolean;
    onClose?: () => void;
    children: React.ReactNode;
}

export function CommandPaletteModal({
    visible,
    onClose,
    children
}: CommandPaletteModalProps) {
    const instantKeyboardSurface = Platform.OS === 'web';
    const fadeAnim = useRef(new Animated.Value(instantKeyboardSurface ? 1 : 0)).current;
    const scaleAnim = useRef(new Animated.Value(instantKeyboardSurface ? 1 : 0.95)).current;
    const [isModalVisible, setIsModalVisible] = React.useState(true);

    useEffect(() => {
        if (instantKeyboardSurface) {
            return;
        }
        if (visible) {
            // Opening animation
            Animated.parallel([
                Animated.timing(fadeAnim, {
                    toValue: 1,
                    duration: 200,
                    useNativeDriver: Platform.OS !== 'web'
                }),
                Animated.spring(scaleAnim, {
                    toValue: 1,
                    friction: 10,
                    tension: 60,
                    useNativeDriver: Platform.OS !== 'web'
                })
            ]).start();
        }
    }, [visible, fadeAnim, instantKeyboardSurface, scaleAnim]);

    const handleClose = React.useCallback(() => {
        if (instantKeyboardSurface) {
            setIsModalVisible(false);
            onClose?.();
            return;
        }
        // Closing animation
        Animated.parallel([
            Animated.timing(fadeAnim, {
                toValue: 0,
                duration: 150,
                useNativeDriver: Platform.OS !== 'web'
            }),
            Animated.timing(scaleAnim, {
                toValue: 0.95,
                duration: 150,
                useNativeDriver: Platform.OS !== 'web'
            })
        ]).start(() => {
            setIsModalVisible(false);
            // Small delay to ensure modal is hidden before calling onClose
            setTimeout(() => {
                if (onClose) {
                    onClose();
                }
            }, 50);
        });
    }, [fadeAnim, instantKeyboardSurface, scaleAnim, onClose]);

    const handleBackdropPress = () => {
        handleClose();
    };

    if (!isModalVisible) {
        return null;
    }

    return (
        <Modal
            visible={isModalVisible}
            transparent={true}
            animationType="none"
            onRequestClose={handleClose}
        >
            <KeyboardAvoidingView 
                style={styles.container}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <Animated.View
                    style={[
                        styles.backdrop,
                        {
                            opacity: fadeAnim.interpolate({
                                inputRange: [0, 1],
                                outputRange: [0, 0.7]
                            })
                        }
                    ]}
                >
                    <Pressable
                        accessible={false}
                        onPress={handleBackdropPress}
                        style={StyleSheet.absoluteFill}
                    />
                </Animated.View>
                
                <Animated.View
                    style={[
                        styles.content,
                        {
                            opacity: fadeAnim,
                            transform: [{ scale: scaleAnim }]
                        }
                    ]}
                >
                    {children}
                </Animated.View>
            </KeyboardAvoidingView>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'flex-start',
        alignItems: 'center',
        // Position at 30% from top of viewport
        ...(Platform.OS === 'web' ? {
            paddingTop: '30vh',
        } as any : {
            paddingTop: 200, // Fallback for native
        })
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(15, 15, 15, 0.75)',
        // Remove blur for better performance - use darker overlay instead
        // Blur can be re-enabled if needed but with optimizations
        ...(Platform.OS === 'web' ? {
            // backdropFilter: 'blur(2px)',
            // WebkitBackdropFilter: 'blur(2px)',
            // willChange: 'backdrop-filter',
            // transform: 'translateZ(0)', // Force GPU acceleration
        } as any : {})
    },
    content: {
        zIndex: 1,
        width: '90%',
        maxWidth: 800, // Increased from 640
    }
});
