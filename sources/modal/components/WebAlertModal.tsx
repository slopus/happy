import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { BaseModal } from './BaseModal';
import { AlertModalConfig, ConfirmModalConfig } from '../types';
import { Typography } from '@/constants/Typography';

interface WebAlertModalProps {
    config: AlertModalConfig | ConfirmModalConfig;
    onClose: () => void;
    onConfirm?: (value: boolean) => void;
}

export function WebAlertModal({ config, onClose, onConfirm }: WebAlertModalProps) {
    const isConfirm = config.type === 'confirm';
    
    const handleButtonPress = (buttonIndex: number) => {
        if (isConfirm && onConfirm) {
            onConfirm(buttonIndex === 1);
        } else if (!isConfirm && config.buttons?.[buttonIndex]?.onPress) {
            config.buttons[buttonIndex].onPress!();
        }
        onClose();
    };

    const buttons = isConfirm
        ? [
            { text: config.cancelText || 'Cancel', style: 'cancel' as const },
            { text: config.confirmText || 'OK', style: config.destructive ? 'destructive' as const : 'default' as const }
        ]
        : config.buttons || [{ text: 'OK', style: 'default' as const }];

    return (
        <BaseModal visible={true} onClose={onClose} closeOnBackdrop={false}>
            <View style={styles.container}>
                <View style={styles.content}>
                    <Text style={[styles.title, Typography.default('semiBold')]}>
                        {config.title}
                    </Text>
                    {config.message && (
                        <Text style={[styles.message, Typography.default()]}>
                            {config.message}
                        </Text>
                    )}
                </View>
                
                <View style={styles.buttonContainer}>
                    {buttons.map((button, index) => (
                        <React.Fragment key={index}>
                            {index > 0 && <View style={styles.buttonSeparator} />}
                            <Pressable
                                style={({ pressed }) => [
                                    styles.button,
                                    pressed && styles.buttonPressed
                                ]}
                                onPress={() => handleButtonPress(index)}
                            >
                                <Text style={[
                                    styles.buttonText,
                                    button.style === 'cancel' && styles.cancelText,
                                    button.style === 'destructive' && styles.destructiveText,
                                    Typography.default(button.style === 'cancel' ? undefined : 'semiBold')
                                ]}>
                                    {button.text}
                                </Text>
                            </Pressable>
                        </React.Fragment>
                    ))}
                </View>
            </View>
        </BaseModal>
    );
}

const styles = StyleSheet.create({
    container: {
        backgroundColor: 'rgba(255, 255, 255, 0.98)',
        borderRadius: 14,
        width: 270,
        overflow: 'hidden',
        shadowColor: '#000',
        shadowOffset: {
            width: 0,
            height: 2
        },
        shadowOpacity: 0.25,
        shadowRadius: 4,
        elevation: 5
    },
    content: {
        paddingHorizontal: 16,
        paddingTop: 20,
        paddingBottom: 16,
        alignItems: 'center'
    },
    title: {
        fontSize: 17,
        textAlign: 'center',
        color: '#000',
        marginBottom: 4
    },
    message: {
        fontSize: 13,
        textAlign: 'center',
        color: '#000',
        marginTop: 4,
        lineHeight: 18
    },
    buttonContainer: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: 'rgba(0, 0, 0, 0.2)',
        flexDirection: 'row'
    },
    button: {
        flex: 1,
        paddingVertical: 11,
        alignItems: 'center',
        justifyContent: 'center'
    },
    buttonPressed: {
        backgroundColor: 'rgba(0, 0, 0, 0.05)'
    },
    buttonSeparator: {
        width: StyleSheet.hairlineWidth,
        backgroundColor: 'rgba(0, 0, 0, 0.2)'
    },
    buttonText: {
        fontSize: 17,
        color: '#007AFF'
    },
    cancelText: {
        fontWeight: '400'
    },
    destructiveText: {
        color: '#FF3B30'
    }
});