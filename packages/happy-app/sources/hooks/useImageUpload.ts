import * as React from 'react';
import { Platform } from 'react-native';
import { Modal } from '@/modal';
import { t } from '@/text';
import { pickAndUploadImages, uploadBase64Image, blobToResizedBase64, MAX_IMAGES } from '@/utils/imageUpload';
import { useHappyAction } from '@/hooks/useHappyAction';
import { AsyncLock } from '@/utils/lock';

export interface UseImageUploadResult {
    pendingImagePaths: string[];
    isPickingImage: boolean;
    isProcessingImage: boolean;
    /** Current paths ref — always reflects the latest value for use in callbacks. */
    pendingImagePathsRef: React.RefObject<string[]>;
    doPickImage: () => void;
    handleImagePaste: ((blob: Blob) => void) | undefined;
    setPendingImagePaths: React.Dispatch<React.SetStateAction<string[]>>;
}

/**
 * Encapsulates image upload state: picking, pasting, processing, and pending paths.
 *
 * Uses an AsyncLock to serialize pick and paste operations, preventing races where
 * a paste during an open picker could exceed MAX_IMAGES or silently discard uploads.
 *
 * Uses a dual-tracking pattern for processing state:
 * - `isProcessingImage` (state): drives UI loading indicators
 * - The AsyncLock provides the synchronous mutual exclusion guarantee.
 */
export function useImageUpload(sessionId: string): UseImageUploadResult {
    const [pendingImagePaths, setPendingImagePaths] = React.useState<string[]>([]);
    const [isProcessingImage, setIsProcessingImage] = React.useState(false);
    const mountedRef = React.useRef(true);
    React.useEffect(() => { return () => { mountedRef.current = false; }; }, []);

    // Serialize pick and paste operations to prevent concurrent races
    const uploadLockRef = React.useRef(new AsyncLock());

    // Ref kept in sync with state so callbacks always read the latest value.
    // Updated in useEffect to be safe under React concurrent mode.
    const pendingImagePathsRef = React.useRef(pendingImagePaths);
    React.useEffect(() => { pendingImagePathsRef.current = pendingImagePaths; }, [pendingImagePaths]);

    // Pick images from gallery/file picker
    const [isPickingImage, doPickImage] = useHappyAction(React.useCallback(async () => {
        await uploadLockRef.current.inLock(async () => {
            const result = await pickAndUploadImages(sessionId, pendingImagePathsRef.current.length);
            if (!mountedRef.current) return;
            if (result) {
                setPendingImagePaths(prev => {
                    const remaining = MAX_IMAGES - prev.length;
                    return remaining <= 0 ? prev : [...prev, ...result.paths.slice(0, remaining)];
                });
                if (result.failedCount > 0) {
                    const total = result.paths.length + result.failedCount;
                    Modal.alert(t('common.error'), t('session.imageUploadFailed', { failed: result.failedCount, total }));
                }
            }
        });
    }, [sessionId]));

    // Handle clipboard image paste (web only)
    const handleImagePaste = React.useCallback(async (blob: Blob) => {
        try {
            if (pendingImagePathsRef.current.length >= MAX_IMAGES) return;
            await uploadLockRef.current.inLock(async () => {
                // Re-check under lock — a concurrent pick may have filled it
                if (pendingImagePathsRef.current.length >= MAX_IMAGES) return;
                if (!mountedRef.current) return;
                setIsProcessingImage(true);
                try {
                    const base64 = await blobToResizedBase64(blob);
                    if (pendingImagePathsRef.current.length >= MAX_IMAGES) return;
                    const path = await uploadBase64Image(sessionId, base64);
                    if (!mountedRef.current) return;
                    setPendingImagePaths(prev => prev.length >= MAX_IMAGES ? prev : [...prev, path]);
                } catch (err) {
                    if (!mountedRef.current) return;
                    const errorMessage = err instanceof Error ? err.message : t('session.couldNotAttachFile');
                    Modal.alert(t('common.error'), errorMessage);
                } finally {
                    if (mountedRef.current) {
                        setIsProcessingImage(false);
                    }
                }
            });
        } catch (e) {
            // Swallow lock-acquisition or unexpected errors — paste failures should not crash the UI
            console.error('handleImagePaste failed:', e);
        }
    }, [sessionId]);

    return {
        pendingImagePaths,
        isPickingImage,
        isProcessingImage,
        pendingImagePathsRef,
        doPickImage,
        handleImagePaste: Platform.OS === 'web' ? handleImagePaste : undefined,
        setPendingImagePaths,
    };
}
