import React, { useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { useUnistyles } from 'react-native-unistyles';

interface PermissionFooterProps {
    permission: {
        id: string;
        status: 'pending' | 'approved' | 'denied' | 'canceled';
    };
    sessionId: string;
    toolName?: string;
}

export const PermissionFooter: React.FC<PermissionFooterProps> = ({ permission, sessionId, toolName }) => {
    const { theme } = useUnistyles();
    const [loading, setLoading] = useState(false);
    const [loadingAllEdits, setLoadingAllEdits] = useState(false);

    const handleApprove = async () => {
        if (permission.status !== 'pending' || loading || loadingAllEdits) return;

        setLoading(true);
        try {
            await sessionAllow(sessionId, permission.id);
        } catch (error) {
            console.error('Failed to approve permission:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleApproveAllEdits = async () => {
        if (permission.status !== 'pending' || loading || loadingAllEdits) return;

        setLoadingAllEdits(true);
        try {
            await sessionAllow(sessionId, permission.id, 'acceptEdits');
        } catch (error) {
            console.error('Failed to approve all edits:', error);
        } finally {
            setLoadingAllEdits(false);
        }
    };

    const handleDeny = async () => {
        if (permission.status !== 'pending' || loading || loadingAllEdits) return;

        setLoading(true);
        try {
            await sessionDeny(sessionId, permission.id);
        } catch (error) {
            console.error('Failed to deny permission:', error);
        } finally {
            setLoading(false);
        }
    };

    const isApproved = permission.status === 'approved';
    const isDenied = permission.status === 'denied';
    const isPending = permission.status === 'pending';

    const styles = StyleSheet.create({
        container: {
            minHeight: 60,
            paddingHorizontal: 12,
            paddingVertical: 10,
            justifyContent: 'center',
        },
        buttonContainer: {
            flexDirection: 'row',
            gap: 10,
        },
        button: {
            flex: 1,
            paddingHorizontal: 20,
            paddingVertical: 12,
            borderRadius: 8,
            backgroundColor: theme.colors.permissionButton.inactive.background,
            alignItems: 'center',
            justifyContent: 'center',
            height: 44,
            borderWidth: 1,
            borderColor: theme.colors.permissionButton.inactive.border,
        },
        buttonAllow: {
            backgroundColor: theme.colors.permissionButton.allow.background,
            borderColor: theme.colors.permissionButton.allow.background,
        },
        buttonDeny: {
            backgroundColor: theme.colors.permissionButton.deny.background,
            borderColor: theme.colors.permissionButton.deny.background,
        },
        buttonAllowAll: {
            backgroundColor: theme.colors.permissionButton.allowAll.background,
            borderColor: theme.colors.permissionButton.allowAll.background,
        },
        buttonSelected: {
            backgroundColor: theme.colors.permissionButton.selected.background,
            borderColor: theme.colors.permissionButton.selected.border,
        },
        buttonInactive: {
            opacity: 0.3,
        },
        buttonContent: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
        },
        icon: {
            marginRight: 2,
        },
        buttonText: {
            fontSize: 15,
            fontWeight: '500',
            color: theme.colors.permissionButton.inactive.text,
        },
        buttonTextAllow: {
            color: theme.colors.permissionButton.allow.text,
        },
        buttonTextDeny: {
            color: theme.colors.permissionButton.deny.text,
        },
        buttonTextAllowAll: {
            color: theme.colors.permissionButton.allowAll.text,
        },
        buttonTextSelected: {
            color: theme.colors.permissionButton.selected.text,
            fontWeight: '600',
        },
        loadingIndicatorAllow: {
            color: theme.colors.permissionButton.allow.background,
        },
        loadingIndicatorDeny: {
            color: theme.colors.permissionButton.deny.background,
        },
        loadingIndicatorAllowAll: {
            color: theme.colors.permissionButton.allowAll.background,
        },
        iconApproved: {
            color: theme.colors.permissionButton.allow.background,
        },
        iconDenied: {
            color: theme.colors.permissionButton.deny.background,
        },
    });

    return (
        <View style={styles.container}>
            <View style={styles.buttonContainer}>
                <TouchableOpacity
                    style={[
                        styles.button,
                        isPending && styles.buttonAllow,
                        isApproved && styles.buttonSelected,
                        (isDenied) && styles.buttonInactive
                    ]}
                    onPress={handleApprove}
                    disabled={!isPending || loading || loadingAllEdits}
                    activeOpacity={isPending ? 0.7 : 1}
                >
                    {loading && isPending ? (
                        <ActivityIndicator size="small" color={styles.loadingIndicatorAllow.color} />
                    ) : (
                        <View style={styles.buttonContent}>
                            {isApproved && (
                                <Ionicons name="checkmark" size={16} color={styles.iconApproved.color} style={styles.icon} />
                            )}
                            <Text style={[
                                styles.buttonText,
                                isPending && styles.buttonTextAllow,
                                isApproved && styles.buttonTextSelected
                            ]}>
                                Allow
                            </Text>
                        </View>
                    )}
                </TouchableOpacity>

                {/* Allow All Edits button - only show for Edit and MultiEdit tools */}
                {(toolName === 'exit_plan_mode' || toolName === 'ExitPlanMode') && (
                    <TouchableOpacity
                        style={[
                            styles.button,
                            isPending && styles.buttonAllowAll,
                            isApproved && styles.buttonInactive,
                            isDenied && styles.buttonInactive
                        ]}
                        onPress={handleApproveAllEdits}
                        disabled={!isPending || loading || loadingAllEdits}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {loadingAllEdits && isPending ? (
                            <ActivityIndicator size="small" color={styles.loadingIndicatorAllowAll.color} />
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextAllowAll
                                ]}>
                                    All edits
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>
                )}

                <TouchableOpacity
                    style={[
                        styles.button,
                        isPending && styles.buttonDeny,
                        isDenied && styles.buttonSelected,
                        (isApproved) && styles.buttonInactive
                    ]}
                    onPress={handleDeny}
                    disabled={!isPending || loading || loadingAllEdits}
                    activeOpacity={isPending ? 0.7 : 1}
                >
                    {loading && isPending ? (
                        <ActivityIndicator size="small" color={styles.loadingIndicatorDeny.color} />
                    ) : (
                        <View style={styles.buttonContent}>
                            {isDenied && (
                                <Ionicons name="close" size={16} color={styles.iconDenied.color} style={styles.icon} />
                            )}
                            <Text style={[
                                styles.buttonText,
                                isPending && styles.buttonTextDeny,
                                isDenied && styles.buttonTextSelected
                            ]}>
                                Deny
                            </Text>
                        </View>
                    )}
                </TouchableOpacity>
            </View>
        </View>
    );
};