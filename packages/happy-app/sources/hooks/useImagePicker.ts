/**
 * Image picker hook for attaching images to messages.
 *
 * Wraps expo-image-picker with permission handling and thumbhash generation.
 * Enforces limits: max 20 images per message, 10MB per file.
 *
 * Note: fileSize from expo-image-picker is optional — some platforms do not
 * provide it (returns undefined → size=0). Such files pass the client-side
 * size check; the server enforces the limit on upload. Phase 5 should handle
 * 413 responses gracefully.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { Platform } from 'react-native';
import { Modal } from '@/modal';
import { generateThumbhash } from '@/utils/thumbhash';
import { t } from '@/text';
import type { AttachmentPreview } from '@/sync/attachmentTypes';

export const MAX_IMAGES_PER_MESSAGE = 20;
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const IOS_ATTACHMENT_JPEG_QUALITY = 0.92;

export type { AttachmentPreview };

type UseImagePickerResult = {
    selectedImages: AttachmentPreview[];
    pickImages: () => Promise<void>;
    removeImage: (id: string) => void;
    clearImages: () => void;
    addImages: (images: AttachmentPreview[]) => void;
};

function withJpegExtension(fileName: string | null | undefined): string {
    const fallback = `image_${Date.now()}.jpg`;
    const name = fileName?.trim() || fallback;
    const extensionIndex = name.lastIndexOf('.');
    const stem = extensionIndex > 0 ? name.slice(0, extensionIndex) : name;
    return `${stem}.jpg`;
}

export async function normalizePickedAssetForUpload(asset: ImagePicker.ImagePickerAsset): Promise<{
    uri: string;
    width: number;
    height: number;
    mimeType: string;
    name: string;
}> {
    if (Platform.OS !== 'ios') {
        return {
            uri: asset.uri,
            width: asset.width,
            height: asset.height,
            mimeType: asset.mimeType ?? 'image/jpeg',
            name: asset.fileName ?? `image_${Date.now()}.jpg`,
        };
    }

    const converted = await manipulateAsync(asset.uri, [], {
        compress: IOS_ATTACHMENT_JPEG_QUALITY,
        format: SaveFormat.JPEG,
    });

    return {
        uri: converted.uri,
        width: converted.width || asset.width,
        height: converted.height || asset.height,
        mimeType: 'image/jpeg',
        name: withJpegExtension(asset.fileName),
    };
}

export function useImagePicker(): UseImagePickerResult {
    const [selectedImages, setSelectedImages] = useState<AttachmentPreview[]>([]);
    // Ref tracks current count to avoid stale closures on rapid taps.
    const selectedCountRef = useRef(0);
    useEffect(() => {
        selectedCountRef.current = selectedImages.length;
    }, [selectedImages]);

    const requestPermission = useCallback(async (): Promise<boolean> => {
        if (Platform.OS === 'web') return true;

        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== 'granted') {
            Modal.alert(
                t('imageUpload.permissionTitle'),
                t('imageUpload.permissionMessage'),
                [{ text: t('common.ok') }],
            );
            return false;
        }
        return true;
    }, []);

    const pickImages = useCallback(async () => {
        const hasPermission = await requestPermission();
        if (!hasPermission) return;

        const remaining = MAX_IMAGES_PER_MESSAGE - selectedCountRef.current;
        if (remaining <= 0) {
            Modal.alert(
                t('imageUpload.limitTitle'),
                t('imageUpload.limitMessage', { max: MAX_IMAGES_PER_MESSAGE }),
                [{ text: t('common.ok') }],
            );
            return;
        }

        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'], // expo-image-picker ~55: MediaTypeOptions deprecated
            allowsMultipleSelection: true,
            selectionLimit: remaining,
            quality: 1, // request full-resolution source; iOS upload is normalized below
            exif: false,
        });

        if (result.canceled || !result.assets.length) return;

        // On web, selectionLimit is not enforced by the browser — clamp here.
        const assets = result.assets.slice(0, remaining);
        const previews: AttachmentPreview[] = [];

        for (const asset of assets) {
            const size = asset.fileSize ?? 0;

            if (size > MAX_FILE_SIZE) {
                Modal.alert(
                    t('imageUpload.fileTooLargeTitle'),
                    t('imageUpload.fileTooLargeMessage', { name: asset.fileName ?? 'image', maxMb: 10 }),
                    [{ text: t('common.ok') }],
                );
                continue;
            }

            const normalized = await normalizePickedAssetForUpload(asset);

            // Skip thumbhash if dimensions are unavailable (prevents divide-by-zero).
            const thumbhash = (normalized.width > 0 && normalized.height > 0)
                ? await generateThumbhash(normalized.uri, normalized.width, normalized.height)
                : undefined;

            previews.push({
                id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
                uri: normalized.uri,
                width: normalized.width,
                height: normalized.height,
                mimeType: normalized.mimeType,
                size,
                name: normalized.name,
                thumbhash,
            });
        }

        if (previews.length > 0) {
            setSelectedImages(prev => [...prev, ...previews].slice(0, MAX_IMAGES_PER_MESSAGE));
        }
    }, [requestPermission]);

    const removeImage = useCallback((id: string) => {
        setSelectedImages(prev => prev.filter(img => img.id !== id));
    }, []);

    const clearImages = useCallback(() => {
        setSelectedImages([]);
    }, []);

    const addImages = useCallback((images: AttachmentPreview[]) => {
        setSelectedImages(prev => {
            const remaining = MAX_IMAGES_PER_MESSAGE - prev.length;
            if (remaining <= 0) return prev;
            return [...prev, ...images.slice(0, remaining)];
        });
    }, []);

    return { selectedImages, pickImages, removeImage, clearImages, addImages };
}
