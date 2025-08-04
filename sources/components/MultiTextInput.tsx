import * as React from 'react';
import { TextInput, Platform, View, NativeSyntheticEvent, TextInputKeyPressEventData } from 'react-native';
import { Typography } from '@/constants/Typography';

export type SupportedKey = 'Enter' | 'Escape' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Tab';

export interface KeyPressEvent {
    key: SupportedKey;
    shiftKey: boolean;
}

export type OnKeyPressCallback = (event: KeyPressEvent) => boolean;

interface MultiTextInputProps {
    value: string;
    onChangeText: (text: string) => void;
    placeholder?: string;
    maxHeight?: number;
    onKeyPress?: OnKeyPressCallback;
}

export const MultiTextInput = React.memo((props: MultiTextInputProps) => {
    const {
        value,
        onChangeText,
        placeholder,
        maxHeight = 120,
        onKeyPress
    } = props;

    const handleKeyPress = React.useCallback((e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
        if (!onKeyPress) return;

        const nativeEvent = e.nativeEvent;
        const key = nativeEvent.key;
        
        // Map native key names to our normalized format
        let normalizedKey: SupportedKey | null = null;
        
        switch (key) {
            case 'Enter':
                normalizedKey = 'Enter';
                break;
            case 'Escape':
                normalizedKey = 'Escape';
                break;
            case 'ArrowUp':
            case 'Up': // iOS may use different names
                normalizedKey = 'ArrowUp';
                break;
            case 'ArrowDown':
            case 'Down':
                normalizedKey = 'ArrowDown';
                break;
            case 'ArrowLeft':
            case 'Left':
                normalizedKey = 'ArrowLeft';
                break;
            case 'ArrowRight':
            case 'Right':
                normalizedKey = 'ArrowRight';
                break;
            case 'Tab':
                normalizedKey = 'Tab';
                break;
        }

        if (normalizedKey) {
            const keyEvent: KeyPressEvent = {
                key: normalizedKey,
                shiftKey: (nativeEvent as any).shiftKey || false
            };
            
            const handled = onKeyPress(keyEvent);
            if (handled) {
                e.preventDefault();
            }
        }
    }, [onKeyPress]);

    return (
        <View style={{ width: '100%' }}>
            <TextInput
                style={{
                    width: '100%',
                    fontSize: 16,
                    maxHeight,
                    color: '#000',
                    textAlignVertical: 'center',
                    padding: 0,
                    ...Typography.default(),
                }}
                placeholder={placeholder}
                placeholderTextColor={Platform.select({ 
                    ios: '#9D9FA3', 
                    android: '#757575',
                    default: '#9D9FA3'
                })}
                value={value}
                onChangeText={onChangeText}
                onKeyPress={handleKeyPress}
                multiline={true}
                autoCapitalize="sentences"
                autoCorrect={true}
                keyboardType="default"
                returnKeyType="default"
                autoComplete="off"
                textContentType="none"
                submitBehavior="newline"
            />
        </View>
    );
});