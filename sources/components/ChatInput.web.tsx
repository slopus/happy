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
        <View
            style={[{
                backgroundColor: '#F2F2F2',
                borderRadius: 24,
                flexDirection: 'row',
                minHeight: 48,
                alignSelf: 'stretch'
            }]}
        >

            <TextareaAutosize
                minRows={1}
                maxRows={3}
                style={{
                    flexBasis: 0,
                    flexGrow: 1,
                    borderTopLeftRadius: 24,
                    borderBottomLeftRadius: 24,
                    overflow: 'hidden',
                    // minHeight: 22 + (12 + 12),
                    // maxHeight: 22 * 3 + (12 + 12),
                    marginTop: '12px',
                    marginBottom: '12px',
                    paddingLeft: '18px',
                    paddingRight: '16px',
                    fontSize: '17px',
                    lineHeight: '22px',
                    fontWeight: '400',
                    color: 'black',
                    backgroundColor: 'transparent',
                    border: 'none',
                    resize: 'none',
                    // textAlignVertical: 'top'
                }}
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
                style={{
                    width: 32,
                    height: 32,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: 'white',
                    borderRadius: 24,
                    alignSelf: 'flex-start',
                    margin: 8
                }}
                onPress={handlePress}
            >
                {props.loading && <ActivityIndicator color="black" size="small" />}
                {!props.loading && <Ionicons name="arrow-up" size={20} color="black" />}
            </Pressable>
        </View>
    );
});