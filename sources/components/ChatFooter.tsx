import * as React from 'react';
import { View, Platform, Animated, Text, ActivityIndicator, Button, ViewStyle, TextStyle } from 'react-native';
import { Pressable } from 'react-native-gesture-handler';
import { hapticsLight, hapticsError } from './haptics';
import { Typography } from '@/constants/Typography';
import { layout } from './layout';
import { PermissionModeSelector, PermissionMode } from './PermissionModeSelector';
import { Shaker, ShakeInstance } from './Shaker';
import { StatusDot } from './StatusDot';

interface ChatFooterProps {
    status?: {
        state: string;
        text: string;
        color: string;
        dotColor: string;
        isPulsing?: boolean;
    };
    onAbort?: () => void | Promise<void>;
    permissionMode?: PermissionMode;
    onPermissionModeChange?: (mode: PermissionMode) => void;
    onSwitch?: () => void;
    children?: React.ReactNode;
}

export const ChatFooter = React.memo((props: ChatFooterProps) => {
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
    }, [props.onAbort, isFirstPress, abortButtonBgAnim]);

    // Clean up timer on unmount
    React.useEffect(() => {
        return () => {
            if (resetTimerRef.current) {
                clearTimeout(resetTimerRef.current);
            }
        };
    }, []);

    if (!props.status) {
        return null;
    }

    const containerStyle: ViewStyle = {
        alignItems: 'center',
        paddingTop: 4,
        paddingBottom: 2,
    };

    const innerContainerStyle: ViewStyle = {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        maxWidth: layout.maxWidth,
        paddingHorizontal: 32,
    };

    const statusContainerStyle: ViewStyle = {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    };

    const statusTextStyle: TextStyle = {
        fontSize: 14,
        color: props.status.color,
        marginLeft: 6,
        ...Typography.default()
    };

    const permissionSelectorContainerStyle: ViewStyle = {
        marginRight: 8,
    };

    const abortButtonStyle: ViewStyle = {
        paddingHorizontal: 12,
        paddingVertical: 6,
        minWidth: 100,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    };

    const abortButtonTextStyle: TextStyle = {
        fontSize: 13,
        color: isFirstPress 
            ? Platform.select({ ios: '#FF9500', android: '#FF6F00', default: '#FF9500' })!
            : '#000',
        fontWeight: '600',
        ...Typography.default('semiBold')
    };

    return (
        <View style={containerStyle}>
            <View style={innerContainerStyle}>
                {/* <View style={statusContainerStyle}>
                    <StatusDot
                        color={props.status.dotColor}
                        isPulsing={props.status.isPulsing}
                        size={8}
                    />
                    <Text style={statusTextStyle}>
                        {props.status.text}
                    </Text>
                </View> */}

                {/* Abort button */}
                {/* {props.onAbort && (
                    <Shaker ref={shakerRef}>
                        <Animated.View
                            style={{
                                backgroundColor: abortButtonBgAnim.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: [
                                        Platform.select({ ios: '#F2F2F7', android: '#E0E0E0', default: '#F2F2F7' })!,
                                        Platform.select({ ios: '#FF3B30', android: '#F44336', default: '#FF3B30' })!
                                    ]
                                }),
                                borderRadius: Platform.select({ default: 16, android: 20 }),
                            }}
                        >
                            <Pressable
                                style={abortButtonStyle}
                                onPress={handleAbortPress}
                                disabled={isAborting}
                            >
                                {isAborting ? (
                                    <ActivityIndicator 
                                        size="small" 
                                        color={Platform.select({ ios: '#FFF', android: '#FFF', default: '#FFF' })}
                                    />
                                ) : (
                                    <Text style={abortButtonTextStyle}>
                                        {isFirstPress ? 'Press again' : 'Abort'}
                                    </Text>
                                )}
                            </Pressable>
                        </Animated.View>
                    </Shaker>
                )} */}
            </View>
        </View>
    );
});