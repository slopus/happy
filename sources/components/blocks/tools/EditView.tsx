import * as React from 'react';
import { Text, View, ScrollView, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../ToolSectionView';

interface EditViewProps {
    tool: ToolCall;
}

export const EditView = React.memo<EditViewProps>(({ tool }) => {
    const { input, result, state } = tool;
    const formatPath = (path: string) => {
        const parts = path.split('/');
        return parts[parts.length - 1] || path;
    };

    const renderDiff = () => {
        const oldLines = input.old_string.split('\n');
        const newLines = input.new_string.split('\n');
        
        return (
            <View style={styles.diffContainer}>
                <View style={styles.diffSection}>
                    <Text style={styles.diffLabel}>- Remove</Text>
                    <View style={[styles.codeBlock, styles.removeBlock]}>
                        <Text style={[styles.codeText, styles.removeText]}>
                            {input.old_string}
                        </Text>
                    </View>
                </View>
                
                <View style={styles.diffSection}>
                    <Text style={styles.diffLabel}>+ Add</Text>
                    <View style={[styles.codeBlock, styles.addBlock]}>
                        <Text style={[styles.codeText, styles.addText]}>
                            {input.new_string}
                        </Text>
                    </View>
                </View>
            </View>
        );
    };

    return (
        <>
            <ToolSectionView>
                <View style={styles.fileInfo}>
                    <Ionicons name="pencil" size={16} color="#5856D6" />
                    <Text style={styles.filePath} numberOfLines={1}>
                        {formatPath(input.file_path)}
                    </Text>
                    {input.replace_all && (
                        <View style={styles.badge}>
                            <Text style={styles.badgeText}>Replace All</Text>
                        </View>
                    )}
                </View>
            </ToolSectionView>

            <ToolSectionView>
                {renderDiff()}
            </ToolSectionView>

            {state === 'completed' && result && (
                <ToolSectionView>
                    <View style={styles.successContainer}>
                        <Ionicons name="checkmark-circle" size={16} color="#34C759" />
                        <Text style={styles.successText}>{String(result)}</Text>
                    </View>
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
        marginBottom: 8,
    },
    filePath: {
        fontSize: 14,
        fontWeight: '500',
        color: '#000',
        flex: 1,
    },
    badge: {
        backgroundColor: '#007AFF',
        borderRadius: 4,
        paddingHorizontal: 6,
        paddingVertical: 2,
    },
    badgeText: {
        fontSize: 11,
        color: '#FFF',
        fontWeight: '600',
    },
    diffContainer: {
        gap: 8,
        marginBottom: 8,
    },
    diffSection: {
        gap: 4,
    },
    diffLabel: {
        fontSize: 12,
        fontWeight: '600',
        color: '#666',
    },
    codeBlock: {
        borderRadius: 6,
        padding: 10,
        maxHeight: 150,
    },
    removeBlock: {
        backgroundColor: '#FFF0F0',
        borderWidth: 1,
        borderColor: '#FFD0D0',
    },
    addBlock: {
        backgroundColor: '#F0FFF0',
        borderWidth: 1,
        borderColor: '#D0FFD0',
    },
    codeText: {
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        fontSize: 12,
        lineHeight: 18,
    },
    removeText: {
        color: '#D73A49',
    },
    addText: {
        color: '#28A745',
    },
    successContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: '#F0FFF0',
        borderRadius: 6,
        padding: 10,
    },
    successText: {
        fontSize: 13,
        color: '#28A745',
        flex: 1,
    },
});