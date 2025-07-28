import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { View, TextInput, NativeSyntheticEvent, TextInputKeyPressEventData, Platform, Animated } from 'react-native';
import { Pressable } from 'react-native-gesture-handler';

export const AgentInput = React.memo((props: {
    value: string,
    placeholder: string,
    onChangeText: (text: string) => void,
    onSend: () => void,
    sendIcon?: React.ReactNode
}) => {
    // Animation states
    const scaleAnim = React.useRef(new Animated.Value(1)).current;
    const prevStateRef = React.useRef<'add' | 'send' | 'custom'>('add');
    
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
            // Scale animation
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
            
            prevStateRef.current = currentState;
        }
    }, [currentState, scaleAnim]);

    // Handle Enter key on web
    const handleKeyPress = React.useCallback((e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
        if (Platform.OS === 'web') {
            let isShift = (e.nativeEvent as any).shiftKey as boolean;

            // Check if the pressed key is Enter/Return and Shift is not pressed
            if (e.nativeEvent.key === 'Enter' && !isShift) {
                e.preventDefault(); // Prevent new line
                if (props.value.trim()) {
                    props.onSend();
                }
            }
        }
    }, [props.value, props.onSend]);
    const handlePress = React.useCallback(() => {
        props.onSend();
    }, [props.onSend]);

    return (
        <View style={{ 
            flexDirection: 'row', 
            justifyContent: 'center',
            paddingHorizontal: 16,
            paddingBottom: 8,
            paddingTop: 8,
        }}>
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    borderRadius: 24,
                    backgroundColor: '#fff',
                    borderWidth: 1,
                    borderColor: '#E5E5E7',
                    flexGrow: 1,
                    maxWidth: 700,
                    paddingLeft: 16,
                    paddingRight: 5,
                    paddingVertical: 5,
                    minHeight: 48,
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 2 },
                    shadowOpacity: 0.08,
                    shadowRadius: 6,
                    elevation: 3,
                }}
            >
                <TextInput
                    style={{
                        flex: 1,
                        paddingVertical: 10,
                        paddingRight: 8,
                        textAlignVertical: 'center',
                        fontSize: 16,
                        maxHeight: 120,
                        color: '#000',
                    }}
                    placeholder={props.placeholder}
                    placeholderTextColor={'#9D9FA3'}
                    autoCapitalize="sentences"
                    autoCorrect={true}
                    keyboardType="default"
                    returnKeyType='default'
                    autoComplete="off"
                    multiline={true}
                    value={props.value}
                    textContentType="none"
                    onChangeText={props.onChangeText}
                    onKeyPress={handleKeyPress}
                    submitBehavior="newline"
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
    );
});