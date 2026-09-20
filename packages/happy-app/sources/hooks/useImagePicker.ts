/**
 * Image picker hook for attaching images to messages.
 *
 * Wraps expo-image-picker with permission handling and thumbhash generation.
 * Enforces limits: max 20 images per message, 10MB per file.
 *
 * iOS images are downscaled and measured after JPEG conversion. Other
 * platforms retain the picker's optional fileSize (0 when unavailable).
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { cacheDirectory, getInfoAsync, writeAsStringAsync } from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { Modal } from '@/modal';
import { generateThumbhash } from '@/utils/thumbhash';
import { t } from '@/text';
import type { AttachmentPreview } from '@/sync/attachmentTypes';

export const MAX_IMAGES_PER_MESSAGE = 20;
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const IOS_ATTACHMENT_JPEG_QUALITY = 0.92;
const IOS_ATTACHMENT_MAX_DIMENSION = 3072;
// encryptBlob adds a 24-byte nonce and 16-byte authentication tag.
const IOS_ATTACHMENT_MAX_FILE_SIZE = MAX_FILE_SIZE - 40;

export type { AttachmentPreview };

type UseImagePickerResult = {
    selectedImages: AttachmentPreview[];
    pickImages: () => Promise<void>;
    pasteImages: () => Promise<boolean>;
    attachImages: () => Promise<void>;
    removeImage: (id: string) => void;
    clearImages: () => void;
    addImages: (images: AttachmentPreview[]) => void;
};

/** Splits `data:image/png;base64,AAAA` into its type and its bytes. */
export function readImageDataUri(uri: string): { mimeType: string; base64: string } | null {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(uri.trim());
    if (!match) return null;
    return { mimeType: match[1].toLowerCase(), base64: match[2] };
}

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
    size: number;
}> {
    if (Platform.OS !== 'ios') {
        return {
            uri: asset.uri,
            width: asset.width,
            height: asset.height,
            mimeType: asset.mimeType ?? 'image/jpeg',
            name: asset.fileName ?? `image_${Date.now()}.jpg`,
            size: asset.fileSize ?? 0,
        };
    }

    // Supply only the long edge: Expo preserves aspect ratio without cropping.
    const resize = asset.width >= asset.height
        ? { width: IOS_ATTACHMENT_MAX_DIMENSION }
        : { height: IOS_ATTACHMENT_MAX_DIMENSION };
    const actions = Math.max(asset.width, asset.height) > IOS_ATTACHMENT_MAX_DIMENSION
        ? [{ resize }]
        : [];
    const converted = await manipulateAsync(asset.uri, actions, {
        compress: IOS_ATTACHMENT_JPEG_QUALITY,
        format: SaveFormat.JPEG,
    });

    const info = await getInfoAsync(converted.uri);
    if (!info.exists || info.isDirectory || !Number.isFinite(info.size) || info.size <= 0) {
        throw new Error('Could not determine normalized image size');
    }

    return {
        uri: converted.uri,
        width: converted.width || asset.width,
        height: converted.height || asset.height,
        mimeType: 'image/jpeg',
        name: withJpegExtension(asset.fileName),
        size: info.size,
    };
}

/**
 * One image, normalized and measured, or nothing plus the reason on screen.
 *
 * Shared by picking and pasting so the limits are enforced in one place: a
 * pasted screenshot is as capable of being too large as a chosen photo.
 */
async function previewForAsset(asset: ImagePicker.ImagePickerAsset): Promise<AttachmentPreview | null> {
    let normalized: Awaited<ReturnType<typeof normalizePickedAssetForUpload>>;
    try {
        normalized = await normalizePickedAssetForUpload(asset);
    } catch {
        Modal.alert(
            t('imageUpload.uploadFailedTitle'),
            t('imageUpload.uploadFailedMessage', { count: 1 }),
            [{ text: t('common.ok') }],
        );
        return null;
    }

    const size = normalized.size;
    const maxSize = Platform.OS === 'ios' ? IOS_ATTACHMENT_MAX_FILE_SIZE : MAX_FILE_SIZE;
    if (size > maxSize) {
        Modal.alert(
            t('imageUpload.fileTooLargeTitle'),
            t('imageUpload.fileTooLargeMessage', { name: asset.fileName ?? 'image', maxMb: 10 }),
            [{ text: t('common.ok') }],
        );
        return null;
    }

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
            const preview = await previewForAsset(asset);
            if (preview) previews.push(preview);
        }

        if (previews.length > 0) {
            setSelectedImages(prev => [...prev, ...previews].slice(0, MAX_IMAGES_PER_MESSAGE));
        }
    }, [requestPermission]);

    /**
     * Attaches the image on the clipboard.
     *
     * A pasted image takes the same road as a picked one — same normalizing,
     * same limits, same thumbhash — so nothing downstream can tell where it
     * came from. It arrives as base64 rather than a file, so it is written to
     * the cache first: the upload reads a file, and on Android the picker's own
     * path never converts.
     *
     * Asked for by name, so an empty clipboard is answered rather than passed
     * over in silence. On iOS 16+ a refused paste looks the same as an empty
     * clipboard and gets the same answer. Answers whether anything was
     * attached.
     */
    const pasteImages = useCallback(async (): Promise<boolean> => {
        if (Platform.OS === 'web') return false;
        if (selectedCountRef.current >= MAX_IMAGES_PER_MESSAGE) {
            Modal.alert(
                t('imageUpload.limitTitle'),
                t('imageUpload.limitMessage', { max: MAX_IMAGES_PER_MESSAGE }),
                [{ text: t('common.ok') }],
            );
            return false;
        }

        let pasted: Clipboard.ClipboardImage | null = null;
        try {
            if (await Clipboard.hasImageAsync()) {
                pasted = await Clipboard.getImageAsync({ format: 'png' });
            }
        } catch {
            pasted = null;
        }
        const image = pasted && readImageDataUri(pasted.data);
        if (!pasted || !image) {
            Modal.alert(
                t('imageUpload.nothingToPasteTitle'),
                t('imageUpload.nothingToPasteMessage'),
                [{ text: t('common.ok') }],
            );
            return false;
        }

        let uri: string;
        let fileSize: number;
        try {
            if (!cacheDirectory) throw new Error('No cache directory to paste into');
            uri = `${cacheDirectory}paste_${Date.now()}.png`;
            await writeAsStringAsync(uri, image.base64, { encoding: 'base64' });
            // Measured here because the clipboard hands over bytes rather than
            // a file. A picked photo arrives with its size already known; off
            // iOS nothing downstream measures, so an unmeasured paste would
            // count as nothing and clear the limit however large it is.
            const written = await getInfoAsync(uri);
            if (!written.exists || written.isDirectory || !Number.isFinite(written.size) || written.size <= 0) {
                throw new Error('Could not determine pasted image size');
            }
            fileSize = written.size;
        } catch {
            Modal.alert(
                t('imageUpload.uploadFailedTitle'),
                t('imageUpload.uploadFailedMessage', { count: 1 }),
                [{ text: t('common.ok') }],
            );
            return false;
        }

        const preview = await previewForAsset({
            uri,
            width: pasted.size.width,
            height: pasted.size.height,
            mimeType: image.mimeType,
            fileName: `pasted_${Date.now()}.png`,
            fileSize,
        } as ImagePicker.ImagePickerAsset);
        if (!preview) return false;

        setSelectedImages(prev => (
            prev.length >= MAX_IMAGES_PER_MESSAGE ? prev : [...prev, preview]
        ));
        return true;
    }, []);

    /**
     * What the add button does: asks, every time, whether to paste or to pick.
     *
     * It always asks rather than only when the clipboard holds a picture, so
     * that Paste is somewhere you can see and reach for. A choice that only
     * appeared under a condition read as missing when the condition was not
     * met — and there is no telling from the button whether it was.
     *
     * The web composer already takes a paste and a drop on its own, and there
     * is no cache to paste into there, so on web this stays the button it was.
     */
    const attachImages = useCallback(async () => {
        if (Platform.OS === 'web') {
            await pickImages();
            return;
        }
        Modal.alert(t('imageUpload.attachTitle'), undefined, [
            { text: t('imageUpload.pasteFromClipboard'), onPress: () => { void pasteImages(); } },
            { text: t('imageUpload.chooseFromLibrary'), onPress: () => { void pickImages(); } },
            { text: t('common.cancel'), style: 'cancel' },
        ]);
    }, [pasteImages, pickImages]);

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

    return { selectedImages, pickImages, pasteImages, attachImages, removeImage, clearImages, addImages };
}
