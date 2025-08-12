import * as React from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';

interface CommandSuggestionProps {
    command: string;
    description?: string;
}

export const CommandSuggestion = React.memo(({ command, description }: CommandSuggestionProps) => {
    return (
        <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 16,
            paddingVertical: 12,
            height: 48,
        }}>
            <Text 
                style={{
                    fontSize: 14,
                    color: '#007AFF',
                    fontWeight: '600',
                    marginRight: description ? 12 : 0,
                    ...Typography.default('semiBold'),
                }}
            >
                /{command}
            </Text>
            {description && (
                <Text
                    style={{
                        flex: 1,
                        fontSize: 13,
                        color: '#666',
                        ...Typography.default(),
                    }}
                    numberOfLines={1}
                >
                    {description}
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
        <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 16,
            paddingVertical: 12,
            height: 48,
        }}>
            <View style={{
                width: 32,
                height: 32,
                borderRadius: 16,
                backgroundColor: '#E8E8E8',
                alignItems: 'center',
                justifyContent: 'center',
                marginRight: 12,
            }}>
                <Ionicons
                    name={fileType === 'folder' ? 'folder' : 'document-text'}
                    size={18}
                    color="#333"
                />
            </View>
            <Text 
                style={{
                    flex: 1,
                    fontSize: 14,
                    color: '#000',
                    ...Typography.default(),
                }}
                numberOfLines={1}
            >
                {filePath}{fileName}
            </Text>
            <Text style={{
                fontSize: 12,
                color: '#999',
                marginLeft: 8,
                ...Typography.default(),
            }}>
                {fileType === 'folder' ? 'FOLDER' : 'FILE'}
            </Text>
        </View>
    );
});