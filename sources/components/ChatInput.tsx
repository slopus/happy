import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { View, TextInput, NativeSyntheticEvent, TextInputKeyPressEventData, Platform, ActivityIndicator, Pressable } from 'react-native';

export const ChatInput = React.memo((props: {
    value: string,
    placeholder: string,
    onChangeText: (text: string) => void,
    loading: boolean,
    onSend: () => void
}) => {
    // Handle Enter key on web
    const handleKeyPress = React.useCallback((e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
        if (Platform.OS === 'web') {
            let isShift = (e.nativeEvent as any).shiftKey as boolean;

            // Check if the pressed key is Enter/Return and Shift is not pressed
            if (e.nativeEvent.key === 'Enter' && !isShift) {
                e.preventDefault(); // Prevent new line
                if (!props.loading && props.value.trim()) {
                    props.onSend();
                }
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
            <TextInput
                style={{
                    flex: 1,
                    borderTopLeftRadius: 24,
                    borderBottomLeftRadius: 24,
                    overflow: 'hidden',
                    minHeight: 22 + (12 + 12),
                    maxHeight: 22 * 3 + (12 + 12),
                    paddingTop: 12,
                    paddingBottom: 12,
                    paddingLeft: 18,
                    paddingRight: 16,
                    flexGrow: 1,
                    fontSize: 17,
                    lineHeight: 22,
                    fontWeight: '400',
                    color: 'black',
                    textAlignVertical: 'top'
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