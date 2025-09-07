import React from 'react';
import { View, Text, ScrollView, Pressable, TextInput } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';

export interface TextSelectionModalProps {
    fullText: string;
    title?: string;
    onClose: () => void;
}

export const TextSelectionModal: React.FC<TextSelectionModalProps> = ({ fullText, title, onClose }) => {
    const { theme } = useUnistyles();
    
    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.headerTitle}>
                    {title ? t('textSelection.selectFromMessage', { title }) : t('textSelection.selectText')}
                </Text>
                <Pressable onPress={onClose} style={styles.closeButton}>
                    <Ionicons name="close" size={24} color={theme.colors.text} />
                </Pressable>
            </View>
            
            <ScrollView style={styles.textContainer} showsVerticalScrollIndicator={true}>
                <TextInput
                    style={styles.textInput}
                    value={fullText}
                    multiline={true}
                    editable={false}
                    selectTextOnFocus={false}
                    scrollEnabled={false}
                />
            </ScrollView>
        </View>
    );
};

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
        maxHeight: '90%',
        margin: 16,
        borderRadius: 16,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: theme.colors.text,
        flex: 1,
    },
    closeButton: {
        padding: 4,
    },
    textContainer: {
        flex: 1,
        padding: 16,
    },
    textInput: {
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.text,
        //backgroundColor: "#f00",
        minHeight: 200,
        textAlignVertical: 'top',
        backgroundColor: 'transparent',
        borderWidth: 0,
        paddingHorizontal: 0,
        paddingVertical: 0,
    },
}));