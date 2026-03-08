import * as React from 'react';
import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { Modal } from '@/modal';
import { LocalImage } from '@/components/ImagePreview';

const MAX_DIMENSION = 1024;
const JPEG_QUALITY = 0.8;
const DEFAULT_MAX_IMAGES = 4;
const DEFAULT_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

interface UseImagePickerOptions {
    maxImages?: number;
    maxSizeBytes?: number;
    allowedTypes?: string[];
}

interface UseImagePickerReturn {
    images: LocalImage[];
    pickFromGallery: () => Promise<void>;
    pickFromCamera: () => Promise<void>;
    addImageFromUri: (uri: string, mimeType: string) => Promise<void>;
    removeImage: (index: number) => void;
    clearImages: () => void;
    initImages: (images: LocalImage[]) => void;
    canAddMore: boolean;
}

/**
 * Compress image with aspect ratio preservation.
 * If either dimension exceeds MAX_DIMENSION, scale down proportionally.
 * Always apply JPEG quality compression.
 *
 * For very large images (>4096px), uses a two-step resize to reduce memory pressure:
 * first halve the dimensions, then resize to the target.
 */
async function compressImage(
    uri: string,
    originalWidth: number,
    originalHeight: number
): Promise<{ uri: string; width: number; height: number }> {
    let currentUri = uri;
    let currentWidth = originalWidth;
    let currentHeight = originalHeight;

    // For very large images, do a coarse resize first to reduce memory pressure
    const LARGE_THRESHOLD = 4096;
    if (currentWidth > LARGE_THRESHOLD || currentHeight > LARGE_THRESHOLD) {
        const halfWidth = Math.round(currentWidth / 2);
        const halfHeight = Math.round(currentHeight / 2);
        const preResult = await ImageManipulator.manipulateAsync(
            currentUri,
            [{ resize: { width: halfWidth, height: halfHeight } }],
            { compress: 1, format: ImageManipulator.SaveFormat.JPEG }
        );
        currentUri = preResult.uri;
        currentWidth = preResult.width;
        currentHeight = preResult.height;
    }

    const actions: ImageManipulator.Action[] = [];

    // Resize to fit within MAX_DIMENSION if still needed
    if (currentWidth > MAX_DIMENSION || currentHeight > MAX_DIMENSION) {
        const scale = Math.min(MAX_DIMENSION / currentWidth, MAX_DIMENSION / currentHeight);
        const newWidth = Math.round(currentWidth * scale);
        const newHeight = Math.round(currentHeight * scale);
        actions.push({ resize: { width: newWidth, height: newHeight } });
    }

    const manipResult = await ImageManipulator.manipulateAsync(
        currentUri,
        actions,
        { compress: JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG }
    );

    return {
        uri: manipResult.uri,
        width: manipResult.width,
        height: manipResult.height,
    };
}

export function useImagePicker(options: UseImagePickerOptions = {}): UseImagePickerReturn {
    const {
        maxImages = DEFAULT_MAX_IMAGES,
        allowedTypes = DEFAULT_ALLOWED_TYPES,
    } = options;

    const [images, setImages] = React.useState<LocalImage[]>([]);

    const canAddMore = images.length < maxImages;

    const addImages = React.useCallback(async (newImages: ImagePicker.ImagePickerAsset[]) => {
        const remaining = maxImages - images.length;
        const toAdd = newImages.slice(0, remaining);

        const processed: LocalImage[] = [];
        for (const img of toAdd) {
            const mimeType = img.mimeType || 'image/jpeg';
            if (!allowedTypes.includes(mimeType)) {
                continue;
            }

            try {
                // Always compress (resize if needed + quality compression)
                const compressed = await compressImage(img.uri, img.width, img.height);
                processed.push({
                    uri: compressed.uri,
                    width: compressed.width,
                    height: compressed.height,
                    mimeType: 'image/jpeg',
                });
            } catch (error) {
                console.warn('[ImagePicker] Failed to compress image, using original:', error);
                // Fallback: use original image without compression
                processed.push({
                    uri: img.uri,
                    width: img.width,
                    height: img.height,
                    mimeType,
                });
            }
        }

        setImages(prev => [...prev, ...processed]);
    }, [images.length, maxImages, allowedTypes]);

    const pickFromGallery = React.useCallback(async () => {
        if (!canAddMore) {
            Modal.alert('Limit Reached', `Maximum ${maxImages} images allowed`);
            return;
        }

        try {
            const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
            if (!permission.granted) {
                Modal.alert('Permission Required', 'Please allow access to your photo library in settings');
                return;
            }

            const result = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ['images'],
                allowsMultipleSelection: true,
                selectionLimit: maxImages - images.length,
                quality: 0.8,
            });

            if (!result.canceled && result.assets.length > 0) {
                await addImages(result.assets);
            }
        } catch (error) {
            console.error('[ImagePicker] Gallery pick failed:', error);
            Modal.alert('Error', 'Failed to select image. Please try again.');
        }
    }, [canAddMore, maxImages, images.length, addImages]);

    const pickFromCamera = React.useCallback(async () => {
        if (!canAddMore) {
            Modal.alert('Limit Reached', `Maximum ${maxImages} images allowed`);
            return;
        }

        try {
            const permission = await ImagePicker.requestCameraPermissionsAsync();
            if (!permission.granted) {
                Modal.alert('Permission Required', 'Please allow access to your camera in settings');
                return;
            }

            const result = await ImagePicker.launchCameraAsync({
                mediaTypes: ['images'],
                quality: 0.8,
            });

            if (!result.canceled && result.assets.length > 0) {
                await addImages(result.assets);
            }
        } catch (error) {
            console.error('[ImagePicker] Camera pick failed:', error);
            Modal.alert('Error', 'Failed to capture image. Please try again.');
        }
    }, [canAddMore, maxImages, addImages]);

    /**
     * Add an image from a URI (used for clipboard paste and web file input).
     * Supports both data URIs and blob URLs.
     */
    const addImageFromUri = React.useCallback(async (uri: string, mimeType: string) => {
        if (!canAddMore) {
            Modal.alert('Limit Reached', `Maximum ${maxImages} images allowed`);
            return;
        }

        if (!allowedTypes.includes(mimeType)) {
            Modal.alert('Invalid Type', 'Only JPEG and PNG images are supported');
            return;
        }

        // For web blob URLs or data URIs, we need to get dimensions
        if (Platform.OS === 'web') {
            // Create an image element to get dimensions
            const img = new Image();
            img.src = uri;
            await new Promise<void>((resolve, reject) => {
                img.onload = () => resolve();
                img.onerror = reject;
            });

            const width = img.naturalWidth;
            const height = img.naturalHeight;

            // Always compress (resize if needed + quality compression)
            const compressed = await compressImage(uri, width, height);
            setImages(prev => [...prev, {
                uri: compressed.uri,
                width: compressed.width,
                height: compressed.height,
                mimeType: 'image/jpeg',
            }]);
        } else {
            // For native, use a default size (will be properly sized during upload)
            setImages(prev => [...prev, {
                uri,
                width: 512,
                height: 512,
                mimeType,
            }]);
        }
    }, [canAddMore, maxImages, allowedTypes]);

    const removeImage = React.useCallback((index: number) => {
        setImages(prev => prev.filter((_, i) => i !== index));
    }, []);

    const clearImages = React.useCallback(() => {
        setImages([]);
    }, []);

    const initImages = React.useCallback((newImages: LocalImage[]) => {
        setImages(newImages.slice(0, maxImages));
    }, [maxImages]);

    return {
        images,
        pickFromGallery,
        pickFromCamera,
        addImageFromUri,
        removeImage,
        clearImages,
        initImages,
        canAddMore,
    };
}
