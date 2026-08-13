/**
 * Global fullscreen image viewer state.
 *
 * Any thumbnail (composer attachment strip, sent-image FileView, markdown image)
 * calls `imageViewer.open(...)` to present a pinch-to-zoom fullscreen viewer.
 * A single host (`ImageViewerHost`, mounted once at the app root) subscribes to
 * this store and renders the viewer — this avoids passing potentially huge
 * data: URIs through expo-router params.
 *
 * The viewer is a horizontal pager: `open` accepts either a single image or a
 * whole gallery (`sources[]` + the tapped `index`), so the user can swipe left
 * and right between every image in a run (Kimi-style) without leaving the
 * fullscreen view.
 */
import { create } from 'zustand';
import type { MotionPhotoMetadata } from '@/sync/attachmentTypes';
import type { ImageDownloadSource } from '@/utils/imageDownloadCore';

export interface ImageViewerSource extends ImageDownloadSource {
    /** Image URI — local file://, remote http(s):// or a data: URI. */
    uri: string;
    /** Optional filename used by the viewer's download action. */
    filename?: string;
    /** Optional intrinsic size; lets the viewer fit the image before it loads. */
    width?: number;
    height?: number;
    /** Encrypted attachment identity used to load the full-resolution source lazily. */
    sessionId?: string;
    attachmentRef?: string;
    /** Identifies a JPEG whose embedded MP4 can be played from the viewer. */
    motionPhoto?: MotionPhotoMetadata;
    /** Optional contextual action shown in the fullscreen viewer. */
    actionLabel?: string;
    onAction?: () => void;
}

interface ImageViewerState {
    visible: boolean;
    /** All images in the current run, in display order. */
    sources: ImageViewerSource[];
    /** Index of the image currently shown / initially focused. */
    index: number;
    open: (sources: ImageViewerSource | ImageViewerSource[], index?: number) => void;
    close: () => void;
    clear: () => void;
}

export const useImageViewerStore = create<ImageViewerState>()((set) => ({
    visible: false,
    sources: [],
    index: 0,
    open: (sources, index = 0) => {
        const list = Array.isArray(sources) ? sources : [sources];
        if (list.length === 0) return;
        const clamped = Math.max(0, Math.min(index, list.length - 1));
        set({ visible: true, sources: list, index: clamped });
    },
    close: () => set({ visible: false }),
    clear: () => set((state) => {
        if (state.visible || state.sources.length === 0) return state;
        return { sources: [], index: 0 };
    }),
}));

/**
 * Imperative singleton — call from anywhere (event handlers, non-React code)
 * without wiring a hook. Mirrors the `storage.getState()` convention.
 *
 * Pass a single source for one image, or an array + the tapped index to open a
 * swipeable gallery.
 */
export const imageViewer = {
    open(sources: ImageViewerSource | ImageViewerSource[], index = 0) {
        useImageViewerStore.getState().open(sources, index);
    },
    close() {
        useImageViewerStore.getState().close();
    },
    clear() {
        useImageViewerStore.getState().clear();
    },
};
