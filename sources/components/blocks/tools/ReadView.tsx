import * as React from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/typesMessage';
import { CodeView } from '../CodeView';
import { ToolSectionView } from '../ToolSectionView';

interface ReadViewProps {
    tool: ToolCall
}

export const ReadView = React.memo<ReadViewProps>(({ tool }) => {
    const formatPath = (path: string) => {
        const parts = path.split('/');
        return parts[parts.length - 1] || path;
    };

    return (
        <>
            <ToolSectionView>
                <View style={styles.fileInfo}>
                    <Ionicons name="document-text-outline" size={16} color="#5856D6" />
                    <Text style={styles.filePath} numberOfLines={1}>
                        {formatPath(tool.input.file_path)}
                    </Text>
                    {(tool.input.offset || tool.input.limit) && (
                        <Text style={styles.range}>
                            {tool.input.offset && `from ${tool.input.offset}`}
                            {tool.input.offset && tool.input.limit && ', '}
                            {tool.input.limit && `${tool.input.limit} lines`}
                        </Text>
                    )}
                </View>
            </ToolSectionView>

            {tool.state === 'completed' && tool.result && (
                <ToolSectionView>
                    <CodeView 
                        code={String(tool.result)} 
                        horizontal={true}
                    />
                </ToolSectionView>
            )}
        </>
    );
});

const styles = StyleSheet.create({
    fileInfo: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    filePath: {
        fontSize: 14,
        fontWeight: '500',
        color: '#000',
        flex: 1,
    },
    range: {
        fontSize: 12,
        color: '#666',
    },
});