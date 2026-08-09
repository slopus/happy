import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { useGeneratedImageBatchDownload } from '@/hooks/useGeneratedImageBatchDownload';
import type { ImageBatchDownloadItem } from '@/utils/imageBatchDownload';

export type GeneratedImageBatchDownloadProps = {
    items: ImageBatchDownloadItem[];
    displayedCount: number;
    settledCount: number;
    pendingCount: number;
};

export function GeneratedImageBatchDownload({
    items,
    displayedCount,
    settledCount,
    pendingCount,
}: GeneratedImageBatchDownloadProps) {
    const { theme } = useUnistyles();
    const [hovered, setHovered] = React.useState(false);
    const {
        actionLoading,
        failedItems,
        numberedItems,
        operation,
        startDownload,
    } = useGeneratedImageBatchDownload(items);
    const progress = operation.progress;
    const summary = operation.summary;
    const totalCount = displayedCount + pendingCount;
    const isPreparing = pendingCount > 0 || settledCount < displayedCount;

    const disabled = isPreparing || operation.busy || actionLoading || items.length === 0;
    const label = isPreparing
        ? t('generatedImageBatchDownload.preparing', { ready: settledCount, total: totalCount })
        : progress
            ? t('generatedImageBatchDownload.downloading', progress)
            : t('generatedImageBatchDownload.downloadAll', { count: items.length });

    if (totalCount <= 1) return null;

    const summaryText = summary?.cancelled
        ? summary.destination === 'directory'
            ? t('generatedImageBatchDownload.cancelledDirectory')
            : summary.destination === 'photos'
                ? t('generatedImageBatchDownload.cancelledPhotos')
                : summary.destination === 'browser'
                    ? t('generatedImageBatchDownload.cancelledBrowser')
                    : t('generatedImageBatchDownload.cancelledUnsupported')
        : summary?.failed
            ? t('generatedImageBatchDownload.partial', summary)
            : summary?.destination === 'browser'
                ? t('generatedImageBatchDownload.savedBrowser', { count: summary.succeeded })
                : summary?.destination === 'directory'
                    ? t('generatedImageBatchDownload.savedDirectory', { count: summary.succeeded })
                    : summary?.destination === 'photos'
                        ? t('generatedImageBatchDownload.savedPhotos', { count: summary.succeeded })
                        : summary
                            ? t('generatedImageBatchDownload.saved', { count: summary.succeeded })
                            : null;

    return (
        <View style={styles.container}>
            <Pressable
                testID="attachment-gallery-download-all"
                accessibilityRole="button"
                accessibilityState={{ disabled }}
                disabled={disabled}
                onPress={() => startDownload(numberedItems)}
                onHoverIn={() => setHovered(true)}
                onHoverOut={() => setHovered(false)}
                style={({ pressed }) => [
                    styles.action,
                    {
                        backgroundColor: pressed || hovered
                            ? theme.colors.surfacePressed
                            : theme.colors.surface,
                        borderColor: theme.colors.divider,
                        opacity: disabled ? 0.55 : 1,
                    },
                ]}
            >
                {progress ? (
                    <ActivityIndicator
                        testID="attachment-gallery-download-progress"
                        size="small"
                        color={theme.colors.textSecondary}
                    />
                ) : (
                    <Ionicons
                        name="download-outline"
                        size={16}
                        color={theme.colors.textSecondary}
                    />
                )}
                <Text style={[styles.actionText, { color: theme.colors.text }]}>{label}</Text>
            </Pressable>

            {summary ? (
                <View testID="attachment-gallery-download-summary" style={styles.summaryRow}>
                    <Text
                        testID={!summary.cancelled && summary.failed === 0 ? 'attachment-gallery-download-success' : undefined}
                        style={[styles.summaryText, { color: theme.colors.textSecondary }]}
                    >
                        {summaryText}
                    </Text>
                    {failedItems.length > 0 ? (
                        <Pressable
                            testID="attachment-gallery-download-retry"
                            accessibilityRole="button"
                            accessibilityState={{ disabled: progress !== null }}
                            disabled={progress !== null}
                            onPress={() => startDownload(failedItems)}
                            style={({ pressed }) => ({ opacity: pressed ? 0.65 : 1 })}
                        >
                            <Text style={[styles.retryText, { color: theme.colors.accent }]}>
                                {t('generatedImageBatchDownload.retryFailed', { count: failedItems.length })}
                            </Text>
                        </Pressable>
                    ) : null}
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    container: {
        alignItems: 'flex-end',
        gap: 6,
    },
    action: {
        minHeight: 34,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 7,
    },
    actionText: {
        fontSize: 13,
        fontWeight: '600',
        fontVariant: ['tabular-nums'],
    },
    summaryRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 10,
    },
    summaryText: {
        fontSize: 12,
        fontWeight: '500',
    },
    retryText: {
        fontSize: 12,
        fontWeight: '700',
    },
}));
