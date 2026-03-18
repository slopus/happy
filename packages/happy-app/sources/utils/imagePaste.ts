export interface ClipboardImagePasteEventLike {
    defaultPrevented?: boolean;
    preventDefault: () => void;
    clipboardData?: {
        items?: ArrayLike<{
            type: string;
            getAsFile: () => File | null;
        }> | null;
    } | null;
}

interface HandleImagePasteEventOptions {
    isScreenFocused: boolean;
    canAddMore: boolean;
    supportsImages: boolean;
    onImageFile: (file: File, mimeType: string) => Promise<void> | void;
}

export async function handleImagePasteEvent(
    event: ClipboardImagePasteEventLike,
    options: HandleImagePasteEventOptions,
): Promise<boolean> {
    const { isScreenFocused, canAddMore, supportsImages, onImageFile } = options;

    if (!isScreenFocused || !canAddMore || !supportsImages || event.defaultPrevented) {
        return false;
    }

    const items = event.clipboardData?.items;
    if (!items) {
        return false;
    }

    for (const item of Array.from(items)) {
        if (!item.type.startsWith('image/')) {
            continue;
        }

        const file = item.getAsFile();
        if (!file) {
            return false;
        }

        event.preventDefault();
        await onImageFile(file, item.type);
        return true;
    }

    return false;
}
