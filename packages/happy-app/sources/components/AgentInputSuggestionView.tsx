import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

interface CommandSuggestionProps {
    command: string;
    description?: string;
    source?: 'agent' | 'skill' | 'happy';
    sourceLabel?: string;
}

function getSourceLabel(source: CommandSuggestionProps['source'], sourceLabel?: string): string | null {
    if (sourceLabel) {
        return sourceLabel;
    }
    switch (source) {
        case 'agent':
            return 'Agent';
        case 'skill':
            return 'Skill';
        case 'happy':
            return 'Happy';
        default:
            return null;
    }
}

export const CommandSuggestion = React.memo(({ command, description, source, sourceLabel }: CommandSuggestionProps) => {
    const label = getSourceLabel(source, sourceLabel);
    return (
        <View style={styles.suggestionContainer}>
            <Text 
                style={[styles.commandText, { marginRight: description ? 12 : 0 }]}
            >
                /{command}
            </Text>
            {description && (
                <Text
                    style={styles.descriptionText}
                    numberOfLines={1}
                >
                    {description}
                </Text>
            )}
            {label && (
                <Text style={styles.sourceText}>
                    {label}
                </Text>
            )}
        </View>
    );
});

interface FileMentionProps {
    fileName: string;
    filePath: string;
    fileType?: 'file' | 'folder';
}

export const FileMentionSuggestion = React.memo(({ fileName, filePath, fileType = 'file' }: FileMentionProps) => {
    return (
        <View style={styles.suggestionContainer}>
            <View style={styles.iconContainer}>
                <Ionicons
                    name={fileType === 'folder' ? 'folder' : 'document-text'}
                    size={18}
                    color={styles.iconColor.color}
                />
            </View>
            <Text 
                style={styles.fileNameText}
                numberOfLines={1}
            >
                {filePath}{fileName}
            </Text>
            <Text style={styles.labelText}>
                {fileType === 'folder' ? t('agentInput.suggestion.folderLabel') : t('agentInput.suggestion.fileLabel')}
            </Text>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    suggestionContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        height: 48,
    },
    commandText: {
        fontSize: 14,
        color: theme.colors.text,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    descriptionText: {
        flex: 1,
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    sourceText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginLeft: 8,
        ...Typography.default('semiBold'),
    },
    iconContainer: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: theme.colors.surfaceHigh,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    iconColor: {
        color: theme.colors.textSecondary,
    },
    fileNameText: {
        flex: 1,
        fontSize: 14,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    labelText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginLeft: 8,
        ...Typography.default(),
    },
}));
