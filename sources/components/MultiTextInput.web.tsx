import * as React from 'react';
import { View } from 'react-native';
import TextareaAutosize from 'react-textarea-autosize';
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

    // Convert maxHeight to approximate maxRows (assuming ~24px line height)
    const maxRows = Math.floor(maxHeight / 24);

    const handleKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (!onKeyPress) return;

        const key = e.key;
        
        // Map browser key names to our normalized format
        let normalizedKey: SupportedKey | null = null;
        
        switch (key) {
            case 'Enter':
                normalizedKey = 'Enter';
                break;
            case 'Escape':
                normalizedKey = 'Escape';
                break;
            case 'ArrowUp':
                normalizedKey = 'ArrowUp';
                break;
            case 'ArrowDown':
                normalizedKey = 'ArrowDown';
                break;
            case 'ArrowLeft':
                normalizedKey = 'ArrowLeft';
                break;
            case 'ArrowRight':
                normalizedKey = 'ArrowRight';
                break;
            case 'Tab':
                normalizedKey = 'Tab';
                break;
        }

        if (normalizedKey) {
            const keyEvent: KeyPressEvent = {
                key: normalizedKey,
                shiftKey: e.shiftKey
            };
            
            const handled = onKeyPress(keyEvent);
            if (handled) {
                e.preventDefault();
            }
        }
    }, [onKeyPress]);

    return (
        <View style={{ width: '100%' }}>
            <TextareaAutosize
                style={{
                    width: '100%',
                    padding: '0',
                    fontSize: '16px',
                    color: '#000',
                    border: 'none',
                    outline: 'none',
                    resize: 'none' as const,
                    backgroundColor: 'transparent',
                    fontFamily: Typography.default().fontFamily,
                    lineHeight: '1.4',
                    scrollbarWidth: 'none',
                }}
                placeholder={placeholder}
                value={value}
                onChange={(e) => onChangeText(e.target.value)}
                onKeyDown={handleKeyDown}
                maxRows={maxRows}
                autoCapitalize="sentences"
                autoCorrect="on"
                autoComplete="off"
            />
        </View>
    );
});