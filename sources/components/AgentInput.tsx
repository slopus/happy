import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { View, Platform, useWindowDimensions, ViewStyle, Text, Animated, ActivityIndicator } from 'react-native';
import { Pressable } from 'react-native-gesture-handler';
import { layout } from './layout';
import { MultiTextInput, KeyPressEvent } from './MultiTextInput';
import { Typography } from '@/constants/Typography';
import { PermissionModeSelector, PermissionMode } from './PermissionModeSelector';
import { hapticsLight, hapticsError } from './haptics';
import { Shaker, ShakeInstance } from './Shaker';
import { StatusDot } from './StatusDot';
import { useActiveWord } from './autocomplete/useActiveWord';
import { useActiveSuggestions } from './autocomplete/useActiveSuggestions';
import { AgentInputAutocomplete } from './AgentInputAutocomplete';
import { TextInputState, MultiTextInputHandle } from './MultiTextInput';
import { applySuggestion } from './autocomplete/applySuggestion';

interface AgentInputProps {
    value: string;
    placeholder: string;
    onChangeText: (text: string) => void;
    onSend: () => void;
    sendIcon?: React.ReactNode;
    onMicPress?: () => void;
    isMicActive?: boolean;
    permissionMode?: PermissionMode;
    onPermissionModeChange?: (mode: PermissionMode) => void;
    onAbort?: () => void | Promise<void>;
    showAbortButton?: boolean;
    connectionStatus?: {
        text: string;
        color: string;
        dotColor: string;
        isPulsing?: boolean;
    };
    autocompletePrefixes: string[];
    autocompleteSuggestions: (query: string) => Promise<{ key: string, text: string, component: React.ElementType }[]>;
}

export const AgentInput = React.memo((props: AgentInputProps) => {
    const screenWidth = useWindowDimensions().width;

    const hasText = props.value.trim().length > 0;

    // Color animation for send button
    const sendButtonColorAnim = React.useRef(new Animated.Value(0)).current;

    // Double press abort button states
    const [isFirstPress, setIsFirstPress] = React.useState(false);
    const [isAborting, setIsAborting] = React.useState(false);
    const resetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const abortButtonBgAnim = React.useRef(new Animated.Value(0)).current;
    const shakerRef = React.useRef<ShakeInstance>(null);
    const inputRef = React.useRef<MultiTextInputHandle>(null);

    // Autocomplete state - track text and selection together
    const [inputState, setInputState] = React.useState<TextInputState>({
        text: props.value,
        selection: { start: 0, end: 0 }
    });

    // Handle combined text and selection state changes
    const handleInputStateChange = React.useCallback((newState: TextInputState) => {
        console.log('📝 Input state changed:', JSON.stringify(newState));
        setInputState(newState);
    }, []);

    // Use the tracked selection from inputState
    const activeWord = useActiveWord(inputState.text, inputState.selection, props.autocompletePrefixes);
    // Using default options: clampSelection=true, autoSelectFirst=true, wrapAround=true
    // To customize: useActiveSuggestions(activeWord, props.autocompleteSuggestions, { clampSelection: false, wrapAround: false })
    const [suggestions, selected, moveUp, moveDown] = useActiveSuggestions(activeWord, props.autocompleteSuggestions, { clampSelection: true, wrapAround: true });

    // Debug logging
    // React.useEffect(() => {
    //     console.log('🔍 Autocomplete Debug:', JSON.stringify({
    //         value: props.value,
    //         inputState,
    //         activeWord,
    //         suggestionsCount: suggestions.length,
    //         selected,
    //         prefixes: props.autocompletePrefixes
    //     }, null, 2));
    // }, [props.value, inputState, activeWord, suggestions.length, selected]);

    // Handle suggestion selection
    const handleSuggestionSelect = React.useCallback((index: number) => {
        if (!suggestions[index] || !inputRef.current) return;

        const suggestion = suggestions[index];

        // Apply the suggestion
        const result = applySuggestion(
            inputState.text,
            inputState.selection,
            suggestion.text,
            props.autocompletePrefixes,
            true // add space after
        );

        // Use imperative API to set text and selection
        inputRef.current.setTextAndSelection(result.text, {
            start: result.cursorPosition,
            end: result.cursorPosition
        });

        console.log('Selected suggestion:', suggestion.text);

        // Small haptic feedback
        hapticsLight();
    }, [suggestions, inputState, props.autocompletePrefixes]);

    // Handle keyboard navigation
    const handleKeyPress = React.useCallback((event: KeyPressEvent): boolean => {
        // Handle autocomplete navigation first
        if (suggestions.length > 0) {
            if (event.key === 'ArrowUp') {
                moveUp();
                return true;
            } else if (event.key === 'ArrowDown') {
                moveDown();
                return true;
            } else if ((event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))) {
                // Both Enter and Tab select the current suggestion
                // If none selected (selected === -1), select the first one
                const indexToSelect = selected >= 0 ? selected : 0;
                handleSuggestionSelect(indexToSelect);
                return true;
            } else if (event.key === 'Escape') {
                // Close suggestions
                // TODO: Clear suggestions
                return true;
            }
        }

        // Original key handling
        if (Platform.OS === 'web') {
            if (event.key === 'Enter' && !event.shiftKey) {
                if (props.value.trim()) {
                    props.onSend();
                    return true; // Key was handled
                }
            }
            // Handle Shift+Tab for mode switching
            if (event.key === 'Tab' && event.shiftKey && props.onPermissionModeChange) {
                const modeOrder: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
                const currentIndex = modeOrder.indexOf(props.permissionMode || 'default');
                const nextIndex = (currentIndex + 1) % modeOrder.length;
                props.onPermissionModeChange(modeOrder[nextIndex]);
                hapticsLight();
                return true; // Key was handled, prevent default tab behavior
            }
        }
        return false; // Key was not handled
    }, [props.value, props.onSend, props.permissionMode, props.onPermissionModeChange, suggestions, selected, handleSuggestionSelect, moveUp, moveDown]);

    const handleAbortPress = React.useCallback(async () => {
        if (!props.onAbort) return;

        if (!isFirstPress) {
            // First press - show "Press again" and set timer
            hapticsLight();
            setIsFirstPress(true);

            // Reset after 2 seconds if no second press
            resetTimerRef.current = setTimeout(() => {
                setIsFirstPress(false);
            }, 2000);
        } else {
            // Second press - execute abort
            hapticsError();

            // Clear the reset timer
            if (resetTimerRef.current) {
                clearTimeout(resetTimerRef.current);
                resetTimerRef.current = null;
            }

            // Animate background color to red
            Animated.timing(abortButtonBgAnim, {
                toValue: 1,
                duration: 200,
                useNativeDriver: false,
            }).start();

            setIsAborting(true);
            const startTime = Date.now();

            try {
                await props.onAbort?.();

                // Ensure minimum 300ms loading time
                const elapsed = Date.now() - startTime;
                if (elapsed < 300) {
                    await new Promise(resolve => setTimeout(resolve, 300 - elapsed));
                }
            } catch (error) {
                // Shake on error
                shakerRef.current?.shake();
                console.error('Abort RPC call failed:', error);
            } finally {
                // Animate back to normal
                Animated.timing(abortButtonBgAnim, {
                    toValue: 0,
                    duration: 200,
                    useNativeDriver: false,
                }).start(() => {
                    setIsAborting(false);
                    setIsFirstPress(false);
                });
            }
        }
    }, [props.onAbort, isFirstPress, abortButtonBgAnim]);

    // Animate send button color based on hasText
    React.useEffect(() => {
        Animated.timing(sendButtonColorAnim, {
            toValue: hasText ? 1 : 0,
            duration: 150,
            useNativeDriver: false,
        }).start();
    }, [hasText]);

    // Clean up timer on unmount
    React.useEffect(() => {
        return () => {
            if (resetTimerRef.current) {
                clearTimeout(resetTimerRef.current);
            }
        };
    }, []);

    const containerStyle: ViewStyle = {
        alignItems: 'center',
        paddingHorizontal: screenWidth > 700 ? 16 : 8,
        paddingBottom: 8,
        paddingTop: 8,
    };

    const inputContainerStyle: ViewStyle = {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: Platform.select({ default: 24, android: 28 })!,
        overflow: 'hidden',
        backgroundColor: '#F5F5F5',
        borderWidth: 0,
        paddingLeft: 16,
        paddingRight: 5,
        paddingVertical: 0,
        minHeight: 48,
    };

    const inputWrapperStyle: ViewStyle = {
        flex: 1,
        paddingVertical: 10,
        paddingRight: 12,
        paddingLeft: 4
    };
    return (
        <View style={containerStyle}>
            <View style={{ width: '100%', maxWidth: layout.maxWidth, position: 'relative' }}>
                {/* Autocomplete suggestions overlay */}
                {suggestions.length > 0 && (
                    <View style={{
                        position: 'absolute',
                        bottom: '100%',
                        left: 0,
                        right: 0,
                        marginBottom: 8,
                        zIndex: 1000,
                        paddingHorizontal: screenWidth > 700 ? 0 : 8,
                    }}>
                        <AgentInputAutocomplete
                            suggestions={suggestions.map(s => {
                                const Component = s.component;
                                return <Component key={s.key} />;
                            })}
                            selectedIndex={selected}
                            onSelect={handleSuggestionSelect}
                            itemHeight={48}
                        />
                    </View>
                )}

                {/* Connection status and permission mode */}
                {(props.connectionStatus || (props.permissionMode && props.permissionMode !== 'default')) && (
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingHorizontal: 16,
                        paddingBottom: 4,
                    }}>
                        {props.connectionStatus && (
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <StatusDot
                                    color={props.connectionStatus.dotColor}
                                    isPulsing={props.connectionStatus.isPulsing}
                                    size={6}
                                    style={{ marginRight: 6 }}
                                />
                                <Text style={{
                                    fontSize: 11,
                                    color: props.connectionStatus.color,
                                    ...Typography.default()
                                }}>
                                    {props.connectionStatus.text}
                                </Text>
                            </View>
                        )}
                        {props.permissionMode && props.permissionMode !== 'default' && (
                            <Text style={{
                                fontSize: 11,
                                color: props.permissionMode === 'acceptEdits' ? '#007AFF' :
                                    props.permissionMode === 'bypassPermissions' ? '#FF9500' :
                                        props.permissionMode === 'plan' ? '#34C759' : '#8E8E93',
                                ...Typography.default()
                            }}>
                                {props.permissionMode === 'acceptEdits' ? 'Accept All Edits' :
                                    props.permissionMode === 'bypassPermissions' ? 'Bypass All Permissions' :
                                        props.permissionMode === 'plan' ? 'Plan Mode' : ''}
                            </Text>
                        )}
                    </View>
                )}
                {/* Input field */}
                <View style={inputContainerStyle}>
                    <View style={inputWrapperStyle}>
                        <MultiTextInput
                            ref={inputRef}
                            value={props.value}
                            onChangeText={props.onChangeText}
                            placeholder={props.placeholder}
                            onKeyPress={handleKeyPress}
                            onStateChange={handleInputStateChange}
                            maxHeight={120}
                        />
                    </View>

                    {/* Send button */}
                    <Animated.View
                        style={{
                            backgroundColor: sendButtonColorAnim.interpolate({
                                inputRange: [0, 1],
                                outputRange: ['#E0E0E0', 'black']
                            }),
                            width: 36,
                            height: 36,
                            borderRadius: 18,
                            marginRight: 4,
                        }}
                    >
                        <Pressable
                            style={(p) => ({
                                width: '100%',
                                height: '100%',
                                alignItems: 'center',
                                justifyContent: 'center',
                                opacity: p.pressed ? 0.7 : 1,
                            })}
                            onPress={() => {
                                hapticsLight();
                                props.onSend();
                            }}
                            disabled={!hasText}
                        >
                            <Ionicons name="arrow-up" size={20} color="#fff" />
                        </Pressable>
                    </Animated.View>
                </View>

                {/* Action buttons below input */}
                <View style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginTop: 12,
                    paddingHorizontal: 8,
                }}>
                    {/* Permission mode selector */}
                    {props.onPermissionModeChange && (
                        <PermissionModeSelector
                            mode={props.permissionMode || 'default'}
                            onModeChange={props.onPermissionModeChange}
                        />
                    )}


                    {/* Voice Assistant button */}
                    {props.onMicPress && (
                        <Pressable
                            style={(p) => ({
                                flexDirection: 'row',
                                alignItems: 'center',
                                // backgroundColor: props.isMicActive ? '#000' : Platform.select({
                                //     ios: '#F2F2F7',
                                //     android: '#E0E0E0',
                                //     default: '#F2F2F7'
                                // }),
                                borderRadius: Platform.select({ default: 16, android: 20 }),
                                paddingHorizontal: 12,
                                paddingVertical: 6,
                                width: 120,
                                justifyContent: 'center',
                                height: 32,
                                opacity: p.pressed ? 0.7 : 1,
                            })}
                            onPress={() => {
                                hapticsLight();
                                props.onMicPress?.();
                            }}
                        >
                            <Ionicons
                                name={props.isMicActive ? "stop" : "mic"}
                                size={16}
                                color={'#000'}
                                style={{ marginRight: 4 }}
                            />
                            <Text style={{
                                fontSize: 13,
                                color: '#000',
                                fontWeight: '600',
                                ...Typography.default('semiBold')
                            }}>
                                {props.isMicActive ? 'Hang up' : 'Call Happy'}
                            </Text>
                        </Pressable>
                    )}

                    {/* Abort button */}
                    {props.onAbort && (
                        <Shaker ref={shakerRef}>
                            <Animated.View
                                style={{
                                    // backgroundColor: abortButtonBgAnim.interpolate({
                                    //     inputRange: [0, 1],
                                    //     outputRange: [
                                    //         Platform.select({ ios: '#F2F2F7', android: '#E0E0E0', default: '#F2F2F7' })!,
                                    //         Platform.select({ ios: '#FF3B30', android: '#F44336', default: '#FF3B30' })!
                                    //     ]
                                    // }),
                                    borderRadius: Platform.select({ default: 16, android: 20 }),
                                }}
                            >
                                <Pressable
                                    style={{
                                        paddingHorizontal: 12,
                                        paddingVertical: 6,
                                        minWidth: 80,
                                        height: 32,
                                        width: 120,
                                        flexDirection: 'row',
                                        justifyContent: 'center',
                                        alignItems: 'center',
                                    }}
                                    onPress={handleAbortPress}
                                    disabled={isAborting}
                                >
                                    {isAborting ? (
                                        <ActivityIndicator
                                            size="small"
                                            color={Platform.select({ ios: '#FF9500', android: '#FF6F00', default: '#FF9500' })}
                                        />
                                    ) : (
                                        <>
                                            {!isFirstPress ? <Ionicons
                                                name={"stop"}
                                                size={16}
                                                color={isFirstPress ? '#FF9500' : 'black'}
                                                style={{ marginRight: 4 }}
                                            /> : <Text style={{
                                                fontSize: 13,
                                                color: isFirstPress
                                                    ? Platform.select({ ios: '#FF9500', android: '#FF6F00', default: '#FF9500' })!
                                                    : '#000',
                                                fontWeight: '600',
                                                ...Typography.default('semiBold')
                                            }}>
                                                Again
                                            </Text>}

                                            {/* <Text style={{
                                                fontSize: 13,
                                                color: isFirstPress
                                                    ? Platform.select({ ios: '#FF9500', android: '#FF6F00', default: '#FF9500' })!
                                                    : '#000',
                                                fontWeight: '600',
                                                ...Typography.default('semiBold')
                                            }}>
                                                {isFirstPress ? 'Again' : 'Abort'}
                                            </Text> */}
                                        </>
                                    )}
                                </Pressable>
                            </Animated.View>
                        </Shaker>
                    )}
                </View>
            </View>
        </View>
    );
});