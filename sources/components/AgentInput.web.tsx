import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { View, Platform, Animated, Text, ActivityIndicator, useWindowDimensions } from 'react-native';
import { Pressable } from 'react-native-gesture-handler';
import TextareaAutosize from 'react-textarea-autosize';
import { hapticsLight, hapticsError } from './haptics';
import { Typography } from '@/constants/Typography';
import { layout } from './layout';

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
    status?: {
        state: string,
        text: string,
        color: string,
        dotColor: string,
        isPulsing?: boolean,
    },
    onAbort?: () => void | Promise<void>,
}) => {
    // Animation states
    const scaleAnim = React.useRef(new Animated.Value(1)).current;
    const prevStateRef = React.useRef<'add' | 'send' | 'custom'>('add');
    const screenWidth = useWindowDimensions().width;

    // Determine current state
    const currentState = React.useMemo(() => {
        if (props.sendIcon) return 'custom';
        if (props.value.trim()) return 'send';
        return 'add';
    }, [props.value, props.sendIcon]);

    // Animate state changes
    React.useEffect(() => {
        const prevState = prevStateRef.current;

        if (prevState !== currentState) {
            // Scale animation - skip on Android for better performance
            if (Platform.OS === 'ios' || Platform.OS === 'web') {
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

    // Handle Enter key on web
    const handleKeyPress = React.useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (props.value.trim()) {
                props.onSend();
            }
        }
    }, [props.value, props.onSend]);

    const handlePress = React.useCallback(() => {
        props.onSend();
    }, [props.onSend]);

    // Long press abort button states
    const [abortProgress, setAbortProgress] = React.useState(0);
    const [isAborting, setIsAborting] = React.useState(false);
    const abortTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const abortIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
    const abortStartTimeRef = React.useRef<number>(0);
    const abortButtonBgAnim = React.useRef(new Animated.Value(0)).current;

    const handleAbortPressIn = React.useCallback(() => {
        if (!props.onAbort) return;

        if (Platform.OS !== 'web') {
            hapticsLight();
        }
        abortStartTimeRef.current = Date.now();
        setAbortProgress(0);

        // Start progress animation
        abortIntervalRef.current = setInterval(() => {
            const elapsed = Date.now() - abortStartTimeRef.current;
            const progress = Math.min(elapsed / 3000, 1); // 3 seconds
            setAbortProgress(progress);

            if (Platform.OS !== 'web') {
                if (progress >= 0.3 && progress < 0.35) {
                    hapticsLight();
                } else if (progress >= 0.6 && progress < 0.65) {
                    hapticsLight();
                } else if (progress >= 0.9 && progress < 0.95) {
                    hapticsLight();
                }
            }
        }, 16);

        // Set timer for 3 seconds
        abortTimerRef.current = setTimeout(async () => {
            if (Platform.OS !== 'web') {
                hapticsError();
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
            } finally {
                // Animate back to normal
                Animated.timing(abortButtonBgAnim, {
                    toValue: 0,
                    duration: 200,
                    useNativeDriver: false,
                }).start(() => {
                    setIsAborting(false);
                    handleAbortPressOut();
                });
            }
        }, 3000);
    }, [props.onAbort]);

    const handleAbortPressOut = React.useCallback(() => {
        if (abortTimerRef.current) {
            clearTimeout(abortTimerRef.current);
            abortTimerRef.current = null;
        }
        if (abortIntervalRef.current) {
            clearInterval(abortIntervalRef.current);
            abortIntervalRef.current = null;
        }
        setAbortProgress(0);
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
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
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

                        {/* Abort button */}
                        {props.onAbort && (
                            <Animated.View
                                style={{
                                    backgroundColor: abortButtonBgAnim.interpolate({
                                        inputRange: [0, 1],
                                        outputRange: ['#F2F2F7', '#FF3B30']
                                    }),
                                    borderRadius: 16,
                                    overflow: 'hidden',
                                }}
                            >
                                <Pressable
                                    onPressIn={handleAbortPressIn}
                                    onPressOut={handleAbortPressOut}
                                    disabled={isAborting}
                                    style={{
                                        position: 'relative',
                                        paddingHorizontal: 12,
                                        paddingVertical: 6,
                                        minWidth: 100,
                                        height: 32,
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                    }}
                                >
                                    <View style={{
                                        position: 'absolute',
                                        inset: 0,
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                    }}>
                                        {isAborting ? (
                                            <ActivityIndicator size="small" color="#fff" />
                                        ) : (
                                            <>
                                                {/* Progress background */}
                                                <View style={{
                                                    position: 'absolute',
                                                    top: 0,
                                                    left: 0,
                                                    bottom: 0,
                                                    width: `${abortProgress * 100}%`,
                                                    backgroundColor: '#FF3B30',
                                                    opacity: 0.2,
                                                }} />
                                                <Text style={{
                                                    fontSize: 13,
                                                    color: abortProgress > 0 || isAborting ? '#FF3B30' : '#000',
                                                    fontWeight: '600',
                                                    ...Typography.default('semiBold')
                                                }}>
                                                    {abortProgress > 0 ? `Hold ${Math.ceil(3 - abortProgress * 3)}s` : 'Hold to abort'}
                                                </Text>
                                            </>
                                        )}
                                    </View>
                                </Pressable>
                            </Animated.View>
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
                        borderRadius: 24,
                        backgroundColor: '#fff',
                        borderWidth: 1,
                        borderColor: '#E5E5E7',
                        width: '100%',
                        maxWidth: layout.maxWidth,
                        paddingLeft: 16,
                        paddingRight: 5,
                        paddingVertical: 5,
                        minHeight: 48,
                        shadowColor: '#000',
                        shadowOffset: { width: 0, height: 2 },
                        shadowOpacity: 0.08,
                        shadowRadius: 6,
                    }}
                >
                    <TextareaAutosize
                        style={{
                            width: '100%',
                            padding: '10px 8px 10px 0',
                            fontSize: '16px',
                            color: '#000',
                            border: 'none',
                            outline: 'none',
                            resize: 'none' as const,
                            backgroundColor: 'transparent',
                            fontFamily: Typography.default().fontFamily,
                            lineHeight: '1.4',
                        }}
                        placeholder={props.placeholder}
                        autoCapitalize="sentences"
                        autoCorrect="on"
                        autoComplete="off"
                        value={props.value}
                        onChange={(e) => props.onChangeText(e.target.value)}
                        onKeyDown={handleKeyPress}
                        maxRows={6}
                    />
                    <Animated.View
                        style={{
                            transform: [
                                { scale: scaleAnim }
                            ],
                        }}
                    >
                        <Pressable
                            style={(p) => ({
                                width: 38,
                                height: 38,
                                borderRadius: 19,
                                backgroundColor: currentState !== 'add' ? '#007AFF' : 'transparent',
                                borderWidth: currentState === 'add' ? 2 : 0,
                                borderColor: '#E5E5E7',
                                alignItems: 'center',
                                justifyContent: 'center',
                                opacity: p.pressed ? 0.7 : 1,
                                transform: [{ scale: p.pressed ? 0.9 : 1 }],
                            })}
                            onPress={handlePress}
                            hitSlop={8}
                            disabled={!props.value.trim() && !props.sendIcon}
                        >
                            {props.sendIcon || (
                                <Ionicons
                                    name={currentState === 'send' ? "arrow-up" : "add"}
                                    size={currentState === 'send' ? 20 : 24}
                                    color={currentState !== 'add' ? "#fff" : "#8E8E93"}
                                />
                            )}
                        </Pressable>
                    </Animated.View>
                </View>
            </View>
        </View>
    );
});