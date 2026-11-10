import * as React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { AttachmentPreview } from '@/sync/attachmentTypes';

/** Read-only copy of the submitted attachments while a new session starts. */
export function SubmittedAttachmentPreview({ images, testID }: { images: AttachmentPreview[]; testID?: string }) {
    const { theme } = useUnistyles();
    return <ScrollView horizontal showsHorizontalScrollIndicator={false} testID={testID} contentContainerStyle={styles.row}>
        {images.map(image => !image.kind || image.kind === 'image'
            ? <Image key={image.id} source={{ uri: image.uri }} style={styles.image} contentFit="cover" accessibilityLabel={image.name} />
            : <View key={image.id} style={[styles.file, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }]}>
                <Ionicons name="document-outline" size={20} color={theme.colors.textSecondary} />
                <Text numberOfLines={1} style={[styles.name, { color: theme.colors.text }]}>{image.name}</Text>
            </View>)}
    </ScrollView>;
}
const styles = StyleSheet.create(() => ({
    row: { flexDirection: 'row', gap: 8, paddingBottom: 8 },
    image: { width: 72, height: 72, borderRadius: 10 },
    file: { width: 160, height: 72, borderRadius: 10, borderWidth: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, gap: 8 },
    name: { flex: 1, fontSize: 13 },
}));
