import React, { useEffect, useRef } from 'react';
import {
    View,
    Modal,
    TouchableWithoutFeedback,
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
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const scaleAnim = useRef(new Animated.Value(0.95)).current;

    useEffect(() => {
        if (visible) {
            Animated.parallel([
                Animated.timing(fadeAnim, {
                    toValue: 1,
                    duration: 200,
                    useNativeDriver: true
                }),
                Animated.spring(scaleAnim, {
                    toValue: 1,
                    friction: 10,
                    tension: 60,
                    useNativeDriver: true
                })
            ]).start();
        } else {
            Animated.parallel([
                Animated.timing(fadeAnim, {
                    toValue: 0,
                    duration: 150,
                    useNativeDriver: true
                }),
                Animated.timing(scaleAnim, {
                    toValue: 0.95,
                    duration: 150,
                    useNativeDriver: true
                })
            ]).start();
        }
    }, [visible, fadeAnim, scaleAnim]);

    const handleBackdropPress = () => {
        if (onClose) {
            onClose();
        }
    };

    return (
        <Modal
            visible={visible}
            transparent={true}
            animationType="none"
            onRequestClose={onClose}
        >
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
                                    outputRange: [0, 0.7]
                                })
                            }
                        ]}
                    />
                </TouchableWithoutFeedback>
                
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
        justifyContent: 'center',
        alignItems: 'center',
        paddingTop: 100, // Position slightly higher than center
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
        maxWidth: 640,
    }
});