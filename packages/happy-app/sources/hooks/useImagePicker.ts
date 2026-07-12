/**
 * Image/file picker hook for attaching content to messages.
 *
 * Built on the upstream gallery + normalize foundation, extended with:
 *   - takePhoto   — camera capture (expo-image-picker), same normalize path
 *   - pickFiles   — document picker (expo-document-picker), no normalization
 *   - pasteImage  — clipboard image (expo-clipboard), staged then normalized
 *
 * Image assets (gallery/camera/paste) run through normalizePickedAssetForUpload
 * (iOS HEIC→JPEG re-encode). Enforces limits: max 20 attachments per message,
 * 10MB per file.
 *
 * Note: fileSize from expo-image-picker is optional — some platforms do not
 * provide it (returns undefined → size=0). Such files pass the client-side
 * size check; the server enforces the limit on upload. Phase 5 should handle
 * 413 responses gracefully.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Clipboard from 'expo-clipboard';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { writeAsStringAsync, cacheDirectory, EncodingType } from 'expo-file-system/legacy';
import { randomUUID } from 'expo-crypto';
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
    takePhoto: () => Promise<void>;
    pickFiles: () => Promise<void>;
    pasteImage: () => Promise<void>;
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

    // Shared by gallery + camera + paste: enforce size cap, normalize the asset
    // (iOS HEIC→JPEG via normalizePickedAssetForUpload), generate thumbhash.
    const buildImagePreview = useCallback(async (asset: ImagePicker.ImagePickerAsset): Promise<AttachmentPreview | null> => {
        const size = asset.fileSize ?? 0;

        if (size > MAX_FILE_SIZE) {
            Modal.alert(
                t('imageUpload.fileTooLargeTitle'),
                t('imageUpload.fileTooLargeMessage', { name: asset.fileName ?? 'image', maxMb: 10 }),
                [{ text: t('common.ok') }],
            );
            return null;
        }

        const normalized = await normalizePickedAssetForUpload(asset);

        // Skip thumbhash if dimensions are unavailable (prevents divide-by-zero).
        const thumbhash = (normalized.width > 0 && normalized.height > 0)
            ? await generateThumbhash(normalized.uri, normalized.width, normalized.height)
            : undefined;

        return {
            id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
            uri: normalized.uri,
            width: normalized.width,
            height: normalized.height,
            mimeType: normalized.mimeType,
            size,
            name: normalized.name,
            thumbhash,
        };
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
            const preview = await buildImagePreview(asset);
            if (preview) previews.push(preview);
        }

        if (previews.length > 0) {
            setSelectedImages(prev => [...prev, ...previews].slice(0, MAX_IMAGES_PER_MESSAGE));
        }
    }, [requestPermission, buildImagePreview]);

    const takePhoto = useCallback(async () => {
        if (Platform.OS !== 'web') {
            const { status } = await ImagePicker.requestCameraPermissionsAsync();
            if (status !== 'granted') {
                Modal.alert(
                    t('imageUpload.cameraPermissionTitle'),
                    t('imageUpload.cameraPermissionMessage'),
                    [{ text: t('common.ok') }],
                );
                return;
            }
        }
        if (MAX_IMAGES_PER_MESSAGE - selectedCountRef.current <= 0) {
            Modal.alert(
                t('imageUpload.limitTitle'),
                t('imageUpload.limitMessage', { max: MAX_IMAGES_PER_MESSAGE }),
                [{ text: t('common.ok') }],
            );
            return;
        }

        const result = await ImagePicker.launchCameraAsync({
            mediaTypes: ['images'],
            quality: 1, // full-resolution source; upload is normalized below
            exif: false,
        });
        if (result.canceled || !result.assets.length) return;

        const previews: AttachmentPreview[] = [];
        for (const asset of result.assets) {
            const preview = await buildImagePreview(asset);
            if (preview) previews.push(preview);
        }
        if (previews.length > 0) {
            setSelectedImages(prev => [...prev, ...previews].slice(0, MAX_IMAGES_PER_MESSAGE));
        }
    }, [buildImagePreview]);

    const pickFiles = useCallback(async () => {
        const remaining = MAX_IMAGES_PER_MESSAGE - selectedCountRef.current;
        if (remaining <= 0) {
            Modal.alert(
                t('imageUpload.limitTitle'),
                t('imageUpload.limitMessage', { max: MAX_IMAGES_PER_MESSAGE }),
                [{ text: t('common.ok') }],
            );
            return;
        }

        const result = await DocumentPicker.getDocumentAsync({
            multiple: true,
            copyToCacheDirectory: true,
        });
        if (result.canceled || !result.assets) return;

        const previews: AttachmentPreview[] = [];
        for (const asset of result.assets.slice(0, remaining)) {
            const size = asset.size ?? 0;
            if (size > MAX_FILE_SIZE) {
                Modal.alert(
                    t('imageUpload.fileTooLargeTitle'),
                    t('imageUpload.fileTooLargeMessage', { name: asset.name, maxMb: 10 }),
                    [{ text: t('common.ok') }],
                );
                continue;
            }
            previews.push({
                id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
                uri: asset.uri,
                width: 0,
                height: 0,
                mimeType: asset.mimeType ?? 'application/octet-stream',
                size,
                name: asset.name,
                thumbhash: undefined,
            });
        }
        if (previews.length > 0) {
            setSelectedImages(prev => [...prev, ...previews].slice(0, MAX_IMAGES_PER_MESSAGE));
        }
    }, []);

    // Paste an image from the system clipboard (iOS/Android). Clipboard returns
    // a base64 data URI; the upload path needs a file:// URI (readFileBytes uses
    // expo-file-system), so we stage the bytes to cacheDirectory first, then run
    // it through the same normalize/thumbhash pipeline as picked images.
    const pasteImage = useCallback(async () => {
        const remaining = MAX_IMAGES_PER_MESSAGE - selectedCountRef.current;
        if (remaining <= 0) {
            Modal.alert(
                t('imageUpload.limitTitle'),
                t('imageUpload.limitMessage', { max: MAX_IMAGES_PER_MESSAGE }),
                [{ text: t('common.ok') }],
            );
            return;
        }

        const image = await Clipboard.getImageAsync({ format: 'jpeg' }).catch(() => null);
        // null here means the clipboard image is gone or iOS denied paste access
        // (the two are indistinguishable on iOS 16+).
        if (!image) {
            Modal.alert(
                t('imageUpload.pasteFailedTitle'),
                t('imageUpload.pasteFailedMessage'),
                [{ text: t('common.ok') }],
            );
            return;
        }

        if (!cacheDirectory) return;
        const base64 = image.data.replace(/^data:image\/\w+;base64,/, '');
        const uri = `${cacheDirectory}happy-paste-${randomUUID()}.jpg`;
        await writeAsStringAsync(uri, base64, { encoding: EncodingType.Base64 });

        const asset = {
            uri,
            width: image.size.width,
            height: image.size.height,
            mimeType: 'image/jpeg',
            fileName: `pasted_${Date.now()}.jpg`,
            fileSize: undefined,
        } as ImagePicker.ImagePickerAsset;

        const preview = await buildImagePreview(asset);
        if (preview) {
            setSelectedImages(prev => [...prev, preview].slice(0, MAX_IMAGES_PER_MESSAGE));
        }
    }, [buildImagePreview]);

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

    return { selectedImages, pickImages, takePhoto, pickFiles, pasteImage, removeImage, clearImages, addImages };
}
