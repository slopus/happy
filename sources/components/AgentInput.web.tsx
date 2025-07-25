import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { View, TextInput, NativeSyntheticEvent, TextInputKeyPressEventData, Platform } from 'react-native';
import { Pressable } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import TextareaAutosize from 'react-textarea-autosize';

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
                    marginBottom: 32,
                    flexDirection: 'column',
                    borderRadius: 24,
                    flexGrow: 1,
                    maxWidth: 700,
                    boxShadow: 'rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.04) 0px 4px 4px 0px, rgba(0, 0, 0, 0.62) 0px 0px 1px 0px',
                }}
            >
                <TextareaAutosize
                    placeholder={props.placeholder}
                    autoCapitalize="sentences"
                    autoCorrect="true"
                    autoComplete="off"
                    value={props.value}
                    onChange={(e) => props.onChangeText(e.target.value)}
                    className="p-6 pl-6 text-lg max-h-48 bg-transparent border-none outline-none resize-none"
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