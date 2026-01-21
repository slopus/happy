import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { BaseModal } from './BaseModal';
import { AlertModalConfig, ConfirmModalConfig } from '../types';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

interface WebAlertModalProps {
    config: AlertModalConfig | ConfirmModalConfig;
    onClose: () => void;
    onConfirm?: (value: boolean) => void;
    showBackdrop?: boolean;
    zIndexBase?: number;
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surface,
        borderRadius: 14,
        width: 270,
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: {
            width: 0,
            height: 2,
        },
        shadowOpacity: 0.25,
        shadowRadius: 4,
        elevation: 5,
    },
    content: {
        paddingHorizontal: 16,
        paddingTop: 20,
        paddingBottom: 16,
        alignItems: 'center',
    },
    title: {
        fontSize: 17,
        textAlign: 'center',
        color: theme.colors.text,
        marginBottom: 4,
    },
    message: {
        fontSize: 13,
        textAlign: 'center',
        color: theme.colors.text,
        marginTop: 4,
        lineHeight: 18,
    },
    buttonContainer: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
    },
    buttonRow: {
        flexDirection: 'row',
    },
    buttonColumn: {
        flexDirection: 'column',
    },
    button: {
        flex: 1,
        paddingVertical: 11,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonPressed: {
        backgroundColor: theme.colors.divider,
    },
    separatorVertical: {
        width: 1,
        backgroundColor: theme.colors.divider,
    },
    separatorHorizontal: {
        height: 1,
        backgroundColor: theme.colors.divider,
    },
    buttonText: {
        fontSize: 17,
        color: theme.colors.textLink,
    },
    primaryText: {
        color: theme.colors.text,
    },
    cancelText: {
        fontWeight: '400',
    },
    destructiveText: {
        color: theme.colors.textDestructive,
    },
}));

export function WebAlertModal({ config, onClose, onConfirm, showBackdrop = true, zIndexBase }: WebAlertModalProps) {
    useUnistyles();
    const styles = stylesheet;
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
            { text: config.cancelText || t('common.cancel'), style: 'cancel' as const },
            { text: config.confirmText || t('common.ok'), style: config.destructive ? 'destructive' as const : 'default' as const }
        ]
        : (config.buttons && config.buttons.length > 0)
            ? config.buttons
            : [{ text: t('common.ok'), style: 'default' as const }];

    const buttonLayout = buttons.length === 3 ? 'twoPlusOne' : buttons.length > 3 ? 'column' : 'row';

    return (
        <BaseModal
            visible={true}
            onClose={onClose}
            closeOnBackdrop={false}
            showBackdrop={showBackdrop}
            zIndexBase={zIndexBase}
        >
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
                
                {buttonLayout === 'twoPlusOne' ? (
                    <View style={styles.buttonContainer}>
                        <View style={styles.buttonRow}>
                            <Pressable
                                style={({ pressed }) => [
                                    styles.button,
                                    pressed && styles.buttonPressed
                                ]}
                                onPress={() => handleButtonPress(0)}
                            >
                                <Text style={[
                                    styles.buttonText,
                                    buttons[0]?.style === 'cancel' && styles.cancelText,
                                    buttons[0]?.style === 'destructive' && styles.destructiveText,
                                    Typography.default(buttons[0]?.style === 'cancel' ? undefined : 'semiBold')
                                ]}>
                                    {buttons[0]?.text}
                                </Text>
                            </Pressable>

                            <View style={styles.separatorVertical} />

                            <Pressable
                                style={({ pressed }) => [
                                    styles.button,
                                    pressed && styles.buttonPressed
                                ]}
                                onPress={() => handleButtonPress(2)}
                            >
                                <Text style={[
                                    styles.buttonText,
                                    buttons[2]?.style === 'cancel' && styles.cancelText,
                                    buttons[2]?.style === 'destructive' && styles.destructiveText,
                                    Typography.default(buttons[2]?.style === 'cancel' ? undefined : 'semiBold')
                                ]}>
                                    {buttons[2]?.text}
                                </Text>
                            </Pressable>
                        </View>

                        <View style={styles.separatorHorizontal} />

                        <Pressable
                            style={({ pressed }) => [
                                styles.button,
                                pressed && styles.buttonPressed
                            ]}
                            onPress={() => handleButtonPress(1)}
                        >
                            <Text style={[
                                styles.buttonText,
                                (buttons[1]?.style === 'default' || !buttons[1]?.style) && styles.primaryText,
                                buttons[1]?.style === 'cancel' && styles.cancelText,
                                buttons[1]?.style === 'destructive' && styles.destructiveText,
                                Typography.default(buttons[1]?.style === 'cancel' ? undefined : 'semiBold')
                            ]}>
                                {buttons[1]?.text}
                            </Text>
                        </Pressable>
                    </View>
                ) : (
                    <View
                        style={[
                            styles.buttonContainer,
                            buttonLayout === 'row' ? styles.buttonRow : styles.buttonColumn,
                        ]}
                    >
                        {buttons.map((button, index) => (
                            <React.Fragment key={index}>
                                {index > 0 && (
                                    <View style={buttonLayout === 'row' ? styles.separatorVertical : styles.separatorHorizontal} />
                                )}
                                <Pressable
                                    style={({ pressed }) => [
                                        styles.button,
                                        pressed && styles.buttonPressed
                                    ]}
                                    onPress={() => handleButtonPress(index)}
                                >
                                    <Text style={[
                                        styles.buttonText,
                                        buttonLayout === 'column' && (button.style === 'default' || !button.style) && styles.primaryText,
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
                )}
            </View>
        </BaseModal>
    );
}
