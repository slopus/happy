import { Ionicons } from '@expo/vector-icons';
import TextareaAutosize from 'react-textarea-autosize';
import * as React from 'react';
import { View, ActivityIndicator, Pressable } from 'react-native';

export const ChatInput = React.memo((props: {
    value: string,
    placeholder: string,
    onChangeText: (text: string) => void,
    loading: boolean,
    onSend: () => void
}) => {

    // Handle Enter key on web
    const handleKeyPress = React.useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Check if the pressed key is Enter/Return and Shift is not pressed
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault(); // Prevent new line
            if (!props.loading && props.value.trim()) {
                props.onSend();
            }
        }

    }, [props.loading, props.value, props.onSend]);
    const handlePress = React.useCallback(() => {
        if (!props.loading && props.value.trim()) {
            props.onSend();
        }
    }, [props.loading, props.value, props.onSend]);

    return (
        <View className="bg-gray-200 rounded-3xl flex-row min-h-12 self-stretch">
            <TextareaAutosize
                minRows={1}
                maxRows={3}
                className="flex-1 rounded-tl-3xl rounded-bl-3xl overflow-hidden my-3 pl-[18px] pr-4 text-[17px] leading-[22px] font-normal text-black bg-transparent border-none resize-none"
                placeholder={props.placeholder}
                // placeholderTextColor={theme.input.placeholder}
                autoCapitalize="sentences"
                // autoCorrect={true}
                // keyboardType="default"
                // returnKeyType='default'
                autoComplete="off"
                // multiline={true}
                value={props.value}
                onChange={(e) => props.onChangeText(e.target.value)}
                // textContentType="none"
                // onChangeText={props.onChangeText}
                onKeyPress={handleKeyPress}
            // submitBehavior="newline"
            // onKeyPress={handleKeyPress}
            />
            <Pressable
                className="w-8 h-8 items-center justify-center bg-white rounded-3xl self-start m-2"
                onPress={handlePress}
            >
                {props.loading && <ActivityIndicator color="black" size="small" />}
                {!props.loading && <Ionicons name="arrow-up" size={20} color="black" />}
            </Pressable>
        </View>
    );
});