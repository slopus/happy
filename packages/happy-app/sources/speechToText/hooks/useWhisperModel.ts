/**
 * useWhisperModel Hook
 *
 * Hook for managing Whisper model downloads and state.
 */

import * as React from 'react';
import {
    WhisperModelSize,
    ModelState,
    ModelDownloadProgress,
} from '../types';
import { getModelDownloader, ModelDownloader } from '../utils/modelDownloader';
import { WHISPER_MODELS } from '../config';

// =============================================================================
// Types
// =============================================================================

export interface UseWhisperModelReturn {
    /** States of all models */
    modelStates: Record<WhisperModelSize, ModelState>;
    /** Currently downloading model (if any) */
    downloadingModel: WhisperModelSize | null;
    /** Current download progress */
    downloadProgress: ModelDownloadProgress | null;
    /** Whether refreshing model states */
    isRefreshing: boolean;

    // Actions
    /** Download a model */
    downloadModel: (size: WhisperModelSize) => Promise<void>;
    /** Cancel ongoing download */
    cancelDownload: () => Promise<void>;
    /** Delete a downloaded model */
    deleteModel: (size: WhisperModelSize) => Promise<void>;
    /** Refresh model states */
    refreshModelStates: () => Promise<void>;

    // Helpers
    /** Get display info for a model size */
    getModelInfo: (size: WhisperModelSize) => {
        displayName: string;
        fileSize: string;
        isDownloaded: boolean;
        isDownloading: boolean;
    };
    /** Get total storage used */
    totalStorageUsed: number;
}

// =============================================================================
// Helpers
// =============================================================================

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const INITIAL_MODEL_STATES: Record<WhisperModelSize, ModelState> = {
    tiny: { size: 'tiny', status: 'not_downloaded' },
    base: { size: 'base', status: 'not_downloaded' },
    small: { size: 'small', status: 'not_downloaded' },
    medium: { size: 'medium', status: 'not_downloaded' },
};

// =============================================================================
// Hook
// =============================================================================

export function useWhisperModel(): UseWhisperModelReturn {
    const downloaderRef = React.useRef<ModelDownloader | null>(null);

    const [modelStates, setModelStates] = React.useState<Record<WhisperModelSize, ModelState>>(
        INITIAL_MODEL_STATES
    );
    const [downloadingModel, setDownloadingModel] = React.useState<WhisperModelSize | null>(null);
    const [downloadProgress, setDownloadProgress] = React.useState<ModelDownloadProgress | null>(null);
    const [isRefreshing, setIsRefreshing] = React.useState(false);
    const [totalStorageUsed, setTotalStorageUsed] = React.useState(0);

    // Initialize downloader and refresh states
    React.useEffect(() => {
        downloaderRef.current = getModelDownloader();
        refreshModelStates();
    }, []);

    // Refresh model states
    const refreshModelStates = React.useCallback(async () => {
        if (!downloaderRef.current) return;

        setIsRefreshing(true);

        try {
            const states = await downloaderRef.current.getAllModelStates();
            const statesMap: Record<WhisperModelSize, ModelState> = { ...INITIAL_MODEL_STATES };

            for (const state of states) {
                statesMap[state.size] = state;
            }

            setModelStates(statesMap);

            // Update total storage
            const storage = await downloaderRef.current.getTotalStorageUsed();
            setTotalStorageUsed(storage);

        } catch (error) {
            console.error('Error refreshing model states:', error);
        } finally {
            setIsRefreshing(false);
        }
    }, []);

    // Download a model
    const downloadModel = React.useCallback(async (size: WhisperModelSize) => {
        if (!downloaderRef.current || downloadingModel) return;

        setDownloadingModel(size);
        setDownloadProgress({
            status: 'downloading',
            progress: 0,
            bytesDownloaded: 0,
            totalBytes: WHISPER_MODELS[size].fileSize,
        });

        // Update model state to downloading
        setModelStates(prev => ({
            ...prev,
            [size]: { size, status: 'downloading' },
        }));

        try {
            const finalState = await downloaderRef.current.downloadModel(size, {
                onProgress: (progress) => {
                    setDownloadProgress(progress);
                },
                onComplete: (state) => {
                    setModelStates(prev => ({
                        ...prev,
                        [size]: state,
                    }));
                },
                onError: (error) => {
                    setModelStates(prev => ({
                        ...prev,
                        [size]: {
                            size,
                            status: 'error',
                            progress: {
                                status: 'error',
                                progress: 0,
                                bytesDownloaded: 0,
                                totalBytes: WHISPER_MODELS[size].fileSize,
                                error: error.message,
                            },
                        },
                    }));
                },
            });

            // Update storage
            const storage = await downloaderRef.current.getTotalStorageUsed();
            setTotalStorageUsed(storage);

        } finally {
            setDownloadingModel(null);
            setDownloadProgress(null);
        }
    }, [downloadingModel]);

    // Cancel download
    const cancelDownload = React.useCallback(async () => {
        if (!downloaderRef.current || !downloadingModel) return;

        await downloaderRef.current.cancelDownload(downloadingModel);

        setModelStates(prev => ({
            ...prev,
            [downloadingModel]: { size: downloadingModel, status: 'not_downloaded' },
        }));

        setDownloadingModel(null);
        setDownloadProgress(null);
    }, [downloadingModel]);

    // Delete a model
    const deleteModel = React.useCallback(async (size: WhisperModelSize) => {
        if (!downloaderRef.current) return;

        await downloaderRef.current.deleteModel(size);

        setModelStates(prev => ({
            ...prev,
            [size]: { size, status: 'not_downloaded' },
        }));

        // Update storage
        const storage = await downloaderRef.current.getTotalStorageUsed();
        setTotalStorageUsed(storage);
    }, []);

    // Get model info helper
    const getModelInfo = React.useCallback((size: WhisperModelSize) => {
        const info = WHISPER_MODELS[size];
        const state = modelStates[size];

        return {
            displayName: info.displayName,
            fileSize: formatFileSize(info.fileSize),
            isDownloaded: state.status === 'downloaded',
            isDownloading: state.status === 'downloading' || downloadingModel === size,
        };
    }, [modelStates, downloadingModel]);

    return {
        modelStates,
        downloadingModel,
        downloadProgress,
        isRefreshing,
        downloadModel,
        cancelDownload,
        deleteModel,
        refreshModelStates,
        getModelInfo,
        totalStorageUsed,
    };
}
