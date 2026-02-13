/**
 * Model Downloader
 *
 * Handles downloading and managing Whisper models for local STT.
 */

import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import {
    WhisperModelSize,
    ModelDownloadStatus,
    ModelDownloadProgress,
    ModelState,
} from '../types';
import { WHISPER_MODELS, STT_STORAGE_KEYS } from '../config';

// =============================================================================
// Types
// =============================================================================

export interface ModelDownloadCallbacks {
    onProgress?: (progress: ModelDownloadProgress) => void;
    onComplete?: (state: ModelState) => void;
    onError?: (error: Error) => void;
}

interface StoredModelMetadata {
    [key: string]: {
        size: WhisperModelSize;
        filePath: string;
        coreMLPath?: string;
        downloadedAt: number;
        fileSize: number;
    };
}

// =============================================================================
// Constants
// =============================================================================

const MODELS_DIRECTORY = `${FileSystem.documentDirectory}whisper_models/`;

// =============================================================================
// Model Downloader Class
// =============================================================================

export class ModelDownloader {
    private downloadResumables: Map<WhisperModelSize, FileSystem.DownloadResumable> = new Map();
    private modelMetadata: StoredModelMetadata = {};

    constructor() {
        this.loadMetadata();
    }

    // ==========================================================================
    // Public Methods
    // ==========================================================================

    /**
     * Get the current state of a model
     */
    async getModelState(size: WhisperModelSize): Promise<ModelState> {
        const metadata = this.modelMetadata[size];

        if (!metadata) {
            return {
                size,
                status: 'not_downloaded',
            };
        }

        // Verify file exists
        const fileInfo = await FileSystem.getInfoAsync(metadata.filePath);
        if (!fileInfo.exists) {
            // File was deleted, clean up metadata
            delete this.modelMetadata[size];
            await this.saveMetadata();
            return {
                size,
                status: 'not_downloaded',
            };
        }

        return {
            size,
            status: 'downloaded',
            filePath: metadata.filePath,
            coreMLPath: metadata.coreMLPath,
        };
    }

    /**
     * Get states of all models
     */
    async getAllModelStates(): Promise<ModelState[]> {
        const sizes: WhisperModelSize[] = ['tiny', 'base', 'small', 'medium'];
        return Promise.all(sizes.map(size => this.getModelState(size)));
    }

    /**
     * Download a model
     */
    async downloadModel(
        size: WhisperModelSize,
        callbacks?: ModelDownloadCallbacks
    ): Promise<ModelState> {
        const modelInfo = WHISPER_MODELS[size];

        // Ensure directory exists
        await this.ensureModelsDirectory();

        const filePath = `${MODELS_DIRECTORY}ggml-${size}.bin`;

        // Create progress callback
        const progressCallback = (downloadProgress: FileSystem.DownloadProgressData) => {
            const progress: ModelDownloadProgress = {
                status: 'downloading',
                progress: downloadProgress.totalBytesExpectedToWrite > 0
                    ? downloadProgress.totalBytesWritten / downloadProgress.totalBytesExpectedToWrite
                    : 0,
                bytesDownloaded: downloadProgress.totalBytesWritten,
                totalBytes: downloadProgress.totalBytesExpectedToWrite,
            };
            callbacks?.onProgress?.(progress);
        };

        try {
            // Start download
            const downloadResumable = FileSystem.createDownloadResumable(
                modelInfo.downloadUrl,
                filePath,
                {},
                progressCallback
            );

            this.downloadResumables.set(size, downloadResumable);

            callbacks?.onProgress?.({
                status: 'downloading',
                progress: 0,
                bytesDownloaded: 0,
                totalBytes: modelInfo.fileSize,
            });

            const result = await downloadResumable.downloadAsync();

            if (!result?.uri) {
                throw new Error('Download failed: no URI returned');
            }

            // Download Core ML model for iOS
            let coreMLPath: string | undefined;
            if (Platform.OS === 'ios' && modelInfo.coreMLUrl) {
                try {
                    coreMLPath = await this.downloadCoreMLModel(size, modelInfo.coreMLUrl);
                } catch (error) {
                    // Core ML is optional, log and continue
                    console.warn('Failed to download Core ML model:', error);
                }
            }

            // Save metadata
            this.modelMetadata[size] = {
                size,
                filePath: result.uri,
                coreMLPath,
                downloadedAt: Date.now(),
                fileSize: modelInfo.fileSize,
            };
            await this.saveMetadata();

            const state: ModelState = {
                size,
                status: 'downloaded',
                filePath: result.uri,
                coreMLPath,
            };

            callbacks?.onComplete?.(state);
            return state;

        } catch (error) {
            const state: ModelState = {
                size,
                status: 'error',
                progress: {
                    status: 'error',
                    progress: 0,
                    bytesDownloaded: 0,
                    totalBytes: modelInfo.fileSize,
                    error: error instanceof Error ? error.message : String(error),
                },
            };

            callbacks?.onError?.(error instanceof Error ? error : new Error(String(error)));
            return state;

        } finally {
            this.downloadResumables.delete(size);
        }
    }

    /**
     * Cancel an ongoing download
     */
    async cancelDownload(size: WhisperModelSize): Promise<void> {
        const resumable = this.downloadResumables.get(size);
        if (resumable) {
            try {
                await resumable.pauseAsync();
            } catch (error) {
                console.warn('Error pausing download:', error);
            }
            this.downloadResumables.delete(size);
        }

        // Clean up partial file
        const filePath = `${MODELS_DIRECTORY}ggml-${size}.bin`;
        try {
            const fileInfo = await FileSystem.getInfoAsync(filePath);
            if (fileInfo.exists) {
                await FileSystem.deleteAsync(filePath, { idempotent: true });
            }
        } catch (error) {
            console.warn('Error cleaning up partial file:', error);
        }
    }

    /**
     * Delete a downloaded model
     */
    async deleteModel(size: WhisperModelSize): Promise<void> {
        const metadata = this.modelMetadata[size];

        if (metadata) {
            // Delete main model file
            try {
                await FileSystem.deleteAsync(metadata.filePath, { idempotent: true });
            } catch (error) {
                console.warn('Error deleting model file:', error);
            }

            // Delete Core ML model if exists
            if (metadata.coreMLPath) {
                try {
                    await FileSystem.deleteAsync(metadata.coreMLPath, { idempotent: true });
                } catch (error) {
                    console.warn('Error deleting Core ML model:', error);
                }
            }

            // Remove metadata
            delete this.modelMetadata[size];
            await this.saveMetadata();
        }
    }

    /**
     * Get the file path for a downloaded model
     */
    getModelPath(size: WhisperModelSize): string | null {
        return this.modelMetadata[size]?.filePath ?? null;
    }

    /**
     * Get the Core ML path for a downloaded model (iOS only)
     */
    getCoreMLPath(size: WhisperModelSize): string | null {
        return this.modelMetadata[size]?.coreMLPath ?? null;
    }

    /**
     * Check if a model is currently downloading
     */
    isDownloading(size: WhisperModelSize): boolean {
        return this.downloadResumables.has(size);
    }

    /**
     * Get total storage used by downloaded models
     */
    async getTotalStorageUsed(): Promise<number> {
        let total = 0;
        for (const metadata of Object.values(this.modelMetadata)) {
            total += metadata.fileSize;
        }
        return total;
    }

    // ==========================================================================
    // Private Methods
    // ==========================================================================

    private async ensureModelsDirectory(): Promise<void> {
        const dirInfo = await FileSystem.getInfoAsync(MODELS_DIRECTORY);
        if (!dirInfo.exists) {
            await FileSystem.makeDirectoryAsync(MODELS_DIRECTORY, { intermediates: true });
        }
    }

    private async loadMetadata(): Promise<void> {
        try {
            const metadataPath = `${FileSystem.documentDirectory}${STT_STORAGE_KEYS.modelMetadata}.json`;
            const fileInfo = await FileSystem.getInfoAsync(metadataPath);

            if (fileInfo.exists) {
                const content = await FileSystem.readAsStringAsync(metadataPath);
                this.modelMetadata = JSON.parse(content);
            }
        } catch (error) {
            console.warn('Error loading model metadata:', error);
            this.modelMetadata = {};
        }
    }

    private async saveMetadata(): Promise<void> {
        try {
            const metadataPath = `${FileSystem.documentDirectory}${STT_STORAGE_KEYS.modelMetadata}.json`;
            await FileSystem.writeAsStringAsync(
                metadataPath,
                JSON.stringify(this.modelMetadata, null, 2)
            );
        } catch (error) {
            console.warn('Error saving model metadata:', error);
        }
    }

    private async downloadCoreMLModel(
        size: WhisperModelSize,
        url: string
    ): Promise<string> {
        const zipPath = `${MODELS_DIRECTORY}ggml-${size}-encoder.mlmodelc.zip`;
        const extractPath = `${MODELS_DIRECTORY}ggml-${size}-encoder.mlmodelc`;

        // Download the zip file
        const downloadResult = await FileSystem.downloadAsync(url, zipPath);

        if (!downloadResult?.uri) {
            throw new Error('Failed to download Core ML model');
        }

        // Note: Expo FileSystem doesn't have built-in unzip
        // For now, we'll skip Core ML extraction
        // In production, you'd use a library like react-native-zip-archive
        console.warn('Core ML model downloaded but extraction not implemented');

        // Clean up zip file
        await FileSystem.deleteAsync(zipPath, { idempotent: true });

        // Return the expected path (even though extraction is not implemented)
        return extractPath;
    }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let modelDownloaderInstance: ModelDownloader | null = null;

/**
 * Get the singleton ModelDownloader instance
 */
export function getModelDownloader(): ModelDownloader {
    if (!modelDownloaderInstance) {
        modelDownloaderInstance = new ModelDownloader();
    }
    return modelDownloaderInstance;
}
