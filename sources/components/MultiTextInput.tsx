import * as React from 'react';
import { TextInput, Platform, View, NativeSyntheticEvent, TextInputKeyPressEventData, TextInputSelectionChangeEventData } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

export type SupportedKey = 'Enter' | 'Escape' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Tab';

export interface KeyPressEvent {
    key: SupportedKey;
    shiftKey: boolean;
}

export type OnKeyPressCallback = (event: KeyPressEvent) => boolean;

export interface TextInputState {
    text: string;
    selection: {
        start: number;
        end: number;
    };
}

export interface MultiTextInputHandle {
    setTextAndSelection: (text: string, selection: { start: number; end: number }) => void;
    focus: () => void;
    blur: () => void;
}

interface MultiTextInputProps {
    value: string;
    onChangeText: (text: string) => void;
    placeholder?: string;
    maxHeight?: number;
    paddingTop?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    paddingRight?: number;
    onKeyPress?: OnKeyPressCallback;
    onSelectionChange?: (selection: { start: number; end: number }) => void;
    onStateChange?: (state: TextInputState) => void;
}

export const MultiTextInput = React.forwardRef<MultiTextInputHandle, MultiTextInputProps>((props, ref) => {
    const {
        value,
        onChangeText,
        placeholder,
        maxHeight = 120,
        onKeyPress,
        onSelectionChange,
        onStateChange
    } = props;

    const { theme } = useUnistyles();
    // Track latest selection in a ref
    const selectionRef = React.useRef({ start: 0, end: 0 });
    const inputRef = React.useRef<TextInput>(null);

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

    const handleTextChange = React.useCallback((text: string) => {
        // When text changes, assume cursor moves to end
        const selection = { start: text.length, end: text.length };
        selectionRef.current = selection;
        
        console.log('📝 MultiTextInput.native: Text changed:', JSON.stringify({ text, selection }));
        
        onChangeText(text);
        
        if (onStateChange) {
            onStateChange({ text, selection });
        }
        if (onSelectionChange) {
            onSelectionChange(selection);
        }
    }, [onChangeText, onStateChange, onSelectionChange]);

    const handleSelectionChange = React.useCallback((e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
        if (e.nativeEvent.selection) {
            const { start, end } = e.nativeEvent.selection;
            const selection = { start, end };
            
            // Only update if selection actually changed
            if (selection.start !== selectionRef.current.start || selection.end !== selectionRef.current.end) {
                selectionRef.current = selection;
                console.log('📍 MultiTextInput.native: Selection changed:', JSON.stringify(selection));
                
                if (onSelectionChange) {
                    onSelectionChange(selection);
                }
                if (onStateChange) {
                    onStateChange({ text: value, selection });
                }
            }
        }
    }, [value, onSelectionChange, onStateChange]);

    // Imperative handle for direct control
    React.useImperativeHandle(ref, () => ({
        setTextAndSelection: (text: string, selection: { start: number; end: number }) => {
            console.log('🎯 MultiTextInput.native: setTextAndSelection:', JSON.stringify({ text, selection }));
            
            if (inputRef.current) {
                // Use setNativeProps for direct manipulation
                inputRef.current.setNativeProps({
                    text: text,
                    selection: selection
                });
                
                // Update our ref
                selectionRef.current = selection;
                
                // Notify through callbacks
                onChangeText(text);
                if (onStateChange) {
                    onStateChange({ text, selection });
                }
                if (onSelectionChange) {
                    onSelectionChange(selection);
                }
            }
        },
        focus: () => {
            inputRef.current?.focus();
        },
        blur: () => {
            inputRef.current?.blur();
        }
    }), [onChangeText, onStateChange, onSelectionChange]);

    return (
        <View style={{ width: '100%' }}>
            <TextInput
                ref={inputRef}
                style={{
                    width: '100%',
                    fontSize: 16,
                    maxHeight,
                    color: theme.colors.inputText,
                    textAlignVertical: 'center',
                    padding:0,
                    paddingTop: props.paddingTop,
                    paddingBottom: props.paddingBottom,
                    paddingLeft: props.paddingLeft,
                    paddingRight: props.paddingRight,
                    ...Typography.default(),
                }}
                placeholder={placeholder}
                placeholderTextColor={theme.colors.inputPlaceholder}
                value={value}
                onChangeText={handleTextChange}
                onKeyPress={handleKeyPress}
                onSelectionChange={handleSelectionChange}
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

MultiTextInput.displayName = 'MultiTextInput';