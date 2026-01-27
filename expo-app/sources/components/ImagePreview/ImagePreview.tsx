import * as React from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { StyleSheet } from 'react-native-unistyles';
import { ImagePreviewProps } from './types';

const THUMBNAIL_SIZE = 64;

export const ImagePreview = React.memo(function ImagePreview({
    images,
    onRemove,
    maxImages = 4,
    disabled = false,
}: ImagePreviewProps) {
    if (images.length === 0) {
        return null;
    }

    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.container}
            contentContainerStyle={styles.content}
        >
            {images.slice(0, maxImages).map((image, index) => (
                <View key={`${image.uri}-${index}`} style={styles.imageWrapper}>
                    <Image
                        source={{ uri: image.uri }}
                        style={{ width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE, borderRadius: 8 }}
                        contentFit="cover"
                    />
                    {!disabled && (
                        <Pressable
                            style={styles.removeButton}
                            onPress={() => onRemove(index)}
                            hitSlop={8}
                        >
                            <View style={styles.removeIcon}>
                                <View style={styles.removeLine1} />
                                <View style={styles.removeLine2} />
                            </View>
                        </Pressable>
                    )}
                </View>
            ))}
        </ScrollView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        maxHeight: THUMBNAIL_SIZE + 16,
    },
    content: {
        paddingHorizontal: 8,
        paddingVertical: 8,
        gap: 8,
        flexDirection: 'row',
    },
    imageWrapper: {
        position: 'relative',
    },
    removeButton: {
        position: 'absolute',
        top: -6,
        right: -6,
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: theme.colors.deleteAction,
        justifyContent: 'center',
        alignItems: 'center',
    },
    removeIcon: {
        width: 10,
        height: 10,
        justifyContent: 'center',
        alignItems: 'center',
    },
    removeLine1: {
        position: 'absolute',
        width: 10,
        height: 2,
        backgroundColor: 'white',
        transform: [{ rotate: '45deg' }],
    },
    removeLine2: {
        position: 'absolute',
        width: 10,
        height: 2,
        backgroundColor: 'white',
        transform: [{ rotate: '-45deg' }],
    },
}));
