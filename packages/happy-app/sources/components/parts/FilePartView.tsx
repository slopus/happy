import * as React from 'react';
import { View, Text, Pressable } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Image } from 'expo-image';
import { type v3 } from '@slopus/happy-sync';
import { FileIcon } from '@/components/FileIcon';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

interface FilePartViewProps {
    part: v3.FilePart;
    sessionId: string;
}

export const FilePartView = React.memo(({ part }: FilePartViewProps) => {
    const isImage = part.mime.startsWith('image/');

    if (isImage) {
        return (
            <Pressable style={styles.imageContainer}>
                <Image
                    source={{ uri: part.url }}
                    contentFit="contain"
                    style={{ width: 300, height: 200 }}
                />
                {part.filename && (
                    <Text style={styles.imageFilename}>{part.filename}</Text>
                )}
                {part.source && (
                    <SourceLabel source={part.source} />
                )}
            </Pressable>
        );
    }

    return (
        <View style={styles.fileCard}>
            <FileIcon fileName={part.filename ?? 'file'} size={24} />
            <View style={styles.fileInfo}>
                <Text style={styles.fileName} numberOfLines={1}>
                    {part.filename ?? t('parts.unknownFile')}
                </Text>
                <Text style={styles.fileMime} numberOfLines={1}>
                    {part.mime}
                </Text>
                {part.source && (
                    <SourceLabel source={part.source} />
                )}
            </View>
        </View>
    );
});

const SourceLabel = React.memo(({ source }: { source: v3.FilePartSource }) => {
    let label: string;
    if (source.type === 'file') {
        label = source.path;
    } else if (source.type === 'symbol') {
        label = `Symbol: ${source.name}`;
    } else {
        label = source.uri;
    }

    return <Text style={styles.sourceText} numberOfLines={1}>{label}</Text>;
});

const styles = StyleSheet.create((theme) => ({
    imageContainer: {
        maxWidth: 300,
        borderRadius: 8,
        overflow: 'hidden',
        marginVertical: 4,
    },
    imageFilename: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 4,
        ...Typography.default(),
    },
    fileCard: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.input.background,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        maxWidth: 300,
        marginVertical: 4,
        gap: 8,
    },
    fileInfo: {
        flex: 1,
        minWidth: 0,
    },
    fileName: {
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    fileMime: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.default(),
    },
    sourceText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.mono(),
    },
}));
