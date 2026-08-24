/**
 * Image picker hook for attaching images to messages.
 *
 * Wraps expo-image-picker with permission handling and thumbhash generation.
 * Enforces limits: max 20 images per message, 10MB per file.
 *
 * On iOS/Android, tapping the picker button shows an action sheet to choose
 * between the photo library and the camera. On web it opens the file picker
 * directly.
 *
 * Note: fileSize from expo-image-picker is optional -- some platforms do not
 * provide it (returns undefined -> size=0). Such files pass the client-side
 * size check; the server enforces the limit on upload.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';
import { Modal } from '@/modal';
import { generateThumbhash } from '@/utils/thumbhash';
import { t } from '@/text';
import type { AttachmentPreview } from '@/sync/attachmentTypes';

export const MAX_IMAGES_PER_MESSAGE = 20;
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export type { AttachmentPreview };

/** Accepted media library permission statuses. 'limited' = iOS 14+ user-selected photos; PHPickerViewController still works. */
export function isPermissionAccepted(status: string): boolean {
    return status === 'granted' || status === 'limited';
}

type UseImagePickerResult = {
    selectedImages: AttachmentPreview[];
    pickImages: () => Promise<void>;
    removeImage: (id: string) => void;
    clearImages: () => void;
    addImages: (images: AttachmentPreview[]) => void;
};

export function useImagePicker(): UseImagePickerResult {
    const [selectedImages, setSelectedImages] = useState<AttachmentPreview[]>([]);
    const selectedCountRef = useRef(0);
    useEffect(() => {
        selectedCountRef.current = selectedImages.length;
    }, [selectedImages]);

    const requestLibraryPermission = useCallback(async (): Promise<boolean> => {
        if (Platform.OS === 'web') return true;
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!isPermissionAccepted(status)) {
            Modal.alert(
                t('imageUpload.permissionTitle'),
                t('imageUpload.permissionMessage'),
                [{ text: t('common.ok') }],
            );
            return false;
        }
        return true;
    }, []);

    const requestCameraPermission = useCallback(async (): Promise<boolean> => {
        const { status } = await ImagePicker.requestCameraPermissionsAsync();
        if (status !== 'granted') {
            Modal.alert(
                t('imageUpload.cameraPermissionTitle'),
                t('imageUpload.cameraPermissionMessage'),
                [{ text: t('common.ok') }],
            );
            return false;
        }
        return true;
    }, []);

    const processAssets = useCallback(async (
        assets: ImagePicker.ImagePickerAsset[],
    ): Promise<AttachmentPreview[]> => {
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
            const thumbhash = (asset.width > 0 && asset.height > 0)
                ? await generateThumbhash(asset.uri, asset.width, asset.height)
                : undefined;
            previews.push({
                id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
                uri: asset.uri,
                width: asset.width,
                height: asset.height,
                mimeType: asset.mimeType ?? 'image/jpeg',
                size,
                name: asset.fileName ?? `image_${Date.now()}.jpg`,
                thumbhash,
            });
        }
        return previews;
    }, []);

    const openLibrary = useCallback(async () => {
        const hasPermission = await requestLibraryPermission();
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
            mediaTypes: ['images'],
            allowsMultipleSelection: true,
            selectionLimit: remaining,
            quality: 1,
            exif: false,
        });

        if (result.canceled || !result.assets.length) return;

        // On web, selectionLimit is not enforced by the browser -- clamp here.
        const previews = await processAssets(result.assets.slice(0, remaining));
        if (previews.length > 0) {
            setSelectedImages(prev => [...prev, ...previews].slice(0, MAX_IMAGES_PER_MESSAGE));
        }
    }, [requestLibraryPermission, processAssets]);

    const openCamera = useCallback(async () => {
        const hasPermission = await requestCameraPermission();
        if (!hasPermission) return;

        if (selectedCountRef.current >= MAX_IMAGES_PER_MESSAGE) {
            Modal.alert(
                t('imageUpload.limitTitle'),
                t('imageUpload.limitMessage', { max: MAX_IMAGES_PER_MESSAGE }),
                [{ text: t('common.ok') }],
            );
            return;
        }

        const result = await ImagePicker.launchCameraAsync({
            mediaTypes: ['images'],
            quality: 1,
            exif: false,
        });

        if (result.canceled || !result.assets.length) return;

        const previews = await processAssets(result.assets);
        if (previews.length > 0) {
            setSelectedImages(prev => [...prev, ...previews].slice(0, MAX_IMAGES_PER_MESSAGE));
        }
    }, [requestCameraPermission, processAssets]);

    const pickImages = useCallback(async () => {
        if (Platform.OS === 'web') {
            await openLibrary();
            return;
        }
        // iOS/Android: let user choose source via alert.
        await new Promise<void>((resolve) => {
            Modal.alert(
                t('imageUpload.sourceTitle'),
                '',
                [
                    {
                        text: t('imageUpload.sourceLibrary'),
                        onPress: () => { openLibrary().finally(resolve); },
                    },
                    {
                        text: t('imageUpload.sourceCamera'),
                        onPress: () => { openCamera().finally(resolve); },
                    },
                    {
                        text: t('common.cancel'),
                        style: 'cancel',
                        onPress: () => resolve(),
                    },
                ],
            );
        });
    }, [openLibrary, openCamera]);

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
