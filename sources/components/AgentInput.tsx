import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { View, Platform, Animated, Text, ActivityIndicator, useWindowDimensions, Button } from 'react-native';
import { Pressable } from 'react-native-gesture-handler';
import { hapticsLight, hapticsError } from './haptics';
import { Typography } from '@/constants/Typography';
import { layout } from './layout';
import { MultiTextInput, KeyPressEvent } from './MultiTextInput';
import { PermissionModeSelector, PermissionMode } from './PermissionModeSelector';
import { Shaker, ShakeInstance } from './Shaker';
import { sessionSwitch } from '@/sync/ops';

// Status dot component
function StatusDot({ color, isPulsing, size = 6 }: { color: string; isPulsing?: boolean; size?: number }) {
    const pulseAnim = React.useRef(new Animated.Value(1)).current;

    React.useEffect(() => {
        if (isPulsing) {
            Animated.loop(
                Animated.sequence([
                    Animated.timing(pulseAnim, {
                        toValue: 0.3,
                        duration: 1000,
                        useNativeDriver: true,
                    }),
                    Animated.timing(pulseAnim, {
                        toValue: 1,
                        duration: 1000,
                        useNativeDriver: true,
                    }),
                ])
            ).start();
        } else {
            pulseAnim.setValue(1);
        }
    }, [isPulsing, pulseAnim]);

    return (
        <Animated.View
            style={{
                width: size,
                height: size,
                borderRadius: size / 2,
                backgroundColor: color,
                opacity: pulseAnim,
            }}
        />
    );
}

export const AgentInput = React.memo((props: {
    value: string,
    placeholder: string,
    onChangeText: (text: string) => void,
    onSend: () => void,
    sendIcon?: React.ReactNode,
    onMicPress?: () => void,
    isMicActive?: boolean,
    status?: {
        state: string,
        text: string,
        color: string,
        dotColor: string,
        isPulsing?: boolean,
    },
    onAbort?: () => void | Promise<void>,
    permissionMode?: PermissionMode,
    onPermissionModeChange?: (mode: PermissionMode) => void,
    onSwitch?: () => void,
}) => {
    // Animation states
    const scaleAnim = React.useRef(new Animated.Value(1)).current;
    const prevStateRef = React.useRef<'add' | 'send' | 'custom' | 'mic'>('add');
    const screenWidth = useWindowDimensions().width;

    // Determine current state
    const currentState = React.useMemo(() => {
        if (props.sendIcon) return 'custom';
        if (props.value.trim()) return 'send';
        if (props.onMicPress && !props.value.trim()) return 'mic';
        return 'add';
    }, [props.value, props.sendIcon, props.onMicPress]);

    // Animate state changes
    React.useEffect(() => {
        const prevState = prevStateRef.current;

        if (prevState !== currentState) {
            // Scale animation - skip on Android for better performance
            if (Platform.OS === 'ios') {
                Animated.sequence([
                    Animated.timing(scaleAnim, {
                        toValue: 0.8,
                        duration: 100,
                        useNativeDriver: true,
                    }),
                    Animated.timing(scaleAnim, {
                        toValue: 1,
                        duration: 100,
                        useNativeDriver: true,
                    }),
                ]).start();
            }

            prevStateRef.current = currentState;
        }
    }, [currentState, scaleAnim]);

    // Handle Enter key
    const handleKeyPress = React.useCallback((event: KeyPressEvent): boolean => {
        if (Platform.OS === 'web') {
            if (event.key === 'Enter' && !event.shiftKey) {
                if (props.value.trim()) {
                    props.onSend();
                    return true; // Key was handled
                }
            }
        }
        return false; // Key was not handled
    }, [props.value, props.onSend]);
    const handlePress = React.useCallback(() => {
        if (currentState === 'mic' && props.onMicPress) {
            props.onMicPress();
        } else {
            props.onSend();
        }
    }, [props.onSend, currentState, props.onMicPress]);

    // Double press abort button states
    const [isFirstPress, setIsFirstPress] = React.useState(false);
    const [isAborting, setIsAborting] = React.useState(false);
    const resetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const abortButtonBgAnim = React.useRef(new Animated.Value(0)).current;
    const shakerRef = React.useRef<ShakeInstance>(null);

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
    }, [props.onAbort, isFirstPress]);

    // Clean up timer on unmount
    React.useEffect(() => {
        return () => {
            if (resetTimerRef.current) {
                clearTimeout(resetTimerRef.current);
            }
        };
    }, []);

    return (
        <View>
            {/* Status panel */}
            {props.status && (
                <View style={{
                    alignItems: 'center',
                    paddingTop: 4,
                    paddingBottom: 2,
                }}>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        width: '100%',
                        maxWidth: layout.maxWidth,
                        paddingHorizontal: 32,
                    }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                            <StatusDot
                                color={props.status.dotColor}
                                isPulsing={props.status.isPulsing}
                                size={8}
                            />
                            <Text style={{
                                fontSize: 14,
                                color: props.status.color,
                                marginLeft: 6,
                                ...Typography.default()
                            }}>
                                {props.status.text}
                            </Text>
                        </View>

                        {/* Permission Mode Selector */}
                        {props.onPermissionModeChange && props.status.state !== 'disconnected' && (
                            <View style={{ marginRight: 8 }}>
                                <PermissionModeSelector
                                    mode={props.permissionMode || 'default'}
                                    onModeChange={props.onPermissionModeChange}
                                />
                            </View>
                        )}

                        <Button 
                            title="Switch"
                            onPress={() => props.onSwitch?.()}
                        />

                        {/* Abort button */}
                        {props.onAbort && (
                            <Shaker ref={shakerRef}>
                                <Animated.View
                                    style={{
                                        backgroundColor: abortButtonBgAnim.interpolate({
                                            inputRange: [0, 1],
                                            outputRange: [
                                                isFirstPress 
                                                    ? Platform.select({ ios: '#FFF3E0', android: '#FFE0B2', default: '#FFF3E0' })!
                                                    : Platform.select({ ios: '#F2F2F7', android: '#E0E0E0', default: '#F2F2F7' })!, 
                                                Platform.select({ ios: '#FF3B30', android: '#F44336', default: '#FF3B30' })!
                                            ]
                                        }),
                                        borderRadius: Platform.select({ default: 16, android: 20 }),
                                        overflow: 'hidden',
                                    }}
                                >
                                    <Pressable
                                        onPress={handleAbortPress}
                                        disabled={isAborting}
                                        style={{
                                            paddingHorizontal: 12,
                                            paddingVertical: 6,
                                            minWidth: 100,
                                            height: 32,
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                        }}
                                    >
                                        {isAborting ? (
                                            <ActivityIndicator size="small" color="#fff" />
                                        ) : (
                                            <Text style={{
                                                fontSize: 13,
                                                color: isFirstPress 
                                                    ? Platform.select({ ios: '#FF9500', android: '#FF6F00', default: '#FF9500' })
                                                    : '#000',
                                                fontWeight: '600',
                                                ...Typography.default('semiBold')
                                            }}>
                                                {isFirstPress ? 'Press again' : 'Abort'}
                                            </Text>
                                        )}
                                    </Pressable>
                                </Animated.View>
                            </Shaker>
                        )}
                    </View>
                </View>
            )}

            {/* Input field */}
            <View style={{
                alignItems: 'center',
                paddingHorizontal: screenWidth > 700 ? 16 : 8,
                paddingBottom: 8,
                paddingTop: props.status ? 4 : 8,
            }}>
                <View
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        borderRadius: Platform.select({ default: 24, android: 28 }),
                        backgroundColor: Platform.select({ default: '#fff', android: '#F5F5F5' }),
                        borderWidth: Platform.select({ default: 1, android: 1.5 }),
                        borderColor: Platform.select({ default: '#E5E5E7', android: '#E0E0E0' }),
                        width: '100%',
                        maxWidth: layout.maxWidth,
                        paddingLeft: 16,
                        paddingRight: 5,
                        paddingVertical: 0,
                        minHeight: 48,
                        ...Platform.select({
                            default: {
                                shadowColor: '#000',
                                shadowOffset: { width: 0, height: 2 },
                                shadowOpacity: 0.08,
                                shadowRadius: 6,
                            },
                            android: {
                                elevation: 0,
                            },
                        }),
                    }}
                >
                    <View style={{ flex: 1, paddingVertical: 10, paddingRight: 8, paddingLeft: 4 }}>
                        <MultiTextInput
                            value={props.value}
                            onChangeText={props.onChangeText}
                            placeholder={props.placeholder}
                            onKeyPress={handleKeyPress}
                            maxHeight={120}
                        />
                    </View>
                    <Animated.View style={{ transform: [{ scale: scaleAnim }], alignSelf: "flex-end", paddingBottom: 4 }}>
                        <Pressable
                            style={(p) => ({
                                width: 38,
                                height: 38,
                                borderRadius: 19,
                                backgroundColor: currentState === 'mic' ? (props.isMicActive ? '#FF6B35' : '#FF8C42') :
                                    currentState !== 'add' ? Platform.select({ default: '#007AFF', android: '#1976D2' }) : 'transparent',
                                borderWidth: currentState === 'add' ? Platform.select({ default: 2, android: 1.5 }) : 0,
                                borderColor: Platform.select({ default: '#E5E5E7', android: '#E0E0E0' }),
                                alignItems: 'center',
                                justifyContent: 'center',
                                opacity: p.pressed ? 0.7 : 1,
                                transform: [{ scale: p.pressed ? 0.9 : 1 }],
                            })}
                            onPress={handlePress}
                            hitSlop={8}
                            disabled={!props.value.trim() && !props.sendIcon && !props.onMicPress}
                        >
                            {props.sendIcon || (
                                <Ionicons
                                    name={currentState === 'send' ? "arrow-up" :
                                        currentState === 'mic' ? (props.isMicActive ? "stop" : "mic") : "add"}
                                    size={currentState === 'send' ? 20 : currentState === 'mic' ? 22 : 24}
                                    color={currentState === 'mic' || currentState === 'send' ? "#fff" : Platform.select({ default: "#8E8E93", android: "#757575" })}
                                />
                            )}
                        </Pressable>
                    </Animated.View>
                </View>
            </View>
        </View>
    );
});