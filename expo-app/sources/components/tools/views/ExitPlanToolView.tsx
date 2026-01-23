import * as React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolViewProps } from './_all';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { knownTools } from '../../tools/knownTools';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { Modal } from '@/modal';
import { t } from '@/text';
import { Ionicons } from '@expo/vector-icons';

export const ExitPlanToolView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const { theme } = useUnistyles();
    const [isApproving, setIsApproving] = React.useState(false);
    const [isRejecting, setIsRejecting] = React.useState(false);
    const [isResponded, setIsResponded] = React.useState(false);

    let plan = '<empty>';
    const parsed = knownTools.ExitPlanMode.input.safeParse(tool.input);
    if (parsed.success) {
        plan = parsed.data.plan ?? '<empty>';
    }

    const isRunning = tool.state === 'running';
    const canInteract = isRunning && !isResponded && sessionId;

    const handleApprove = React.useCallback(async () => {
        if (!sessionId || isApproving || isRejecting || !canInteract) return;
        const permissionId = tool.permission?.id;
        if (!permissionId) {
            Modal.alert(t('common.error'), t('errors.missingPermissionId'));
            return;
        }

        setIsApproving(true);
        try {
            await sessionAllow(sessionId, permissionId);
            setIsResponded(true);
        } catch (error) {
            console.error('Failed to approve plan:', error);
        } finally {
            setIsApproving(false);
        }
    }, [sessionId, tool.permission?.id, canInteract, isApproving, isRejecting]);

    const handleReject = React.useCallback(async () => {
        if (!sessionId || isApproving || isRejecting || !canInteract) return;
        const permissionId = tool.permission?.id;
        if (!permissionId) {
            Modal.alert(t('common.error'), t('errors.missingPermissionId'));
            return;
        }

        setIsRejecting(true);
        try {
            await sessionDeny(sessionId, permissionId);
            setIsResponded(true);
        } catch (error) {
            console.error('Failed to reject plan:', error);
        } finally {
            setIsRejecting(false);
        }
    }, [sessionId, tool.permission?.id, canInteract, isApproving, isRejecting]);

    const styles = StyleSheet.create({
        container: {
            gap: 16,
        },
        planContainer: {
            paddingHorizontal: 8,
            marginTop: -10,
        },
        actionsContainer: {
            flexDirection: 'row',
            gap: 12,
            marginTop: 16,
            paddingHorizontal: 8,
            justifyContent: 'flex-end',
        },
        approveButton: {
            backgroundColor: theme.colors.button.primary.background,
            paddingHorizontal: 20,
            paddingVertical: 12,
            borderRadius: 8,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            minHeight: 44,
        },
        rejectButton: {
            backgroundColor: 'transparent',
            borderWidth: 1,
            borderColor: theme.colors.divider,
            paddingHorizontal: 20,
            paddingVertical: 12,
            borderRadius: 8,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            minHeight: 44,
        },
        buttonDisabled: {
            opacity: 0.5,
        },
        approveButtonText: {
            color: theme.colors.button.primary.tint,
            fontSize: 14,
            fontWeight: '600',
        },
        rejectButtonText: {
            color: theme.colors.text,
            fontSize: 14,
            fontWeight: '600',
        },
        respondedContainer: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingHorizontal: 8,
            marginTop: 12,
        },
        respondedText: {
            fontSize: 14,
            color: theme.colors.textSecondary,
        },
    });

    return (
        <ToolSectionView>
            <View style={styles.container}>
                <View style={styles.planContainer}>
                    <MarkdownView markdown={plan} />
                </View>

                {isResponded || tool.state === 'completed' ? (
                    <View style={styles.respondedContainer}>
                        <Ionicons
                            name="checkmark-circle"
                            size={18}
                            color={theme.colors.textSecondary}
                        />
                        <Text style={styles.respondedText}>
                            {t('tools.exitPlanMode.responded')}
                        </Text>
                    </View>
                ) : canInteract ? (
                    <View style={styles.actionsContainer}>
                        <TouchableOpacity
                            style={[
                                styles.rejectButton,
                                (isApproving || isRejecting) && styles.buttonDisabled,
                            ]}
                            onPress={handleReject}
                            disabled={isApproving || isRejecting}
                            activeOpacity={0.7}
                        >
                            {isRejecting ? (
                                <ActivityIndicator size="small" color={theme.colors.text} />
                            ) : (
                                <>
                                    <Ionicons name="close" size={18} color={theme.colors.text} />
                                    <Text style={styles.rejectButtonText}>
                                        {t('tools.exitPlanMode.reject')}
                                    </Text>
                                </>
                            )}
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[
                                styles.approveButton,
                                (isApproving || isRejecting) && styles.buttonDisabled,
                            ]}
                            onPress={handleApprove}
                            disabled={isApproving || isRejecting}
                            activeOpacity={0.7}
                        >
                            {isApproving ? (
                                <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                            ) : (
                                <>
                                    <Ionicons name="checkmark" size={18} color={theme.colors.button.primary.tint} />
                                    <Text style={styles.approveButtonText}>
                                        {t('tools.exitPlanMode.approve')}
                                    </Text>
                                </>
                            )}
                        </TouchableOpacity>
                    </View>
                ) : null}
            </View>
        </ToolSectionView>
    );
});
