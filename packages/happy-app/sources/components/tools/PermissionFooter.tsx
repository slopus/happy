import React, { useEffect, useRef, useState } from 'react';
import {
    Animated,
    Easing,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
    type StyleProp,
    type TextStyle,
    type ViewStyle,
} from 'react-native';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { useUnistyles } from 'react-native-unistyles';
import { storage } from '@/sync/storage';
import { t } from '@/text';

interface PermissionActionButtonProps {
    label: string;
    loading: boolean;
    disabled: boolean;
    onPress: () => void;
    activeOpacity: number;
    buttonStyle: StyleProp<ViewStyle>;
    contentStyle: StyleProp<ViewStyle>;
    textStyle: StyleProp<TextStyle>;
    ringStyle: StyleProp<ViewStyle>;
    ringColor: string;
    numberOfLines?: number;
}

const PermissionActionButton = React.memo(function PermissionActionButton({
    label,
    loading,
    disabled,
    onPress,
    activeOpacity,
    buttonStyle,
    contentStyle,
    textStyle,
    ringStyle,
    ringColor,
    numberOfLines = 1,
}: PermissionActionButtonProps) {
    const pulse = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        if (!loading) {
            pulse.stopAnimation();
            pulse.setValue(0);
            return;
        }

        pulse.setValue(0);
        const animation = Animated.loop(
            Animated.sequence([
                Animated.timing(pulse, {
                    toValue: 1,
                    duration: 720,
                    easing: Easing.inOut(Easing.quad),
                    useNativeDriver: true,
                }),
                Animated.timing(pulse, {
                    toValue: 0,
                    duration: 720,
                    easing: Easing.inOut(Easing.quad),
                    useNativeDriver: true,
                }),
            ]),
        );
        animation.start();

        return () => {
            animation.stop();
        };
    }, [loading, pulse]);

    const ringOpacity = pulse.interpolate({
        inputRange: [0, 1],
        outputRange: [0.18, 0.52],
    });

    return (
        <TouchableOpacity
            style={buttonStyle}
            onPress={onPress}
            disabled={disabled}
            activeOpacity={activeOpacity}
        >
            <View style={contentStyle}>
                <Text style={textStyle} numberOfLines={numberOfLines} ellipsizeMode="tail">
                    {label}
                </Text>
            </View>
            {loading ? (
                <Animated.View
                    pointerEvents="none"
                    style={[
                        ringStyle,
                        {
                            borderColor: ringColor,
                            opacity: ringOpacity,
                        },
                    ]}
                />
            ) : null}
        </TouchableOpacity>
    );
});

interface PermissionFooterProps {
    permission: {
        id: string;
        status: "pending" | "approved" | "denied" | "canceled";
        reason?: string;
        mode?: string;
        allowedTools?: string[];
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    };
    sessionId: string;
    toolName: string;
    toolInput?: any;
    metadata?: any;
}

export const PermissionFooter: React.FC<PermissionFooterProps> = ({ permission, sessionId, toolName, toolInput, metadata }) => {
    const { theme } = useUnistyles();
    const [loadingButton, setLoadingButton] = useState<'allow' | 'deny' | 'abort' | null>(null);
    const [loadingAllEdits, setLoadingAllEdits] = useState(false);
    const [loadingBypass, setLoadingBypass] = useState(false);
    const [loadingForSession, setLoadingForSession] = useState(false);
    
    // Check if this is a Codex session - check both metadata.flavor and tool name prefix
    const isCodex = metadata?.flavor === 'codex' || toolName.startsWith('Codex');

    const handleApprove = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingBypass || loadingForSession) return;

        setLoadingButton('allow');
        try {
            await sessionAllow(sessionId, permission.id);
        } catch (error) {
            console.error('Failed to approve permission:', error);
        } finally {
            setLoadingButton(null);
        }
    };

    const handleApproveAllEdits = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingBypass || loadingForSession) return;

        setLoadingAllEdits(true);
        try {
            await sessionAllow(sessionId, permission.id, 'acceptEdits');
            // Update the session permission mode to 'acceptEdits' for future permissions
            storage.getState().updateSessionPermissionMode(sessionId, 'acceptEdits');
        } catch (error) {
            console.error('Failed to approve all edits:', error);
        } finally {
            setLoadingAllEdits(false);
        }
    };

    const handleBypassPermissions = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingBypass || loadingForSession) return;

        setLoadingBypass(true);
        try {
            await sessionAllow(sessionId, permission.id, 'bypassPermissions');
            storage.getState().updateSessionPermissionMode(sessionId, 'bypassPermissions');
        } catch (error) {
            console.error('Failed to bypass permissions:', error);
        } finally {
            setLoadingBypass(false);
        }
    };

    const handleApproveForSession = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingBypass || loadingForSession || !toolName) return;

        setLoadingForSession(true);
        try {
            // Special handling for Bash tool - include exact command
            let toolIdentifier = toolName;
            if (toolName === 'Bash' && toolInput?.command) {
                const command = toolInput.command;
                toolIdentifier = `Bash(${command})`;
            }
            
            await sessionAllow(sessionId, permission.id, undefined, [toolIdentifier]);
        } catch (error) {
            console.error('Failed to approve for session:', error);
        } finally {
            setLoadingForSession(false);
        }
    };

    const handleDeny = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingBypass || loadingForSession) return;

        setLoadingButton('deny');
        try {
            await sessionDeny(sessionId, permission.id);
        } catch (error) {
            console.error('Failed to deny permission:', error);
        } finally {
            setLoadingButton(null);
        }
    };
    
    // Codex-specific handlers
    const handleCodexApprove = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingForSession) return;
        
        setLoadingButton('allow');
        try {
            await sessionAllow(sessionId, permission.id, undefined, undefined, 'approved');
        } catch (error) {
            console.error('Failed to approve permission:', error);
        } finally {
            setLoadingButton(null);
        }
    };
    
    const handleCodexApproveForSession = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingForSession) return;
        
        setLoadingForSession(true);
        try {
            await sessionAllow(sessionId, permission.id, undefined, undefined, 'approved_for_session');
        } catch (error) {
            console.error('Failed to approve for session:', error);
        } finally {
            setLoadingForSession(false);
        }
    };
    
    const handleCodexAbort = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingForSession) return;
        
        setLoadingButton('abort');
        try {
            await sessionDeny(sessionId, permission.id, undefined, undefined, 'abort');
        } catch (error) {
            console.error('Failed to abort permission:', error);
        } finally {
            setLoadingButton(null);
        }
    };

    const isApproved = permission.status === 'approved';
    const isDenied = permission.status === 'denied';
    const isPending = permission.status === 'pending';

    // Helper function to check if tool matches allowed pattern
    const isToolAllowed = (toolName: string, toolInput: any, allowedTools: string[] | undefined): boolean => {
        if (!allowedTools) return false;
        
        // Direct match for non-Bash tools
        if (allowedTools.includes(toolName)) return true;
        
        // For Bash, check exact command match
        if (toolName === 'Bash' && toolInput?.command) {
            const command = toolInput.command;
            return allowedTools.includes(`Bash(${command})`);
        }
        
        return false;
    };

    // Detect which button was used based on mode (for Claude) or decision (for Codex)
    const isApprovedViaAllow = isApproved && permission.mode !== 'acceptEdits' && permission.mode !== 'bypassPermissions' && !isToolAllowed(toolName, toolInput, permission.allowedTools);
    const isApprovedViaAllEdits = isApproved && permission.mode === 'acceptEdits';
    const isApprovedViaBypass = isApproved && permission.mode === 'bypassPermissions';
    const isApprovedForSession = isApproved && isToolAllowed(toolName, toolInput, permission.allowedTools);
    
    // Codex-specific status detection with fallback
    const isCodexApproved = isCodex && isApproved && (permission.decision === 'approved' || !permission.decision);
    const isCodexApprovedForSession = isCodex && isApproved && permission.decision === 'approved_for_session';
    const isCodexAborted = isCodex && isDenied && permission.decision === 'abort';

    const styles = StyleSheet.create({
        container: {
            paddingHorizontal: 6,
            paddingTop: 4,
            paddingBottom: 8,
            justifyContent: 'center',
        },
        buttonContainer: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 7,
            alignItems: 'center',
        },
        button: {
            paddingHorizontal: 10,
            paddingVertical: 7,
            borderRadius: 7,
            backgroundColor: 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 34,
            maxWidth: '100%',
            borderWidth: 1,
            borderColor: theme.colors.textSecondary,
            flexShrink: 1,
            opacity: 0.62,
            overflow: 'hidden',
            position: 'relative',
        },
        buttonAllow: {
            borderColor: theme.colors.textSecondary,
        },
        buttonDeny: {
            borderColor: theme.colors.textSecondary,
        },
        buttonAllowAll: {
            borderColor: theme.colors.textSecondary,
        },
        buttonSelected: {
            backgroundColor: 'transparent',
            borderColor: theme.colors.textSecondary,
            opacity: 1,
        },
        buttonInactive: {
            opacity: 0.62,
        },
        buttonContent: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            minHeight: 18,
            minWidth: 0,
        },
        buttonRing: {
            ...StyleSheet.absoluteFillObject,
            top: -1,
            right: -1,
            bottom: -1,
            left: -1,
            borderRadius: 8,
            borderWidth: 2,
        },
        buttonLoading: {
            opacity: 1,
        },
        buttonText: {
            fontSize: 14,
            lineHeight: 18,
            fontWeight: '400',
            color: theme.colors.text,
        },
        buttonTextAllow: {
            color: theme.colors.text,
            fontWeight: '500',
        },
        buttonTextDeny: {
            color: theme.colors.text,
            fontWeight: '500',
        },
        buttonTextAllowAll: {
            color: theme.colors.text,
            fontWeight: '500',
        },
        buttonTextSelected: {
            color: theme.colors.text,
            fontWeight: '500',
        },
        buttonForSession: {
            borderColor: theme.colors.textSecondary,
        },
        buttonTextForSession: {
            color: theme.colors.text,
            fontWeight: '500',
        },
    });

    const renderPermissionButton = ({
        label,
        loading,
        onPress,
        disabled,
        buttonStyle,
        textStyle,
        numberOfLines = 1,
    }: {
        label: string;
        loading: boolean;
        onPress: () => void;
        disabled: boolean;
        buttonStyle: StyleProp<ViewStyle>;
        textStyle: StyleProp<TextStyle>;
        numberOfLines?: number;
    }) => (
        <PermissionActionButton
            label={label}
            loading={loading && isPending}
            onPress={onPress}
            disabled={disabled}
            activeOpacity={isPending ? 0.7 : 1}
            buttonStyle={[
                buttonStyle,
                loading && isPending ? styles.buttonLoading : null,
            ]}
            contentStyle={styles.buttonContent}
            textStyle={textStyle}
            ringStyle={styles.buttonRing}
            ringColor={theme.colors.text}
            numberOfLines={numberOfLines}
        />
    );

    // Render Codex buttons if this is a Codex session
    if (isCodex) {
        return (
            <View style={styles.container}>
                <View style={styles.buttonContainer}>
                    {renderPermissionButton({
                        label: t('common.yes'),
                        loading: loadingButton === 'allow',
                        onPress: handleCodexApprove,
                        disabled: !isPending || loadingButton !== null || loadingForSession,
                        buttonStyle: [
                            styles.button,
                            isPending && styles.buttonAllow,
                            isCodexApproved && styles.buttonSelected,
                            (isCodexAborted || isCodexApprovedForSession) && styles.buttonInactive
                        ],
                        textStyle: [
                            styles.buttonText,
                            isPending && styles.buttonTextAllow,
                            isCodexApproved && styles.buttonTextSelected
                        ],
                    })}

                    {renderPermissionButton({
                        label: t('codex.permissions.yesForSession'),
                        loading: loadingForSession,
                        onPress: handleCodexApproveForSession,
                        disabled: !isPending || loadingButton !== null || loadingForSession,
                        buttonStyle: [
                            styles.button,
                            isPending && styles.buttonForSession,
                            isCodexApprovedForSession && styles.buttonSelected,
                            (isCodexAborted || isCodexApproved) && styles.buttonInactive
                        ],
                        textStyle: [
                            styles.buttonText,
                            isPending && styles.buttonTextForSession,
                            isCodexApprovedForSession && styles.buttonTextSelected
                        ],
                        numberOfLines: 2,
                    })}

                    {renderPermissionButton({
                        label: t('codex.permissions.stopAndExplain'),
                        loading: loadingButton === 'abort',
                        onPress: handleCodexAbort,
                        disabled: !isPending || loadingButton !== null || loadingForSession,
                        buttonStyle: [
                            styles.button,
                            isPending && styles.buttonDeny,
                            isCodexAborted && styles.buttonSelected,
                            (isCodexApproved || isCodexApprovedForSession) && styles.buttonInactive
                        ],
                        textStyle: [
                            styles.buttonText,
                            isPending && styles.buttonTextDeny,
                            isCodexAborted && styles.buttonTextSelected
                        ],
                        numberOfLines: 2,
                    })}
                </View>
            </View>
        );
    }

    // Render Claude buttons (existing behavior)
    return (
        <View style={styles.container}>
            <View style={styles.buttonContainer}>
                {renderPermissionButton({
                    label: t('common.yes'),
                    loading: loadingButton === 'allow',
                    onPress: handleApprove,
                    disabled: !isPending || loadingButton !== null || loadingAllEdits || loadingBypass || loadingForSession,
                    buttonStyle: [
                        styles.button,
                        isPending && styles.buttonAllow,
                        isApprovedViaAllow && styles.buttonSelected,
                        (isDenied || isApprovedViaAllEdits || isApprovedViaBypass || isApprovedForSession) && styles.buttonInactive
                    ],
                    textStyle: [
                        styles.buttonText,
                        isPending && styles.buttonTextAllow,
                        isApprovedViaAllow && styles.buttonTextSelected
                    ],
                })}

                {/* Allow All Edits button - only show for Edit and MultiEdit tools */}
                {(toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write' || toolName === 'NotebookEdit' || toolName === 'exit_plan_mode' || toolName === 'ExitPlanMode') && (
                    renderPermissionButton({
                        label: t('claude.permissions.yesAllowAllEdits'),
                        loading: loadingAllEdits,
                        onPress: handleApproveAllEdits,
                        disabled: !isPending || loadingButton !== null || loadingAllEdits || loadingBypass || loadingForSession,
                        buttonStyle: [
                            styles.button,
                            isPending && styles.buttonAllowAll,
                            isApprovedViaAllEdits && styles.buttonSelected,
                            (isDenied || isApprovedViaAllow || isApprovedViaBypass || isApprovedForSession) && styles.buttonInactive
                        ],
                        textStyle: [
                            styles.buttonText,
                            isPending && styles.buttonTextAllowAll,
                            isApprovedViaAllEdits && styles.buttonTextSelected
                        ],
                        numberOfLines: 2,
                    })
                )}

                {/* Bypass all permissions (yolo mode) - only show for ExitPlanMode */}
                {(toolName === 'exit_plan_mode' || toolName === 'ExitPlanMode') && (
                    renderPermissionButton({
                        label: t('claude.permissions.yesAllowEverything'),
                        loading: loadingBypass,
                        onPress: handleBypassPermissions,
                        disabled: !isPending || loadingButton !== null || loadingAllEdits || loadingBypass || loadingForSession,
                        buttonStyle: [
                            styles.button,
                            isPending && styles.buttonForSession,
                            isApprovedViaBypass && styles.buttonSelected,
                            (isDenied || isApprovedViaAllow || isApprovedViaAllEdits || isApprovedForSession) && styles.buttonInactive
                        ],
                        textStyle: [
                            styles.buttonText,
                            isPending && styles.buttonTextForSession,
                            isApprovedViaBypass && styles.buttonTextSelected
                        ],
                        numberOfLines: 2,
                    })
                )}

                {/* Allow for session button - only show for non-edit, non-exit-plan tools */}
                {toolName && toolName !== 'Edit' && toolName !== 'MultiEdit' && toolName !== 'Write' && toolName !== 'NotebookEdit' && toolName !== 'exit_plan_mode' && toolName !== 'ExitPlanMode' && (
                    renderPermissionButton({
                        label: t('claude.permissions.yesForTool'),
                        loading: loadingForSession,
                        onPress: handleApproveForSession,
                        disabled: !isPending || loadingButton !== null || loadingAllEdits || loadingBypass || loadingForSession,
                        buttonStyle: [
                            styles.button,
                            isPending && styles.buttonForSession,
                            isApprovedForSession && styles.buttonSelected,
                            (isDenied || isApprovedViaAllow || isApprovedViaAllEdits || isApprovedViaBypass) && styles.buttonInactive
                        ],
                        textStyle: [
                            styles.buttonText,
                            isPending && styles.buttonTextForSession,
                            isApprovedForSession && styles.buttonTextSelected
                        ],
                        numberOfLines: 2,
                    })
                )}

                {renderPermissionButton({
                    label: t('claude.permissions.noTellClaude'),
                    loading: loadingButton === 'deny',
                    onPress: handleDeny,
                    disabled: !isPending || loadingButton !== null || loadingAllEdits || loadingBypass || loadingForSession,
                    buttonStyle: [
                        styles.button,
                        isPending && styles.buttonDeny,
                        isDenied && styles.buttonSelected,
                        (isApproved) && styles.buttonInactive
                    ],
                    textStyle: [
                        styles.buttonText,
                        isPending && styles.buttonTextDeny,
                        isDenied && styles.buttonTextSelected
                    ],
                    numberOfLines: 2,
                })}
            </View>
        </View>
    );
};
