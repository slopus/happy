/**
 * Image picker hook for attaching images to messages.
 *
 * Wraps expo-image-picker with permission handling and thumbhash generation.
 * Enforces limits: max 20 images per message, 10MB per file.
 */
import { useState, useCallback } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Platform, Alert } from 'react-native';
import { generateThumbhash } from '@/utils/thumbhash';
import { t } from '@/text';

export const MAX_IMAGES_PER_MESSAGE = 20;
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export type AttachmentPreview = {
    uri: string;
    width: number;
    height: number;
    mimeType: string;
    size: number;
    name: string;
    thumbhash?: string;
};

type UseImagePickerResult = {
    selectedImages: AttachmentPreview[];
    pickImages: () => Promise<void>;
    removeImage: (index: number) => void;
    clearImages: () => void;
};

export function useImagePicker(): UseImagePickerResult {
    const [selectedImages, setSelectedImages] = useState<AttachmentPreview[]>([]);

    const requestPermission = useCallback(async (): Promise<boolean> => {
        if (Platform.OS === 'web') return true;

        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== 'granted') {
            Alert.alert(
                t('imageUpload.permissionTitle'),
                t('imageUpload.permissionMessage'),
            );
            return false;
        }
        return true;
    }, []);

    const pickImages = useCallback(async () => {
        const hasPermission = await requestPermission();
        if (!hasPermission) return;

        const remaining = MAX_IMAGES_PER_MESSAGE - selectedImages.length;
        if (remaining <= 0) {
            Alert.alert(
                t('imageUpload.limitTitle'),
                t('imageUpload.limitMessage', { max: MAX_IMAGES_PER_MESSAGE }),
            );
            return;
        }

        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsMultipleSelection: true,
            selectionLimit: remaining,
            quality: 1, // no recompression — preserve original
            exif: false,
        });

        if (result.canceled || !result.assets.length) return;

        const previews: AttachmentPreview[] = [];

        for (const asset of result.assets) {
            const size = asset.fileSize ?? 0;

            if (size > MAX_FILE_SIZE) {
                Alert.alert(
                    t('imageUpload.fileTooLargeTitle'),
                    t('imageUpload.fileTooLargeMessage', { name: asset.fileName ?? 'image', maxMb: 10 }),
                );
                continue;
            }

            const thumbhash = await generateThumbhash(asset.uri, asset.width, asset.height);

            previews.push({
                uri: asset.uri,
                width: asset.width,
                height: asset.height,
                mimeType: asset.mimeType ?? 'image/jpeg',
                size,
                name: asset.fileName ?? `image_${Date.now()}.jpg`,
                thumbhash,
            });
        }

        if (previews.length > 0) {
            setSelectedImages(prev => [...prev, ...previews].slice(0, MAX_IMAGES_PER_MESSAGE));
        }
    }, [selectedImages.length, requestPermission]);

    const removeImage = useCallback((index: number) => {
        setSelectedImages(prev => prev.filter((_, i) => i !== index));
    }, []);

    const clearImages = useCallback(() => {
        setSelectedImages([]);
    }, []);

    return { selectedImages, pickImages, removeImage, clearImages };
}
