import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { View, TextInput, NativeSyntheticEvent, TextInputKeyPressEventData, Platform } from 'react-native';
import { Pressable } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const AgentInput = React.memo((props: {
    value: string,
    placeholder: string,
    onChangeText: (text: string) => void,
    onSend: () => void,
    status?: React.ReactNode
}) => {

    const safeArea = useSafeAreaInsets();

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
        if (props.value.trim()) {
            props.onSend();
        }
    }, [props.value, props.onSend]);

    return (
        <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
            <View
                style={{
                    paddingBottom: 0 + safeArea.bottom,
                    marginBottom: -safeArea.bottom,
                    flexDirection: 'column',
                    borderTopEndRadius: 24,
                    borderTopStartRadius: 24,
                    flexGrow: 1,
                    maxWidth: 700,
                    boxShadow: '0px 0px 8px 0px rgba(0,0,0,0.2)',
                }}
            >
                <TextInput
                    style={{
                        paddingTop: 24,
                        paddingHorizontal: 24,
                        paddingBottom: 12,
                        textAlignVertical: 'top',
                        fontSize: 18,
                        maxHeight: 90,
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
                <View style={{ height: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 }}>
                    <View style={{ flex: 1 }}>
                        {props.status}
                    </View>
                    <Pressable
                        style={(p) => ({
                            width: 36,
                            height: 36,
                            borderRadius: 24,
                            backgroundColor: 'black',
                            alignItems: 'center',
                            justifyContent: 'center',
                            marginRight: 8
                        })}
                        onPress={handlePress}
                        hitSlop={10}
                    >
                        <Ionicons name="arrow-up" size={20} color="white" />
                    </Pressable>
                </View>
            </View>
        </View>
    );
});