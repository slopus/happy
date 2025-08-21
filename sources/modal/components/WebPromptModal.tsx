import React, { useState, useRef, useEffect } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, KeyboardTypeOptions, Platform } from 'react-native';
import { BaseModal } from './BaseModal';
import { PromptModalConfig } from '../types';
import { Typography } from '@/constants/Typography';

interface WebPromptModalProps {
    config: PromptModalConfig;
    onClose: () => void;
    onConfirm: (value: string | null) => void;
}

export function WebPromptModal({ config, onClose, onConfirm }: WebPromptModalProps) {
    const [inputValue, setInputValue] = useState(config.defaultValue || '');
    const inputRef = useRef<TextInput>(null);

    useEffect(() => {
        // Auto-focus the input when modal opens
        const timer = setTimeout(() => {
            inputRef.current?.focus();
        }, 100);
        return () => clearTimeout(timer);
    }, []);

    const handleCancel = () => {
        onConfirm(null);
        onClose();
    };

    const handleConfirm = () => {
        onConfirm(inputValue);
        onClose();
    };

    const getKeyboardType = (): KeyboardTypeOptions => {
        switch (config.inputType) {
            case 'email-address':
                return 'email-address';
            case 'numeric':
                return 'numeric';
            default:
                return 'default';
        }
    };

    return (
        <BaseModal visible={true} onClose={handleCancel} closeOnBackdrop={false}>
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
                    <TextInput
                        ref={inputRef}
                        style={[styles.input, Typography.default()]}
                        value={inputValue}
                        onChangeText={setInputValue}
                        placeholder={config.placeholder}
                        placeholderTextColor="#8E8E93"
                        keyboardType={getKeyboardType()}
                        secureTextEntry={config.inputType === 'secure-text'}
                        autoCapitalize="none"
                        autoCorrect={false}
                        autoFocus={Platform.OS === 'web'}
                        onSubmitEditing={handleConfirm}
                        returnKeyType="done"
                    />
                </View>
                
                <View style={styles.buttonContainer}>
                    <Pressable
                        style={({ pressed }) => [
                            styles.button,
                            pressed && styles.buttonPressed
                        ]}
                        onPress={handleCancel}
                    >
                        <Text style={[
                            styles.buttonText,
                            styles.cancelText,
                            Typography.default()
                        ]}>
                            {config.cancelText || 'Cancel'}
                        </Text>
                    </Pressable>
                    <View style={styles.buttonSeparator} />
                    <Pressable
                        style={({ pressed }) => [
                            styles.button,
                            pressed && styles.buttonPressed
                        ]}
                        onPress={handleConfirm}
                    >
                        <Text style={[
                            styles.buttonText,
                            Typography.default('semiBold')
                        ]}>
                            {config.confirmText || 'OK'}
                        </Text>
                    </Pressable>
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
    input: {
        width: '100%',
        height: 36,
        borderWidth: 1,
        borderColor: '#C7C7CC',
        borderRadius: 8,
        paddingHorizontal: 10,
        marginTop: 16,
        fontSize: 14,
        color: '#000',
        backgroundColor: '#F2F2F7'
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
    }
});