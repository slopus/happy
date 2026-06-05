import * as React from 'react';
import { Text, TextInput, Platform, View, NativeSyntheticEvent, TextInputKeyPressEventData, TextInputSelectionChangeEventData } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

export type SupportedKey = 'Enter' | 'Escape' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Tab';

export interface KeyPressEvent {
    key: SupportedKey;
    shiftKey: boolean;
}

export type OnKeyPressCallback = (event: KeyPressEvent) => boolean;

export const MULTI_TEXT_INPUT_FONT_SIZE = 16;
export const MULTI_TEXT_INPUT_LINE_HEIGHT = 22;

export interface TextInputState {
    text: string;
    selection: {
        start: number;
        end: number;
    };
}

export interface MultiTextInputHandle {
    getText: () => string;
    setTextAndSelection: (text: string, selection: { start: number; end: number }) => void;
    focus: () => void;
    blur: () => void;
}

// Either `value` (controlled) or `defaultValue` (uncontrolled) must be set.
// "Uncontrolled" here means uncontrolled *from the parent's perspective*: the
// parent never passes `value`, so it never re-renders on every keystroke (the
// perf goal). Internally the native input is always `value`-driven, because on
// the New Architecture (Fabric) `setNativeProps({ text })` is a no-op — driving
// `value` is the only text path that actually clears/replaces the field.
interface MultiTextInputProps {
    value?: string;
    defaultValue?: string;
    onChangeText?: (text: string) => void;
    placeholder?: string;
    editable?: boolean;
    maxHeight?: number;
    lineHeight?: number;
    paddingTop?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    paddingRight?: number;
    onKeyPress?: OnKeyPressCallback;
    onSelectionChange?: (selection: { start: number; end: number }) => void;
    onStateChange?: (state: TextInputState) => void;
}

export const MultiTextInput = React.memo(React.forwardRef<MultiTextInputHandle, MultiTextInputProps>((props, ref) => {
    const {
        value,
        defaultValue,
        onChangeText,
        placeholder,
        editable = true,
        maxHeight = 120,
        lineHeight = MULTI_TEXT_INPUT_LINE_HEIGHT,
        onKeyPress,
        onSelectionChange,
        onStateChange
    } = props;

    const isControlled = value !== undefined;
    const isControlledRef = React.useRef(isControlled);
    isControlledRef.current = isControlled;
    const { theme } = useUnistyles();
    // Track latest selection in a ref
    const selectionRef = React.useRef({ start: 0, end: 0 });
    const inputRef = React.useRef<TextInput>(null);
    // In uncontrolled mode we own the text locally and bind it to the native
    // input's `value`. Keystrokes update this state (re-rendering only this
    // small component, never the parent), and imperative sets flow through it
    // too — the only mutation path Fabric honors.
    const [uncontrolledText, setUncontrolledText] = React.useState<string>(defaultValue ?? '');
    const text = isControlled ? value! : uncontrolledText;
    // Synchronous mirror so imperative getText() never lags a state commit.
    const latestTextRef = React.useRef<string>(text);
    latestTextRef.current = text;
    // Caret to apply after an imperative text set. Applied in a layout effect
    // so it runs once the new `value` is committed to the native view, using
    // TextInput.setSelection() (Fabric's supported imperative caret API).
    const pendingSelectionRef = React.useRef<{ start: number; end: number } | null>(null);
    const [, bumpSelectionTick] = React.useReducer((c: number) => c + 1, 0);
    React.useLayoutEffect(() => {
        const sel = pendingSelectionRef.current;
        if (sel && inputRef.current) {
            pendingSelectionRef.current = null;
            inputRef.current.setSelection(sel.start, sel.end);
        }
    });
    const textStyle = {
        width: '100%' as const,
        fontSize: MULTI_TEXT_INPUT_FONT_SIZE,
        lineHeight,
        maxHeight,
        color: theme.colors.input.text,
        textAlignVertical: 'top' as const,
        padding: 0,
        paddingTop: props.paddingTop,
        paddingBottom: props.paddingBottom,
        paddingLeft: props.paddingLeft,
        paddingRight: props.paddingRight,
        opacity: editable ? 1 : 0.58,
        ...Typography.default(),
    };

    React.useEffect(() => {
        if (!editable) {
            inputRef.current?.blur();
        }
    }, [editable]);

    const handleKeyPress = React.useCallback((e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
        if (!editable || !onKeyPress) return;

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
    }, [editable, onKeyPress]);

    const handleTextChange = React.useCallback((text: string) => {
        latestTextRef.current = text;
        if (!isControlledRef.current) {
            setUncontrolledText(text);
        }
        // When text changes, assume cursor moves to end
        const selection = { start: text.length, end: text.length };
        selectionRef.current = selection;

        onChangeText?.(text);

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

                if (onSelectionChange) {
                    onSelectionChange(selection);
                }
                if (onStateChange) {
                    onStateChange({ text: latestTextRef.current, selection });
                }
            }
        }
    }, [onSelectionChange, onStateChange]);

    // Imperative handle for direct control
    React.useImperativeHandle(ref, () => ({
        getText: () => latestTextRef.current,
        setTextAndSelection: (text: string, selection: { start: number; end: number }) => {
            // Drive the native input through `value` — Fabric ignores
            // setNativeProps({ text }), so this is the only path that actually
            // clears/replaces the field. The caret is applied in the layout
            // effect once the new text is committed natively. bumpSelectionTick
            // forces a render even when the text is unchanged (e.g. Escape
            // collapsing the autocomplete selection) so the caret still applies.
            latestTextRef.current = text;
            selectionRef.current = selection;
            pendingSelectionRef.current = selection;
            if (!isControlledRef.current) {
                setUncontrolledText(text);
            }
            bumpSelectionTick();

            // Notify through callbacks
            onChangeText?.(text);
            if (onStateChange) {
                onStateChange({ text, selection });
            }
            if (onSelectionChange) {
                onSelectionChange(selection);
            }
        },
        focus: () => {
            inputRef.current?.focus();
        },
        blur: () => {
            inputRef.current?.blur();
        }
    }), [onChangeText, onStateChange, onSelectionChange]);

    const displayText = text;

    return (
        <View style={{ width: '100%' }}>
            {editable ? (
                <TextInput
                    ref={inputRef}
                    style={textStyle}
                    placeholder={placeholder}
                    placeholderTextColor={theme.colors.input.placeholder}
                    value={text}
                    editable={editable}
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
            ) : (
                <View pointerEvents="none">
                    <Text
                        style={[
                            textStyle,
                            {
                                color: displayText ? theme.colors.input.text : theme.colors.input.placeholder,
                            },
                        ]}
                    >
                        {displayText || placeholder || ' '}
                    </Text>
                </View>
            )}
        </View>
    );
}));

MultiTextInput.displayName = 'MultiTextInput';
