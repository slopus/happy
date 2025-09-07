import React from 'react';
import { View, Text, ScrollView, TextInput, Alert } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { retrieveTempText } from '@/sync/persistence';
import { Typography } from '@/constants/Typography';

export default function TextSelectionScreen() {
    const router = useRouter();
    const { textId } = useLocalSearchParams<{ textId: string }>();
    const { theme } = useUnistyles();
    const [fullText, setFullText] = React.useState<string>('');
    const [loading, setLoading] = React.useState(true);

    React.useEffect(() => {
        if (!textId) {
            Alert.alert('Error', 'No text provided', [
                { text: 'OK', onPress: () => router.back() }
            ]);
            return;
        }

        const content = retrieveTempText(textId);
        if (content) {
            setFullText(content);
        } else {
            Alert.alert('Error', 'Text not found or expired', [
                { text: 'OK', onPress: () => router.back() }
            ]);
        }
        setLoading(false);
    }, [textId, router]);

    if (loading) {
        return (
            <View style={styles.container}>
                <Text style={[styles.loadingText, { color: theme.colors.textSecondary }]}>
                    Loading...
                </Text>
            </View>
        );
    }

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
            <ScrollView 
                style={styles.textContainer} 
                showsVerticalScrollIndicator={true}
                contentContainerStyle={styles.scrollContent}
            >
                <TextInput
                    style={[styles.textInput, { 
                        color: theme.colors.text,
                        backgroundColor: 'transparent'
                    }]}
                    value={fullText}
                    multiline={true}
                    editable={false}
                    selectTextOnFocus={false}
                    scrollEnabled={false}
                />
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    loadingText: {
        ...Typography.default(),
        fontSize: 16,
        textAlign: 'center',
        marginTop: 50,
    },
    textContainer: {
        flex: 1,
        padding: 16,
    },
    scrollContent: {
        flexGrow: 1,
    },
    textInput: {
        ...Typography.mono(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text,
        minHeight: 200,
        textAlignVertical: 'top',
        backgroundColor: 'transparent',
        borderWidth: 0,
        paddingHorizontal: 0,
        paddingVertical: 0,
    },
}));
