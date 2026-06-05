import * as React from 'react';
import { View, Text, ScrollView, Pressable, Platform, ActivityIndicator } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useSession } from '@/sync/storage';
import { useHappyAction } from '@/hooks/useHappyAction';
import { forkAndSpawn, claudeListRewindPoints, type ForkSource, type ClaudeRewindPoint } from '@/sync/ops';

export interface DuplicateSheetProps {
    sessionId: string;
    /** Pre-select this rewind uuid when the sheet opens (long-press entry). */
    initialClaudeUuid?: string;
    /** Injected by the modal infra. */
    onClose?: () => void;
}

/**
 * Picker for "duplicate session from message N". Pulls user-text rewind
 * points directly from the on-disk Claude JSONL via RPC — disk is the
 * source of truth, since live-typed user messages travel through the
 * legacy `sentFrom: 'web'` server path and never carry a claudeUuid in
 * their session-protocol envelope.
 *
 * Tap to choose a point, confirm to fork-and-spawn a new Happy session
 * truncated to everything before that uuid.
 */
export const DuplicateSheet = React.memo(function DuplicateSheet(props: DuplicateSheetProps) {
    const { sessionId, initialClaudeUuid, onClose } = props;
    const session = useSession(sessionId);
    const router = useRouter();

    const machineId = session?.metadata?.machineId;
    const directory = session?.metadata?.path;
    const claudeSessionId = session?.metadata?.claudeSessionId;

    const canFork =
        Boolean(session) &&
        Boolean(machineId) &&
        Boolean(directory) &&
        Boolean(claudeSessionId) &&
        session?.metadata?.flavor !== 'codex' &&
        session?.metadata?.flavor !== 'gemini';

    const [points, setPoints] = React.useState<ClaudeRewindPoint[] | null>(null);
    const [pointsError, setPointsError] = React.useState<string | null>(null);
    const [selectedUuid, setSelectedUuid] = React.useState<string | null>(initialClaudeUuid ?? null);

    React.useEffect(() => {
        let cancelled = false;
        async function load() {
            if (!canFork || !machineId || !directory || !claudeSessionId) {
                if (!cancelled) {
                    setPointsError(t('session.forkErrorMissingMetadata'));
                    setPoints([]);
                }
                return;
            }
            const result = await claudeListRewindPoints({ machineId, directory, claudeSessionId });
            if (cancelled) return;
            if (result.type === 'success') {
                // Newest first — easier to find a recent rewind point.
                setPoints([...result.points].reverse());
                setPointsError(null);
            } else {
                setPoints([]);
                setPointsError(result.errorMessage);
            }
        }
        void load();
        return () => { cancelled = true; };
    }, [canFork, machineId, directory, claudeSessionId]);

    React.useEffect(() => {
        if (points && selectedUuid && !points.some((p) => p.uuid === selectedUuid)) {
            setSelectedUuid(null);
        }
    }, [points, selectedUuid]);

    const selected = (points && selectedUuid)
        ? points.find((p) => p.uuid === selectedUuid) ?? null
        : null;

    const [loading, doDuplicate] = useHappyAction(async () => {
        if (!canFork || !machineId || !directory || !claudeSessionId) {
            Modal.alert(t('common.error'), t('session.forkErrorMissingMetadata'));
            return;
        }
        if (!selected) {
            Modal.alert(t('common.error'), t('session.duplicateRowDisabled'));
            return;
        }

        const source: ForkSource = { sessionId, machineId, directory, claudeSessionId };
        const result = await forkAndSpawn(source, {
            cutAfterUuid: selected.uuid,
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
        <View style={styles.sheet}>
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
                        const isSelected = p.uuid === selectedUuid;
                        const preview = p.text.trim().replace(/\s+/g, ' ');
                        const truncated = preview.length > 140 ? `${preview.slice(0, 140)}…` : preview;

                        return (
                            <Pressable
                                key={p.uuid}
                                onPress={() => setSelectedUuid(p.uuid)}
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
        width: '100%',
        maxWidth: 560,
        maxHeight: '85%',
        overflow: 'hidden',
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
