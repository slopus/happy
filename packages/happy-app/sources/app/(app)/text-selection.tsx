import React from 'react';
import { View, Text, ScrollView, TextInput, Pressable } from 'react-native';
import { useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { retrieveTempText } from '@/sync/persistence';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import * as Clipboard from 'expo-clipboard';
import { Modal } from '@/modal';
import { Ionicons } from '@expo/vector-icons';
import { InvalidRouteState } from '@/components/InvalidRouteState';

function readTextId(value: string | string[] | undefined): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

export const TextSelectionScreen = React.memo(function TextSelectionScreen() {
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{ textId?: string | string[] }>();
    const textId = readTextId(params.textId);
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const [fullText, setFullText] = React.useState('');
    const [loading, setLoading] = React.useState(Boolean(textId));
    const errorMessage = !textId
        ? t('textSelection.noTextProvided')
        : (!loading && !fullText ? t('textSelection.textNotFound') : null);

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
            headerRight: textId ? () => (
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
            ) : undefined,
        });
    }, [navigation, handleCopyAll, loading, fullText, textId, theme]);

    React.useEffect(() => {
        if (!textId) {
            setFullText('');
            setLoading(false);
            return;
        }

        const content = retrieveTempText(textId);
        setFullText(content ?? '');
        setLoading(false);
    }, [textId]);

    const handleInvalidTextRecovery = React.useCallback(() => {
        router.replace('/');
    }, [router]);

    if (errorMessage) {
        return (
            <InvalidRouteState
                title={t('common.error')}
                description={errorMessage}
                actionLabel={t('common.home')}
                onAction={handleInvalidTextRecovery}
            />
        );
    }

    if (loading) {
        return (
            <View style={styles.container}>
                <Text style={styles.loadingText}>{t('common.loading')}</Text>
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
});

export default TextSelectionScreen;

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    loadingText: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
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
