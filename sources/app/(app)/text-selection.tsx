import React from 'react';
import { View, Text, ScrollView, TextInput, Alert, Pressable } from 'react-native';
import { useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { retrieveTempText } from '@/sync/persistence';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import * as Clipboard from 'expo-clipboard';
import { Modal } from '@/modal';
import { Ionicons } from '@expo/vector-icons';

export default function TextSelectionScreen() {
    const router = useRouter();
    const navigation = useNavigation();
    const { textId } = useLocalSearchParams<{ textId: string }>();
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const [fullText, setFullText] = React.useState<string>('');
    const [loading, setLoading] = React.useState(true);

    // Copy functionality
    const handleCopyAll = React.useCallback(async () => {
        if (!fullText) {
            Modal.alert(t('common.error'), t('textSelection.noTextToCopy'));
            return;
        }

        try {
            await Clipboard.setStringAsync(fullText);
            Modal.alert(t('textSelection.textCopied'));
        } catch (error) {
            Modal.alert(t('common.error'), t('textSelection.failedToCopy'));
        }
    }, [fullText]);

    // Set up header right button
    React.useLayoutEffect(() => {
        navigation.setOptions({
            headerRight: () => (
                <Pressable
                    onPress={handleCopyAll}
                    style={({ pressed }) => [
                        styles.copyButton,
                        { opacity: pressed ? 0.7 : 1 }
                    ]}
                    disabled={loading || !fullText}
                >
                    <Ionicons 
                        name="copy-outline" 
                        size={24} 
                        color={loading || !fullText ? theme.colors.textSecondary : theme.colors.header.tint} 
                    />
                </Pressable>
            ),
        });
    }, [navigation, handleCopyAll, loading, fullText, theme]);

    React.useEffect(() => {
        if (!textId) {
            Alert.alert(t('common.error'), t('textSelection.noTextProvided'), [
                { text: t('common.ok'), onPress: () => router.back() }
            ]);
            return;
        }

        const content = retrieveTempText(textId);
        if (content) {
            setFullText(content);
        } else {
            Alert.alert(t('common.error'), t('textSelection.textNotFound'), [
                { text: t('common.ok'), onPress: () => router.back() }
            ]);
        }
        setLoading(false);
    }, [textId, router]);

    if (loading) {
        return (
            <View style={styles.container}>
                <Text style={[styles.loadingText, { color: theme.colors.textSecondary }]}>
                    {t('common.loading')}
                </Text>
            </View>
        );
    }

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
            <ScrollView 
                style={styles.textContainer} 
                showsVerticalScrollIndicator={true}
                contentContainerStyle={[
                    styles.scrollContent,
                    { paddingBottom: insets.bottom + 16 }
                ]}
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
    copyButton: {
        padding: 8,
        marginRight: 8,
        borderRadius: 8,
    },
}));
