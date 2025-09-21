import * as React from 'react';
import { View, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';

export const ZenAdd = React.memo(() => {
    const router = useRouter();
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const [text, setText] = React.useState('');

    const handleSubmit = () => {
        if (text.trim()) {
            // Call the global addTodo function from ZenHome
            if ((global as any).addZenTodo) {
                (global as any).addZenTodo(text.trim());
            }
            router.back();
        }
    };

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={styles.container}
        >
            <View style={[
                styles.content,
                { paddingBottom: insets.bottom + 20 }
            ]}>
                <TextInput
                    style={[
                        styles.input,
                        {
                            color: theme.colors.text,
                            borderBottomColor: theme.colors.divider,
                        }
                    ]}
                    placeholder="What needs to be done?"
                    placeholderTextColor={theme.colors.textSecondary}
                    value={text}
                    onChangeText={setText}
                    onSubmitEditing={handleSubmit}
                    autoFocus
                    returnKeyType="done"
                    multiline
                    blurOnSubmit={true}
                />
            </View>
        </KeyboardAvoidingView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    content: {
        flex: 1,
        paddingHorizontal: 20,
        paddingTop: 20,
    },
    input: {
        fontSize: 18,
        lineHeight: 24,
        borderBottomWidth: 1,
        paddingVertical: 12,
        paddingHorizontal: 4,
        ...Typography.default(),
    },
}));