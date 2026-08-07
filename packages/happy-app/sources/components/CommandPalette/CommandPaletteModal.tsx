import React, { useEffect, useRef } from 'react';
import {
    View,
    Modal,
    Pressable,
    Animated,
    KeyboardAvoidingView,
    Platform
} from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

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
    const scaleAnim = useRef(new Animated.Value(0.97)).current;
    const [isModalVisible, setIsModalVisible] = React.useState(true);

    useEffect(() => {
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
    }, [visible, fadeAnim, scaleAnim]);

    const handleClose = React.useCallback(() => {
        // Closing animation
        Animated.parallel([
            Animated.timing(fadeAnim, {
                toValue: 0,
                duration: 150,
                useNativeDriver: Platform.OS !== 'web'
            }),
            Animated.timing(scaleAnim, {
                toValue: 0.97,
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
    }, [fadeAnim, scaleAnim, onClose]);

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
                                outputRange: [0, 1]
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
        paddingHorizontal: 16,
        // Keep the palette above the visual center, where desktop command menus
        // conventionally appear, without pinning it to a fixed pixel offset.
        ...(Platform.OS === 'web' ? {
            paddingTop: '18vh',
        } as any : {
            paddingTop: 120,
        })
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0, 0, 0, 0.42)',
    },
    content: {
        zIndex: 1,
        width: '100%',
        maxWidth: 720,
    }
});
