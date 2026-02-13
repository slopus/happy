/**
 * STT Settings Screen
 *
 * Speech-to-Text configuration page with local Whisper model management.
 */

import * as React from 'react';
import { View, Text, ActivityIndicator, Alert, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable, useSetting } from '@/sync/storage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Switch } from 'react-native';
import { Typography } from '@/constants/Typography';
import {
    useWhisperModel,
    WHISPER_MODELS,
    WhisperModelSize,
} from '@/speechToText';

// =============================================================================
// Styles
// =============================================================================

const stylesheet = StyleSheet.create((theme) => ({
    progressContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    progressText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    progressBar: {
        flex: 1,
        height: 4,
        backgroundColor: theme.colors.divider,
        borderRadius: 2,
        overflow: 'hidden',
    },
    progressFill: {
        height: '100%',
        backgroundColor: theme.colors.tint,
        borderRadius: 2,
    },
    storageText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        paddingVertical: 8,
        ...Typography.default(),
    },
    radioButton: {
        width: 22,
        height: 22,
        borderRadius: 11,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    radioButtonInner: {
        width: 12,
        height: 12,
        borderRadius: 6,
    },
}));

// =============================================================================
// Helper Components
// =============================================================================

function RadioButton({ selected, color }: { selected: boolean; color: string }) {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    return (
        <View style={[
            styles.radioButton,
            { borderColor: selected ? color : theme.colors.textSecondary }
        ]}>
            {selected && (
                <View style={[styles.radioButtonInner, { backgroundColor: color }]} />
            )}
        </View>
    );
}

function DownloadProgress({ progress }: { progress: number }) {
    const styles = stylesheet;

    return (
        <View style={styles.progressContainer}>
            <View style={styles.progressBar}>
                <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
            </View>
            <Text style={styles.progressText}>{Math.round(progress * 100)}%</Text>
        </View>
    );
}

function formatFileSize(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// =============================================================================
// Main Component
// =============================================================================

export default function STTSettingsScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();

    // Settings
    const [sttEnabled, setSttEnabled] = useSettingMutable('sttEnabled');
    const [sttLocalModel, setSttLocalModel] = useSettingMutable('sttLocalModel');
    const [sttLanguage, setSttLanguage] = useSettingMutable('sttLanguage');
    const [sttShowWaveform, setSttShowWaveform] = useSettingMutable('sttShowWaveform');
    const [sttHapticFeedback, setSttHapticFeedback] = useSettingMutable('sttHapticFeedback');

    // Model management
    const {
        modelStates,
        downloadingModel,
        downloadProgress,
        downloadModel,
        cancelDownload,
        deleteModel,
        getModelInfo,
        totalStorageUsed,
    } = useWhisperModel();

    // Handle model selection
    const handleModelSelect = React.useCallback(async (size: WhisperModelSize) => {
        const state = modelStates[size];

        if (state.status === 'downloaded') {
            // Already downloaded, just select it
            setSttLocalModel(size);
        } else if (state.status === 'downloading' || downloadingModel === size) {
            // Currently downloading, offer to cancel
            Alert.alert(
                t('settingsSTT.cancelDownload') || 'Cancel Download',
                t('settingsSTT.cancelDownloadConfirm') || 'Are you sure you want to cancel this download?',
                [
                    { text: t('common.no') || 'No', style: 'cancel' },
                    {
                        text: t('common.yes') || 'Yes',
                        style: 'destructive',
                        onPress: () => cancelDownload(),
                    },
                ]
            );
        } else {
            // Not downloaded, start download
            Alert.alert(
                t('settingsSTT.downloadModel') || 'Download Model',
                `${t('settingsSTT.downloadModelConfirm') || 'Download'} ${WHISPER_MODELS[size].displayName} (${formatFileSize(WHISPER_MODELS[size].fileSize)})?`,
                [
                    { text: t('common.cancel') || 'Cancel', style: 'cancel' },
                    {
                        text: t('common.download') || 'Download',
                        onPress: async () => {
                            await downloadModel(size);
                            setSttLocalModel(size);
                        },
                    },
                ]
            );
        }
    }, [modelStates, downloadingModel, setSttLocalModel, cancelDownload, downloadModel]);

    // Handle model deletion
    const handleModelDelete = React.useCallback((size: WhisperModelSize) => {
        if (sttLocalModel === size) {
            Alert.alert(
                t('settingsSTT.cannotDelete') || 'Cannot Delete',
                t('settingsSTT.cannotDeleteActive') || 'Cannot delete the currently active model. Please select a different model first.',
                [{ text: t('common.ok') || 'OK' }]
            );
            return;
        }

        Alert.alert(
            t('settingsSTT.deleteModel') || 'Delete Model',
            `${t('settingsSTT.deleteModelConfirm') || 'Delete'} ${WHISPER_MODELS[size].displayName}?`,
            [
                { text: t('common.cancel') || 'Cancel', style: 'cancel' },
                {
                    text: t('common.delete') || 'Delete',
                    style: 'destructive',
                    onPress: () => deleteModel(size),
                },
            ]
        );
    }, [sttLocalModel, deleteModel]);

    // Model sizes ordered by size
    const modelSizes: WhisperModelSize[] = ['tiny', 'base', 'small', 'medium'];

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Whisper Model Selection */}
            <ItemGroup
                title={t('settingsSTT.model') || 'Whisper Model'}
                footer={t('settingsSTT.modelFooter') || 'Larger models are more accurate but require more storage and processing time. Small is recommended for most users.'}
            >
                    {modelSizes.map((size) => {
                        const info = getModelInfo(size);
                        const state = modelStates[size];
                        const isSelected = sttLocalModel === size;
                        const isDownloading = downloadingModel === size;

                        let statusText = '';
                        let statusColor = theme.colors.textSecondary;

                        if (state.status === 'downloaded') {
                            statusText = t('settingsSTT.downloaded') || 'Downloaded';
                            statusColor = theme.colors.success;
                        } else if (isDownloading) {
                            statusText = t('settingsSTT.downloading') || 'Downloading...';
                            statusColor = theme.colors.tint;
                        } else {
                            statusText = info.fileSize;
                            statusColor = theme.colors.textSecondary;
                        }

                        return (
                            <Item
                                key={size}
                                title={info.displayName}
                                subtitle={
                                    size === 'tiny' ? (t('settingsSTT.modelTinyDesc') || 'Fastest, lower accuracy') :
                                        size === 'base' ? (t('settingsSTT.modelBaseDesc') || 'Fast, good for simple tasks') :
                                            size === 'small' ? (t('settingsSTT.modelSmallDesc') || 'Recommended, balanced') :
                                                (t('settingsSTT.modelMediumDesc') || 'Most accurate, slower')
                                }
                                icon={
                                    <Ionicons
                                        name={isSelected ? "checkmark-circle" : "cube-outline"}
                                        size={29}
                                        color={isSelected ? theme.colors.success : theme.colors.textSecondary}
                                    />
                                }
                                rightElement={
                                    isDownloading && downloadProgress ? (
                                        <DownloadProgress progress={downloadProgress.progress} />
                                    ) : undefined
                                }
                                detail={
                                    isDownloading && downloadProgress ? undefined : statusText
                                }
                                detailStyle={{ color: statusColor }}
                                onPress={() => handleModelSelect(size)}
                                onLongPress={state.status === 'downloaded' && !isSelected ? () => handleModelDelete(size) : undefined}
                            />
                        );
                    })}

                    {totalStorageUsed > 0 && (
                        <Text style={styles.storageText}>
                            {t('settingsSTT.totalStorage') || 'Total storage used:'} {formatFileSize(totalStorageUsed)}
                        </Text>
                    )}
                </ItemGroup>

            {/* Language Settings */}
            <ItemGroup
                title={t('settingsSTT.language') || 'Recognition Language'}
                footer={t('settingsSTT.languageFooter') || 'Auto-detect works well for most languages. Set a specific language for better accuracy.'}
            >
                <Item
                    title={t('settingsSTT.autoDetect') || 'Auto-detect'}
                    subtitle={t('settingsSTT.autoDetectDescription') || 'Automatically detect spoken language'}
                    icon={<Ionicons name="globe-outline" size={29} color="#007AFF" />}
                    rightElement={<RadioButton selected={sttLanguage === null} color={theme.colors.tint} />}
                    onPress={() => setSttLanguage(null)}
                />
                <Item
                    title={t('settingsSTT.chinese') || 'Chinese'}
                    subtitle="中文 (Mandarin)"
                    icon={<Text style={{ fontSize: 24 }}>🇨🇳</Text>}
                    rightElement={<RadioButton selected={sttLanguage === 'zh'} color={theme.colors.tint} />}
                    onPress={() => setSttLanguage('zh')}
                />
                <Item
                    title={t('settingsSTT.english') || 'English'}
                    subtitle="English"
                    icon={<Text style={{ fontSize: 24 }}>🇺🇸</Text>}
                    rightElement={<RadioButton selected={sttLanguage === 'en'} color={theme.colors.tint} />}
                    onPress={() => setSttLanguage('en')}
                />
                <Item
                    title={t('settingsSTT.japanese') || 'Japanese'}
                    subtitle="日本語"
                    icon={<Text style={{ fontSize: 24 }}>🇯🇵</Text>}
                    rightElement={<RadioButton selected={sttLanguage === 'ja'} color={theme.colors.tint} />}
                    onPress={() => setSttLanguage('ja')}
                />
            </ItemGroup>

            {/* UI Options */}
            <ItemGroup
                title={t('settingsSTT.uiOptions') || 'Interface Options'}
            >
                <Item
                    title={t('settingsSTT.showWaveform') || 'Show Waveform'}
                    subtitle={t('settingsSTT.showWaveformDescription') || 'Display audio visualization while recording'}
                    icon={<Ionicons name="pulse-outline" size={29} color="#FF9500" />}
                    rightElement={
                        <Switch
                            value={sttShowWaveform}
                            onValueChange={setSttShowWaveform}
                            trackColor={{ false: theme.colors.switchTrackOff, true: theme.colors.switchTrackOn }}
                            thumbColor={theme.colors.switchThumb}
                        />
                    }
                />
                <Item
                    title={t('settingsSTT.hapticFeedback') || 'Haptic Feedback'}
                    subtitle={t('settingsSTT.hapticFeedbackDescription') || 'Vibrate when starting and stopping recording'}
                    icon={<Ionicons name="radio-outline" size={29} color="#AF52DE" />}
                    rightElement={
                        <Switch
                            value={sttHapticFeedback}
                            onValueChange={setSttHapticFeedback}
                            trackColor={{ false: theme.colors.switchTrackOff, true: theme.colors.switchTrackOn }}
                            thumbColor={theme.colors.switchThumb}
                        />
                    }
                />
            </ItemGroup>
        </ItemList>
    );
}
