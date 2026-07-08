import * as React from 'react';
import { View, Text, ScrollView, Pressable, Platform, ActivityIndicator, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useSession } from '@/sync/storage';
import { useHappyAction } from '@/hooks/useHappyAction';
import { getDuplicateSheetFrame } from '@/utils/duplicateSheetLayout';
import {
    forkAndSpawn,
    claudeListRewindPoints,
    codexListRewindPoints,
    type ForkSource,
} from '@/sync/ops';
import { getSessionForkSource } from '@/utils/sessionFork';

export interface DuplicateSheetProps {
    sessionId: string;
    /** Pre-select this rewind uuid when the sheet opens (long-press entry). */
    initialClaudeUuid?: string;
    /** Pre-select this provider rewind id when the sheet opens (Claude uuid or Codex item id). */
    initialRewindPointId?: string;
    /** Fallback preselect text for Codex live messages that do not yet carry an item id. */
    initialMessageText?: string;
    /** In-app message id used for fork lineage when opened from a message long-press. */
    initialForkedFromMessageId?: string;
    /** Injected by the modal infra. */
    onClose?: () => void;
}

type RewindPoint = {
    id: string;
    text: string;
    timestamp: number;
};

/**
 * Picker for "duplicate session from message N". Pulls provider-native
 * user-text rewind points via RPC: Claude reads the on-disk JSONL, Codex
 * reads the app-server thread. Tap to choose a point, confirm to
 * fork-and-spawn a new Happy session truncated around that provider id.
 */
export const DuplicateSheet = React.memo(function DuplicateSheet(props: DuplicateSheetProps) {
    const { sessionId, initialClaudeUuid, initialRewindPointId, initialMessageText, initialForkedFromMessageId, onClose } = props;
    const session = useSession(sessionId);
    const router = useRouter();
    const windowSize = useWindowDimensions();
    const sheetFrame = React.useMemo(
        () => getDuplicateSheetFrame(windowSize),
        [windowSize.width, windowSize.height],
    );

    const source = React.useMemo(() => session ? getSessionForkSource(session) : null, [
        session?.id,
        session?.metadata?.flavor,
        session?.metadata?.machineId,
        session?.metadata?.path,
        session?.metadata?.claudeSessionId,
        session?.metadata?.codexThreadId,
    ]);
    const canFork = Boolean(source);

    const [points, setPoints] = React.useState<RewindPoint[] | null>(null);
    const [pointsError, setPointsError] = React.useState<string | null>(null);
    const initialSelectedId = initialRewindPointId ?? initialClaudeUuid ?? null;
    const [selectedId, setSelectedId] = React.useState<string | null>(initialSelectedId);

    React.useEffect(() => {
        let cancelled = false;
        async function load() {
            if (!source) {
                if (!cancelled) {
                    setPointsError(t('session.forkErrorMissingMetadata'));
                    setPoints([]);
                }
                return;
            }
            const result = source.kind === 'codex'
                ? await codexListRewindPoints({
                    machineId: source.machineId,
                    directory: source.directory,
                    codexThreadId: source.codexThreadId,
                })
                : await claudeListRewindPoints({
                    machineId: source.machineId,
                    directory: source.directory,
                    claudeSessionId: source.claudeSessionId,
                });
            if (cancelled) return;
            if (result.type === 'success') {
                // Newest first — easier to find a recent rewind point.
                const normalized = result.points.map((point) => ({
                    id: 'itemId' in point ? point.itemId : point.uuid,
                    text: point.text,
                    timestamp: point.timestamp,
                }));
                setPoints([...normalized].reverse());
                setPointsError(null);
            } else {
                setPoints([]);
                setPointsError(result.errorMessage);
            }
        }
        void load();
        return () => { cancelled = true; };
    }, [source]);

    React.useEffect(() => {
        if (points && selectedId && !points.some((p) => p.id === selectedId)) {
            setSelectedId(null);
        }
    }, [points, selectedId]);

    React.useEffect(() => {
        if (!points || selectedId || !initialMessageText) {
            return;
        }
        const target = normalizeMessageText(initialMessageText);
        const match = points.find((point) => normalizeMessageText(point.text) === target);
        if (match) {
            setSelectedId(match.id);
        }
    }, [initialMessageText, points, selectedId]);

    const selected = (points && selectedId)
        ? points.find((p) => p.id === selectedId) ?? null
        : null;

    const [loading, doDuplicate] = useHappyAction(async () => {
        if (!source) {
            Modal.alert(t('common.error'), t('session.forkErrorMissingMetadata'));
            return;
        }
        if (!selected) {
            Modal.alert(t('common.error'), t('session.duplicateRowDisabled'));
            return;
        }

        const forkedFromMessageId = matchesInitialSelection(selected, initialSelectedId, initialMessageText)
            ? initialForkedFromMessageId
            : undefined;
        const result = source.kind === 'codex'
            ? await forkAndSpawn(source as ForkSource, {
                cutAfterItemId: selected.id,
                forkedFromMessageId,
            })
            : await forkAndSpawn(source as ForkSource, {
                cutAfterUuid: selected.id,
                forkedFromMessageId,
            });

        if (result.type === 'success') {
            onClose?.();
            router.replace(`/session/${result.sessionId}`);
            return;
        }

        const message = result.type === 'error' ? result.errorMessage : t('session.forkErrorGeneric');
        Modal.alert(t('common.error'), message);
    });

    return (
        <View style={[styles.sheet, sheetFrame]}>
            <View style={styles.header}>
                <Text style={styles.title}>{t('session.duplicateSheetTitle')}</Text>
                <Text style={styles.subtitle}>{t('session.duplicateSheetSubtitle')}</Text>
            </View>

            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
                {points === null ? (
                    <View style={styles.loadingContainer}>
                        <ActivityIndicator />
                    </View>
                ) : pointsError ? (
                    <Text style={styles.emptyText}>{pointsError}</Text>
                ) : points.length === 0 ? (
                    <Text style={styles.emptyText}>{t('session.duplicateSheetEmpty')}</Text>
                ) : (
                    points.map((p) => {
                        const isSelected = p.id === selectedId;
                        const preview = p.text.trim().replace(/\s+/g, ' ');
                        const truncated = preview.length > 140 ? `${preview.slice(0, 140)}…` : preview;

                        return (
                            <Pressable
                                key={p.id}
                                onPress={() => setSelectedId(p.id)}
                                style={({ pressed }) => [
                                    styles.row,
                                    isSelected && styles.rowSelected,
                                    pressed && styles.rowPressed,
                                ]}
                            >
                                <Text style={styles.rowText} numberOfLines={3}>
                                    {truncated}
                                </Text>
                                <Text style={styles.rowMeta}>
                                    {formatRelativeTime(p.timestamp)}
                                </Text>
                            </Pressable>
                        );
                    })
                )}
            </ScrollView>

            <View style={styles.actions}>
                <Pressable
                    onPress={onClose}
                    style={({ pressed }) => [styles.button, styles.buttonSecondary, pressed && styles.buttonPressed]}
                >
                    <Text style={styles.buttonSecondaryText}>{t('common.cancel')}</Text>
                </Pressable>
                <Pressable
                    onPress={doDuplicate}
                    disabled={loading || !selected || !canFork}
                    style={({ pressed }) => [
                        styles.button,
                        styles.buttonPrimary,
                        (loading || !selected || !canFork) && styles.buttonDisabled,
                        pressed && styles.buttonPressed,
                    ]}
                >
                    <Text style={styles.buttonPrimaryText}>
                        {loading ? t('common.loading') : t('session.duplicateSheetConfirm')}
                    </Text>
                </Pressable>
            </View>
        </View>
    );
});

function normalizeMessageText(text: string): string {
    return text.trim().replace(/\s+/g, ' ');
}

function matchesInitialSelection(
    selected: RewindPoint,
    initialSelectedId: string | null,
    initialMessageText: string | undefined,
): boolean {
    if (initialSelectedId) {
        return selected.id === initialSelectedId;
    }
    return Boolean(initialMessageText)
        && normalizeMessageText(selected.text) === normalizeMessageText(initialMessageText ?? '');
}

function formatRelativeTime(timestampMs: number): string {
    const diffMs = Date.now() - timestampMs;
    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 1) return t('time.justNow');
    if (minutes < 60) return t('time.minutesAgo', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('time.hoursAgo', { count: hours });
    const days = Math.floor(hours / 24);
    return t('time.daysAgo', { count: days });
}

const styles = StyleSheet.create((theme) => ({
    sheet: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        overflow: 'hidden',
        alignSelf: 'center',
        minWidth: 0,
    },
    header: {
        paddingHorizontal: 20,
        paddingTop: 20,
        paddingBottom: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    title: {
        fontSize: 17,
        fontWeight: '600' as const,
        color: theme.colors.text,
    },
    subtitle: {
        marginTop: 4,
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    list: {
        flexGrow: 0,
        flexShrink: 1,
        maxHeight: 420,
        minHeight: 0,
    },
    listContent: {
        paddingVertical: 8,
    },
    emptyText: {
        textAlign: 'center',
        color: theme.colors.textSecondary,
        paddingVertical: 32,
        paddingHorizontal: 20,
        fontSize: 14,
    },
    row: {
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    rowSelected: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    rowPressed: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    rowText: {
        fontSize: 14,
        color: theme.colors.text,
        lineHeight: 19,
    },
    rowMeta: {
        marginTop: 4,
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    loadingContainer: {
        paddingVertical: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    actions: {
        flexDirection: 'row',
        gap: 8,
        padding: 16,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    button: {
        flex: 1,
        paddingVertical: Platform.select({ ios: 11, default: 12 }),
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonPressed: {
        opacity: 0.7,
    },
    buttonDisabled: {
        opacity: 0.4,
    },
    buttonPrimary: {
        backgroundColor: theme.colors.button.primary.background,
    },
    buttonSecondary: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    buttonPrimaryText: {
        color: theme.colors.button.primary.tint,
        fontSize: 15,
        fontWeight: '600' as const,
    },
    buttonSecondaryText: {
        color: theme.colors.text,
        fontSize: 15,
        fontWeight: '500' as const,
    },
}));
