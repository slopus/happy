/**
 * Image picker hook for attaching images to messages.
 *
 * Wraps expo-image-picker with permission handling and thumbhash generation.
 * Enforces limits: max 50 attachments per message, 50MB for images/media,
 * and 10MB for whole-buffer encrypted PDF documents.
 *
 * File sizes reported by platform pickers are treated as hints: images are
 * normalized and measured, while PDFs with a missing size are stat'ed before
 * they can enter the attachment queue.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { getInfoAsync } from 'expo-file-system/legacy';
import { Platform, Keyboard } from 'react-native';
import { Modal } from '@/modal';
import { generateThumbhash } from '@/utils/thumbhash';
import { normalizeImageForUpload } from '@/utils/normalizeImageForUpload';
import { AttachmentSourceSheet } from '@/components/AttachmentSourceSheet';
import { t } from '@/text';
import type { AttachmentPreview, AttachmentKind } from '@/sync/attachmentTypes';
import { MAX_PDF_FILE_SIZE, MAX_PDF_FILE_SIZE_MB } from '@/sync/attachmentLimits';

export const MAX_IMAGES_PER_MESSAGE = 50;
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB — image lane
// Media currently reuses the encrypted transport (server-capped at 50MB). The
// 500MB plaintext-OSS lane is a future server+OSS upgrade.
export const MAX_MEDIA_FILE_SIZE = 50 * 1024 * 1024; // 50MB — audio/video lane
export { MAX_PDF_FILE_SIZE };

interface UseImagePickerOptions {
    maxAttachments?: number;
    maxImageSizeBytes?: number;
    selection?: {
        images: AttachmentPreview[];
        setImages: (update: AttachmentPreview[] | ((current: AttachmentPreview[]) => AttachmentPreview[])) => void;
    };
}

export type { AttachmentPreview };

type UseImagePickerResult = {
    selectedImages: AttachmentPreview[];
    pickImages: () => Promise<AttachmentPreview[]>;
    /** Pick audio/video files via the system document picker (plaintext lane). */
    pickMedia: () => Promise<void>;
    /** Pick PDF documents via the system document picker (encrypted lane). */
    pickPdf: () => Promise<void>;
    /** Show a chooser (photo, audio/video, or PDF), then run the matching picker. */
    pickAttachment: () => void;
    removeImage: (id: string) => void;
    clearImages: () => void;
    addImages: (images: AttachmentPreview[]) => void;
};

/** Classify a document-picker asset's mimeType into our media kinds. */
function mediaKindFromMime(mimeType: string | undefined, name: string): AttachmentKind {
    const mime = (mimeType ?? '').toLowerCase();
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('video/')) return 'video';
    const ext = (name.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase();
    if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'].includes(ext)) return 'audio';
    return 'video';
}

async function getActualDocumentSize(asset: DocumentPicker.DocumentPickerAsset): Promise<number | null> {
    if (asset.file && Number.isFinite(asset.file.size) && asset.file.size >= 0) {
        return asset.file.size;
    }
    try {
        const info = await getInfoAsync(asset.uri);
        if (info.exists && !info.isDirectory && typeof info.size === 'number' && Number.isFinite(info.size)) {
            return info.size;
        }
    } catch {
        // The URI may have expired or become unreadable after the picker closed.
    }
    return null;
}

export function useImagePicker(options: UseImagePickerOptions = {}): UseImagePickerResult {
    const maxAttachments = Math.max(1, Math.min(MAX_IMAGES_PER_MESSAGE, options.maxAttachments ?? MAX_IMAGES_PER_MESSAGE));
    const maxImageSizeBytes = Math.max(1, Math.min(MAX_FILE_SIZE, options.maxImageSizeBytes ?? MAX_FILE_SIZE));
    const maxImageSizeMb = Math.max(1, Math.floor(maxImageSizeBytes / 1024 / 1024));
    const [localImages, setLocalImages] = useState<AttachmentPreview[]>([]);
    const selectedImages = options.selection?.images ?? localImages;
    const setSelectedImages = options.selection?.setImages ?? setLocalImages;
    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);
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
        if (!hasPermission) return [];

        const remaining = maxAttachments - selectedCountRef.current;
        if (remaining <= 0) {
            Modal.alert(
                t('imageUpload.limitTitle'),
                t('imageUpload.limitMessage', { max: maxAttachments }),
                [{ text: t('common.ok') }],
            );
            return [];
        }

        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'], // expo-image-picker ~55: MediaTypeOptions deprecated
            allowsMultipleSelection: true,
            selectionLimit: remaining,
            quality: 1, // don't let the picker recompress — normalizeImageForUpload handles format
            exif: false,
        });

        if (result.canceled || !result.assets.length) return [];

        // On web, selectionLimit is not enforced by the browser — clamp here.
        const assets = result.assets.slice(0, remaining);
        const previews: AttachmentPreview[] = [];
        // Images whose bytes couldn't be read or transcoded to a vision-readable
        // format. Surface these instead of silently dropping them, otherwise the
        // model later reports "no image" for an attachment the user clearly added.
        let unreadableCount = 0;

        for (const asset of assets) {
            if ((asset.fileSize ?? 0) > maxImageSizeBytes) {
                Modal.alert(
                    t('imageUpload.fileTooLargeTitle'),
                    t('imageUpload.fileTooLargeMessage', { name: asset.fileName ?? 'image', maxMb: maxImageSizeMb }),
                    [{ text: t('common.ok') }],
                );
                continue;
            }

            // Normalize to a format the vision models can decode (HEIC/HEIF → JPEG),
            // and read the true byte size (the picker often reports 0).
            let normalized;
            try {
                normalized = await normalizeImageForUpload(asset.uri, asset.width, asset.height);
            } catch {
                unreadableCount++;
                continue;
            }

            if (normalized.size > maxImageSizeBytes) {
                Modal.alert(
                    t('imageUpload.fileTooLargeTitle'),
                    t('imageUpload.fileTooLargeMessage', { name: asset.fileName ?? 'image', maxMb: maxImageSizeMb }),
                    [{ text: t('common.ok') }],
                );
                continue;
            }

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
                size: normalized.size,
                name: asset.fileName ?? `image_${Date.now()}.jpg`,
                thumbhash,
            });
        }

        if (unreadableCount > 0) {
            Modal.alert(
                t('imageUpload.normalizeFailedTitle'),
                t('imageUpload.normalizeFailedMessage', { count: unreadableCount }),
                [{ text: t('common.ok') }],
            );
        }

        if (previews.length > 0 && mountedRef.current) {
            setSelectedImages(prev => [...prev, ...previews].slice(0, maxAttachments));
        }
        return previews;
    }, [maxAttachments, maxImageSizeBytes, maxImageSizeMb, requestPermission]);

    const pickMedia = useCallback(async () => {
        const remaining = maxAttachments - selectedCountRef.current;
        if (remaining <= 0) {
            Modal.alert(
                t('imageUpload.limitTitle'),
                t('imageUpload.limitMessage', { max: maxAttachments }),
                [{ text: t('common.ok') }],
            );
            return;
        }

        // Audio isn't in the photo library and video needs its real container, so
        // media goes through the system document picker, not expo-image-picker.
        const result = await DocumentPicker.getDocumentAsync({
            type: ['audio/*', 'video/*'],
            multiple: true,
            copyToCacheDirectory: true, // stable file:// uri for streaming upload
        });
        if (result.canceled || !result.assets?.length) return;

        const assets = result.assets.slice(0, remaining);
        const previews: AttachmentPreview[] = [];
        for (const asset of assets) {
            const size = asset.size ?? 0;
            if (size > MAX_MEDIA_FILE_SIZE) {
                Modal.alert(
                    t('imageUpload.fileTooLargeTitle'),
                    t('imageUpload.fileTooLargeMessage', { name: asset.name ?? 'file', maxMb: MAX_MEDIA_FILE_SIZE / 1024 / 1024 }),
                    [{ text: t('common.ok') }],
                );
                continue;
            }
            const name = asset.name ?? `media_${Date.now()}`;
            previews.push({
                id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
                uri: asset.uri,
                width: 0,
                height: 0,
                mimeType: asset.mimeType ?? 'application/octet-stream',
                size,
                name,
                kind: mediaKindFromMime(asset.mimeType, name),
            });
        }

        if (previews.length > 0) {
            setSelectedImages(prev => [...prev, ...previews].slice(0, maxAttachments));
        }
    }, [maxAttachments]);

    const pickPdf = useCallback(async () => {
        const remaining = maxAttachments - selectedCountRef.current;
        if (remaining <= 0) {
            Modal.alert(
                t('imageUpload.limitTitle'),
                t('imageUpload.limitMessage', { max: maxAttachments }),
                [{ text: t('common.ok') }],
            );
            return;
        }

        const result = await DocumentPicker.getDocumentAsync({
            type: 'application/pdf',
            multiple: true,
            copyToCacheDirectory: true,
        });
        if (result.canceled || !result.assets?.length) return;

        const previews: AttachmentPreview[] = [];
        for (const asset of result.assets.slice(0, remaining)) {
            const name = asset.name ?? `document_${Date.now()}.pdf`;
            const mimeType = (asset.mimeType ?? '').toLowerCase();
            if (mimeType !== 'application/pdf' && !name.toLowerCase().endsWith('.pdf')) {
                continue;
            }
            // Do not trust picker metadata: native providers can report stale or
            // under-counted sizes. Browser File.size and a native stat are the
            // independent preflight used before any whole-file read occurs.
            const size = await getActualDocumentSize(asset);
            if (size === null) {
                Modal.alert(
                    t('imageUpload.uploadFailedTitle'),
                    t('imageUpload.uploadFailedMessage', { count: 1 }),
                    [{ text: t('common.ok') }],
                );
                continue;
            }
            if (size > MAX_PDF_FILE_SIZE) {
                Modal.alert(
                    t('imageUpload.fileTooLargeTitle'),
                    t('imageUpload.fileTooLargeMessage', { name, maxMb: MAX_PDF_FILE_SIZE_MB }),
                    [{ text: t('common.ok') }],
                );
                continue;
            }
            previews.push({
                id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
                uri: asset.uri,
                width: 0,
                height: 0,
                mimeType: 'application/pdf',
                size,
                name,
                kind: 'file',
            });
        }

        if (previews.length > 0) {
            setSelectedImages(prev => [...prev, ...previews].slice(0, maxAttachments));
        }
    }, [maxAttachments]);

    const pickAttachment = useCallback(() => {
        // Card-style source chooser — see AttachmentSourceSheet.
        const show = () => Modal.show({
            component: AttachmentSourceSheet,
            props: {
                onPickPhoto: () => { void pickImages(); },
                onPickMedia: () => { void pickMedia(); },
                onPickPdf: () => { void pickPdf(); },
            },
        });

        // If the composer keyboard is up, mounting the modal now makes its
        // KeyboardAvoidingView bounce between the keyboard-up and keyboard-down
        // positions while the keyboard animates away. Wait until the keyboard has
        // FULLY hidden before showing the sheet (with a timeout fallback for IMEs
        // that don't emit keyboardDidHide). Dismissing alone isn't enough — the
        // modal must mount into a settled layout.
        if (Keyboard.isVisible()) {
            let shown = false;
            const doShow = () => { if (!shown) { shown = true; show(); } };
            const sub = Keyboard.addListener('keyboardDidHide', () => { sub.remove(); doShow(); });
            setTimeout(() => { sub.remove(); doShow(); }, 400);
            Keyboard.dismiss();
        } else {
            show();
        }
    }, [pickImages, pickMedia, pickPdf]);

    const removeImage = useCallback((id: string) => {
        setSelectedImages(prev => prev.filter(img => img.id !== id));
    }, []);

    const clearImages = useCallback(() => {
        selectedCountRef.current = 0;
        setSelectedImages([]);
    }, []);

    const addImages = useCallback((images: AttachmentPreview[]) => {
        setSelectedImages(prev => {
            const remaining = maxAttachments - prev.length;
            if (remaining <= 0) return prev;
            return [...prev, ...images.slice(0, remaining)];
        });
    }, [maxAttachments]);

    return { selectedImages, pickImages, pickMedia, pickPdf, pickAttachment, removeImage, clearImages, addImages };
}
