import { Ionicons, Octicons } from '@expo/vector-icons';
import * as React from 'react';
import { View, Platform, useWindowDimensions, ViewStyle, Text, ActivityIndicator, TouchableWithoutFeedback } from 'react-native';
import { Image } from 'expo-image';
import { Pressable } from 'react-native-gesture-handler';
import { layout } from './layout';
import { MultiTextInput, KeyPressEvent } from './MultiTextInput';
import { Typography } from '@/constants/Typography';
import { PermissionMode, ModelMode } from './PermissionModeSelector';
import { hapticsLight, hapticsError } from './haptics';
import { Shaker, ShakeInstance } from './Shaker';
import { StatusDot } from './StatusDot';
import { useActiveWord } from './autocomplete/useActiveWord';
import { useActiveSuggestions } from './autocomplete/useActiveSuggestions';
import { AgentInputAutocomplete } from './AgentInputAutocomplete';
import { FloatingOverlay } from './FloatingOverlay';
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
    modelMode?: ModelMode;
    onModelModeChange?: (mode: ModelMode) => void;
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
    usageData?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
    };
    alwaysShowContextSize?: boolean;
    onFileViewerPress?: () => void;
}

const MAX_CONTEXT_SIZE = 190000;

const getContextWarning = (contextSize: number, alwaysShow: boolean = false) => {
    const percentageUsed = (contextSize / MAX_CONTEXT_SIZE) * 100;
    const percentageRemaining = Math.max(0, Math.min(100, 100 - percentageUsed));
    
    if (percentageRemaining <= 5) {
        return { text: `${Math.round(percentageRemaining)}% left`, color: '#FF3B30' }; // Red
    } else if (percentageRemaining <= 10) {
        return { text: `${Math.round(percentageRemaining)}% left`, color: '#8E8E93' }; // Grey
    } else if (alwaysShow) {
        // Show context remaining in neutral color when not near limit
        return { text: `${Math.round(percentageRemaining)}% left`, color: '#8E8E93' }; // Grey
    }
    return null; // No display needed
};

export const AgentInput = React.memo((props: AgentInputProps) => {
    const screenWidth = useWindowDimensions().width;

    const hasText = props.value.trim().length > 0;

    // Calculate context warning
    const contextWarning = props.usageData?.contextSize 
        ? getContextWarning(props.usageData.contextSize, props.alwaysShowContextSize ?? false) 
        : null;


    // Abort button state
    const [isAborting, setIsAborting] = React.useState(false);
    const shakerRef = React.useRef<ShakeInstance>(null);
    const inputRef = React.useRef<MultiTextInputHandle>(null);

    // Autocomplete state - track text and selection together
    const [inputState, setInputState] = React.useState<TextInputState>({
        text: props.value,
        selection: { start: 0, end: 0 }
    });

    // Handle combined text and selection state changes
    const handleInputStateChange = React.useCallback((newState: TextInputState) => {
        // console.log('📝 Input state changed:', JSON.stringify(newState));
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

        // console.log('Selected suggestion:', suggestion.text);

        // Small haptic feedback
        hapticsLight();
    }, [suggestions, inputState, props.autocompletePrefixes]);

    // Settings modal state
    const [showSettings, setShowSettings] = React.useState(false);

    // Handle settings button press
    const handleSettingsPress = React.useCallback(() => {
        hapticsLight();
        setShowSettings(prev => !prev);
    }, []);

    // Handle settings selection
    const handleSettingsSelect = React.useCallback((mode: PermissionMode) => {
        hapticsLight();
        props.onPermissionModeChange?.(mode);
        // Don't close the settings overlay - let users see the change and potentially switch again
    }, [props.onPermissionModeChange]);

    // Handle model selection
    const handleModelSelect = React.useCallback((mode: ModelMode) => {
        hapticsLight();
        props.onModelModeChange?.(mode);
        // Don't close the settings overlay - let users see the change and potentially switch again
    }, [props.onModelModeChange]);

    // Handle abort button press
    const handleAbortPress = React.useCallback(async () => {
        if (!props.onAbort) return;

        hapticsError();
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
            setIsAborting(false);
        }
    }, [props.onAbort]);

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

        // Handle Escape for abort when no suggestions are visible
        if (event.key === 'Escape' && props.showAbortButton && props.onAbort && !isAborting) {
            handleAbortPress();
            return true;
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
    }, [props.value, props.onSend, props.permissionMode, props.onPermissionModeChange, suggestions, selected, handleSuggestionSelect, moveUp, moveDown, props.showAbortButton, props.onAbort, isAborting, handleAbortPress]);



    const containerStyle: ViewStyle = {
        alignItems: 'center',
        paddingHorizontal: screenWidth > 700 ? 16 : 8,
        paddingBottom: 8,
        paddingTop: 8,
    };

    const unifiedPanelStyle: ViewStyle = {
        backgroundColor: '#F5F5F5',
        borderRadius: Platform.select({ default: 16, android: 20 })!,
        overflow: 'hidden',
        paddingVertical: 2,
        paddingBottom: 8,
        paddingHorizontal: 8,
    };

    const inputContainerStyle: ViewStyle = {
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 0,
        paddingLeft: 8,
        paddingRight: 8,
        paddingVertical: 4,
        minHeight: 40
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

                {/* Settings overlay */}
                {showSettings && (
                    <>
                        <TouchableWithoutFeedback onPress={() => setShowSettings(false)}>
                            <View style={{
                                position: 'absolute',
                                top: -1000,
                                left: -1000,
                                right: -1000,
                                bottom: -1000,
                                zIndex: 999,
                            }} />
                        </TouchableWithoutFeedback>
                        <View style={{
                            position: 'absolute',
                            bottom: '100%',
                            left: 0,
                            right: 0,
                            marginBottom: 8,
                            zIndex: 1000,
                            paddingHorizontal: screenWidth > 700 ? 0 : 8,
                        }}>
                            <FloatingOverlay maxHeight={280} keyboardShouldPersistTaps="always">
                                {/* Permission Mode Section */}
                                <View style={{ paddingVertical: 8 }}>
                                    <Text style={{
                                        fontSize: 12,
                                        fontWeight: '600',
                                        color: '#666',
                                        paddingHorizontal: 16,
                                        paddingBottom: 4,
                                        ...Typography.default('semiBold')
                                    }}>
                                        PERMISSION MODE
                                    </Text>
                                    {(['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const).map((mode) => {
                                        const modeConfig = {
                                            default: { label: 'Default' },
                                            acceptEdits: { label: 'Accept Edits' },
                                            plan: { label: 'Plan Mode' },
                                            bypassPermissions: { label: 'Yolo Mode' },
                                        };
                                        const config = modeConfig[mode];
                                        const isSelected = props.permissionMode === mode;

                                        return (
                                            <Pressable
                                                key={mode}
                                                onPress={() => handleSettingsSelect(mode)}
                                                style={({ pressed }) => ({
                                                    flexDirection: 'row',
                                                    alignItems: 'center',
                                                    paddingHorizontal: 16,
                                                    paddingVertical: 8,
                                                    backgroundColor: pressed ? 'rgba(0, 0, 0, 0.05)' : 'transparent'
                                                })}
                                            >
                                                <View style={{
                                                    width: 16,
                                                    height: 16,
                                                    borderRadius: 8,
                                                    borderWidth: 2,
                                                    borderColor: isSelected ? '#007AFF' : '#C0C0C0',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    marginRight: 12
                                                }}>
                                                    {isSelected && (
                                                        <View style={{
                                                            width: 6,
                                                            height: 6,
                                                            borderRadius: 3,
                                                            backgroundColor: '#007AFF'
                                                        }} />
                                                    )}
                                                </View>
                                                <Text style={{
                                                    fontSize: 14,
                                                    color: isSelected ? '#007AFF' : '#000',
                                                    ...Typography.default()
                                                }}>
                                                    {config.label}
                                                </Text>
                                            </Pressable>
                                        );
                                    })}
                                </View>

                                {/* Divider */}
                                <View style={{
                                    height: 1,
                                    backgroundColor: '#F0F0F0',
                                    marginHorizontal: 16
                                }} />

                                {/* Model Section */}
                                <View style={{ paddingVertical: 8 }}>
                                    <Text style={{
                                        fontSize: 12,
                                        fontWeight: '600',
                                        color: '#666',
                                        paddingHorizontal: 16,
                                        paddingBottom: 4,
                                        ...Typography.default('semiBold')
                                    }}>
                                        MODEL
                                    </Text>
                                    {(['default', 'adaptiveUsage', 'sonnet', 'opus'] as const).map((model) => {
                                        const modelConfig = {
                                            default: { label: 'Use CLI settings' },
                                            adaptiveUsage: { label: 'Opus up to 50% usage, then Sonnet' },
                                            sonnet: { label: 'Sonnet' },
                                            opus: { label: 'Opus' },
                                        };
                                        const config = modelConfig[model];
                                        const isSelected = props.modelMode === model || (model === 'default' && !props.modelMode);

                                        return (
                                            <Pressable
                                                key={model}
                                                onPress={() => handleModelSelect(model)}
                                                style={({ pressed }) => ({
                                                    flexDirection: 'row',
                                                    alignItems: 'center',
                                                    paddingHorizontal: 16,
                                                    paddingVertical: 8,
                                                    backgroundColor: pressed ? 'rgba(0, 0, 0, 0.05)' : 'transparent'
                                                })}
                                            >
                                                <View style={{
                                                    width: 16,
                                                    height: 16,
                                                    borderRadius: 8,
                                                    borderWidth: 2,
                                                    borderColor: isSelected ? '#007AFF' : '#C0C0C0',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    marginRight: 12
                                                }}>
                                                    {isSelected && (
                                                        <View style={{
                                                            width: 6,
                                                            height: 6,
                                                            borderRadius: 3,
                                                            backgroundColor: '#007AFF'
                                                        }} />
                                                    )}
                                                </View>
                                                <Text style={{
                                                    fontSize: 14,
                                                    color: isSelected ? '#007AFF' : '#000',
                                                    ...Typography.default()
                                                }}>
                                                    {config.label}
                                                </Text>
                                            </Pressable>
                                        );
                                    })}
                                </View>
                            </FloatingOverlay>
                        </View>
                    </>
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
                                {contextWarning && (
                                    <Text style={{
                                        fontSize: 11,
                                        color: contextWarning.color,
                                        marginLeft: 8,
                                        ...Typography.default()
                                    }}>
                                        • {contextWarning.text}
                                    </Text>
                                )}
                            </View>
                        )}
                        <View style={{ flexDirection: 'column', alignItems: 'flex-end' }}>
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
                    </View>
                )}
                {/* Unified panel containing input and action buttons */}
                <View style={unifiedPanelStyle}>
                    {/* Input field */}
                    <View style={inputContainerStyle}>
                        <MultiTextInput
                            ref={inputRef}
                            value={props.value}
                            paddingTop={Platform.OS === 'web' ? 10 : 8}
                            paddingBottom={Platform.OS === 'web' ? 10 : 8}
                            onChangeText={props.onChangeText}
                            placeholder={props.placeholder}
                            onKeyPress={handleKeyPress}
                            onStateChange={handleInputStateChange}
                            maxHeight={120}
                        />
                    </View>

                    {/* Action buttons below input */}
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingHorizontal: 0,
                    }}>
                        <View style={{ flexDirection: 'row', gap: 8 }}>

                            {/* Settings button */}
                            {props.onPermissionModeChange && (
                                <Pressable
                                    onPress={handleSettingsPress}
                                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                    style={(p) => ({
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        borderRadius: Platform.select({ default: 16, android: 20 }),
                                        paddingHorizontal: 8,
                                        paddingVertical: 6,
                                        justifyContent: 'center',
                                        height: 32,
                                        opacity: p.pressed ? 0.7 : 1,
                                    })}
                                >
                                    <Octicons
                                        name={'gear'}
                                        size={16}
                                        color={'black'}
                                    />
                                </Pressable>
                            )}


                            {/* File Viewer button */}
                            {props.onFileViewerPress && (
                                <Pressable
                                    style={(p) => ({
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        borderRadius: Platform.select({ default: 16, android: 20 }),
                                        paddingHorizontal: 8,
                                        paddingVertical: 6,
                                        justifyContent: 'center',
                                        height: 32,
                                        opacity: p.pressed ? 0.7 : 1,
                                    })}
                                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                    onPress={() => {
                                        hapticsLight();
                                        props.onFileViewerPress?.();
                                    }}
                                >
                                    <Octicons
                                        name="file"
                                        size={16}
                                        color={'#000'}
                                    />
                                </Pressable>
                            )}

                            {/* Abort button */}
                            {props.onAbort && (
                                <Shaker ref={shakerRef}>
                                    <Pressable
                                        style={(p) => ({
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            borderRadius: Platform.select({ default: 16, android: 20 }),
                                            paddingHorizontal: 8,
                                            paddingVertical: 6,
                                            justifyContent: 'center',
                                            height: 32,
                                            opacity: p.pressed ? 0.7 : 1,
                                        })}
                                        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                        onPress={handleAbortPress}
                                        disabled={isAborting}
                                    >
                                        {isAborting ? (
                                            <ActivityIndicator
                                                size="small"
                                                color={Platform.select({ ios: '#FF9500', android: '#FF6F00', default: '#FF9500' })}
                                            />
                                        ) : (
                                            <Octicons
                                                name={"stop"}
                                                size={16}
                                                color={'black'}
                                            />
                                        )}
                                    </Pressable>
                                </Shaker>
                            )}
                        </View>

                        {/* Send/Voice button */}
                        <View
                            style={{
                                backgroundColor: hasText 
                                    ? 'black'
                                    : (props.onMicPress && !props.isMicActive) ? 'black' : '#E0E0E0',
                                width: 32,
                                height: 32,
                                borderRadius: 16,
                                justifyContent: 'center',
                                alignItems: 'center',
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
                                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                                onPress={() => {
                                    hapticsLight();
                                    if (hasText) {
                                        props.onSend();
                                    } else {
                                        props.onMicPress?.();
                                    }
                                }}
                                disabled={!hasText && !props.onMicPress}
                            >
                                {hasText ? (
                                    <Octicons 
                                        name="arrow-up" 
                                        size={16} 
                                        color="#fff" 
                                        style={{
                                            marginTop: Platform.OS === 'web' ? 2 : 0
                                        }}
                                    />
                                ) : props.onMicPress && !props.isMicActive ? (
                                    <Image
                                        source={require('@/assets/images/icon-voice-white.png')}
                                        style={{
                                            width: 24,
                                            height: 24
                                        }}
                                    />
                                ) : (
                                    <Octicons 
                                        name="arrow-up" 
                                        size={16} 
                                        color="#fff" 
                                        style={{
                                            marginTop: Platform.OS === 'web' ? 2 : 0
                                        }}
                                    />
                                )}
                            </Pressable>
                        </View>
                    </View>
                </View>
            </View>
        </View>
    );
});