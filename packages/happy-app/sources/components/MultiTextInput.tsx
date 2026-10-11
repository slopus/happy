import * as React from 'react';
import { Text, TextInput, Platform, View, NativeSyntheticEvent, TextInputChangeEvent, TextInputKeyPressEventData, TextInputSelectionChangeEventData, codegenNativeCommands } from 'react-native';
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
// "Uncontrolled" means uncontrolled from the parent's perspective: the parent
// never passes `value`, so it never re-renders on every keystroke. How the
// native field itself is driven differs by platform; see NativeTextField
// (iOS) and ValueTextField (Android) below.
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
    multiline?: boolean;
    returnKeyType?: React.ComponentProps<typeof TextInput>['returnKeyType'];
    submitBehavior?: React.ComponentProps<typeof TextInput>['submitBehavior'];
    onSubmitEditing?: () => void;
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
        multiline = true,
        returnKeyType = 'default',
        submitBehavior = multiline ? 'newline' : 'blurAndSubmit',
        onSubmitEditing,
        onKeyPress,
        onSelectionChange,
        onStateChange
    } = props;

    const { theme } = useUnistyles();
    // Track latest selection in a ref
    const selectionRef = React.useRef({ start: 0, end: 0 });
    const fieldRef = React.useRef<TextFieldHandle>(null);
    // Synchronous mirror of the text, so imperative getText() never lags a
    // state commit.
    const latestTextRef = React.useRef<string>(value ?? defaultValue ?? '');
    if (value !== undefined) {
        latestTextRef.current = value;
    }
    // The read-only branch has no field to write to, so a write made while it
    // is showing renders the new text instead.
    const [, renderReadOnlyText] = React.useReducer((c: number) => c + 1, 0);

    const textStyle = {
        width: '100%' as const,
        fontSize: MULTI_TEXT_INPUT_FONT_SIZE,
        lineHeight,
        maxHeight,
        color: theme.colors.input.text,
        textAlignVertical: multiline ? 'top' as const : 'center' as const,
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
            fieldRef.current?.blur();
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
            latestTextRef.current = text;
            selectionRef.current = selection;
            if (fieldRef.current) {
                fieldRef.current.setTextAndSelection(text, selection);
            } else {
                renderReadOnlyText();
            }

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
            fieldRef.current?.focus();
        },
        blur: () => {
            fieldRef.current?.blur();
        }
    }), [onChangeText, onStateChange, onSelectionChange]);

    const displayText = latestTextRef.current;
    const TextField = Platform.OS === 'ios' ? NativeTextField : ValueTextField;

    return (
        <View style={{ width: '100%' }}>
            {editable ? (
                <TextField
                    ref={fieldRef}
                    value={value}
                    initialText={latestTextRef.current}
                    style={textStyle}
                    placeholder={placeholder}
                    placeholderTextColor={theme.colors.input.placeholder}
                    editable={editable}
                    onChangeText={handleTextChange}
                    onKeyPress={handleKeyPress}
                    onSelectionChange={handleSelectionChange}
                    multiline={multiline}
                    autoCapitalize="sentences"
                    autoCorrect={true}
                    keyboardType="default"
                    returnKeyType={returnKeyType}
                    autoComplete="off"
                    textContentType="none"
                    submitBehavior={submitBehavior}
                    onSubmitEditing={onSubmitEditing}
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

interface TextFieldHandle {
    setTextAndSelection: (text: string, selection: { start: number; end: number }) => void;
    focus: () => void;
    blur: () => void;
}

type TextFieldProps = Omit<React.ComponentProps<typeof TextInput>, 'value' | 'defaultValue' | 'onChange' | 'onChangeText'> & {
    // The parent's text in controlled mode, undefined when uncontrolled.
    value: string | undefined;
    // The text a newly mounted field starts with (editable turning back on
    // mounts a new one).
    initialText: string;
    onChangeText: (text: string) => void;
};

// The command React Native's own TextInput uses for clear() and setSelection().
// Native applies it only when `eventCount` matches the edits it has reported,
// so a write never lands on top of a keystroke JS has not seen yet.
interface TextInputNativeCommands {
    setTextAndSelection: (
        ref: React.ComponentRef<typeof TextInput>,
        eventCount: number,
        text: string | null,
        start: number,
        end: number,
    ) => void;
}

const TextInputCommands = codegenNativeCommands<TextInputNativeCommands>({
    supportedCommands: ['setTextAndSelection'],
});

// iOS: the native view owns its text. It is seeded once on mount and never
// handed a `value` prop; writes from JS (an imperative set, or a controlled
// `value` that differs from what the field last reported) go through the
// native setTextAndSelection command.
//
// Why not `value`: on Fabric, every render that changes the `value` prop
// rebuilds the field's text from JS. The shadow node then measures that JS
// copy instead of the field's own text, tagged with whichever edit JS had
// seen, and iOS re-applies it to the UITextView whenever its attributes differ
// (autocorrect, emoji fonts...). Re-setting `attributedText` restores the caret
// relative to the end of the text and scrolls to it, and a JS copy a keystroke
// behind sizes the field for the previous text. Done on every keystroke, that
// was a multiline composer that jumped while editing mid-text and sometimes
// kept a blank line under the text.
//
// One catch: a field that mounts empty never grows. The shadow node only
// sizes itself from the field's own text once it has taken its text from the
// React tree at least once (BaseTextInputShadowNode: until then its state has
// no font-size multiplier, so `attributedStringBoxToMeasure` keeps measuring
// the React tree's text, which is empty, i.e. one line). An empty React tree
// text never counts as a change, so that never happens on its own. The first
// non-empty text the field gets, typed or written, is therefore handed to the
// React tree, once: it is what the field already holds, so native has nothing
// to apply, and from then on the shadow node measures the field's own text.
const NativeTextField = React.forwardRef<TextFieldHandle, TextFieldProps>(({ value, initialText, onChangeText, ...inputProps }, ref) => {
    const inputRef = React.useRef<TextInput>(null);
    const [defaultValue, setDefaultValue] = React.useState(initialText);
    const treeHasTextRef = React.useRef(initialText !== '');
    const eventCountRef = React.useRef(0);
    // What the native view holds: its last reported edit, or the last write.
    const nativeTextRef = React.useRef(initialText);

    const giveTreeText = React.useCallback((text: string) => {
        if (text !== '' && !treeHasTextRef.current) {
            treeHasTextRef.current = true;
            setDefaultValue(text);
        }
    }, []);

    const setTextAndSelection = React.useCallback((text: string, selection: { start: number; end: number }) => {
        nativeTextRef.current = text;
        giveTreeText(text);
        if (inputRef.current) {
            TextInputCommands.setTextAndSelection(inputRef.current, eventCountRef.current, text, selection.start, selection.end);
        }
    }, [giveTreeText]);

    // Controlled mode: write the parent's value only when the parent changed
    // it, not when it echoes a keystroke back. A -1 selection leaves the caret
    // where native puts it, as React Native does for a controlled value.
    React.useLayoutEffect(() => {
        if (value !== undefined && value !== nativeTextRef.current) {
            setTextAndSelection(value, { start: -1, end: -1 });
        }
    }, [value, setTextAndSelection]);

    const handleChange = React.useCallback((e: TextInputChangeEvent) => {
        const text = e.nativeEvent.text;
        eventCountRef.current = e.nativeEvent.eventCount;
        nativeTextRef.current = text;
        giveTreeText(text);
        onChangeText(text);
    }, [onChangeText, giveTreeText]);

    React.useImperativeHandle(ref, () => ({
        setTextAndSelection,
        focus: () => {
            inputRef.current?.focus();
        },
        blur: () => {
            inputRef.current?.blur();
        },
    }), [setTextAndSelection]);

    return (
        <TextInput
            ref={inputRef}
            {...inputProps}
            defaultValue={defaultValue}
            onChange={handleChange}
        />
    );
});

NativeTextField.displayName = 'NativeTextField';

// Android: the field is bound to `value`, from the parent when controlled and
// from local state otherwise. On Fabric, setNativeProps({ text }) is a no-op,
// and the native setTextAndSelection command updates the text without telling
// the shadow node, so a field written that way keeps its old height. A `value`
// change is the write path that also re-measures. The caret for an imperative
// set is applied once the new value is committed.
const ValueTextField = React.forwardRef<TextFieldHandle, TextFieldProps>(({ value, initialText, onChangeText, ...inputProps }, ref) => {
    const inputRef = React.useRef<TextInput>(null);
    const isControlledRef = React.useRef(value !== undefined);
    isControlledRef.current = value !== undefined;
    const [ownText, setOwnText] = React.useState(initialText);
    const pendingSelectionRef = React.useRef<{ start: number; end: number } | null>(null);
    // Forces a render even when the text is unchanged (e.g. Escape collapsing
    // the autocomplete selection) so the caret still applies.
    const [, bumpSelectionTick] = React.useReducer((c: number) => c + 1, 0);
    React.useLayoutEffect(() => {
        const sel = pendingSelectionRef.current;
        if (sel && inputRef.current) {
            pendingSelectionRef.current = null;
            inputRef.current.setSelection(sel.start, sel.end);
        }
    });

    const handleChangeText = React.useCallback((text: string) => {
        if (!isControlledRef.current) {
            setOwnText(text);
        }
        onChangeText(text);
    }, [onChangeText]);

    React.useImperativeHandle(ref, () => ({
        setTextAndSelection: (text, selection) => {
            pendingSelectionRef.current = selection;
            if (!isControlledRef.current) {
                setOwnText(text);
            }
            bumpSelectionTick();
        },
        focus: () => {
            inputRef.current?.focus();
        },
        blur: () => {
            inputRef.current?.blur();
        },
    }), []);

    return (
        <TextInput
            ref={inputRef}
            {...inputProps}
            value={value ?? ownText}
            onChangeText={handleChangeText}
        />
    );
});

ValueTextField.displayName = 'ValueTextField';
