import React, { useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { sessionAbort, sessionAllow, sessionDeny } from '@/sync/ops';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { storage } from '@/sync/storage';
import { t } from '@/text';
import { resolveAgentIdForPermissionUi } from '@/agents/resolve';
import { getPermissionFooterCopy } from '@/agents/permissionUiCopy';
import { extractShellCommand } from './utils/shellCommand';
import { parseParenIdentifier } from './utils/parseParenIdentifier';
import { formatPermissionRequestSummary } from './utils/permissionSummary';

interface PermissionFooterProps {
    permission: {
        id: string;
        status: "pending" | "approved" | "denied" | "canceled";
        reason?: string;
        mode?: string;
        allowedTools?: string[];
        allowTools?: string[]; // legacy alias
        decision?: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
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
    const [loadingForSession, setLoadingForSession] = useState(false);
    const [loadingForSessionPrefix, setLoadingForSessionPrefix] = useState(false);
    const [loadingForSessionCommandName, setLoadingForSessionCommandName] = useState(false);
    const [loadingExecPolicy, setLoadingExecPolicy] = useState(false);
    
    const agentId = resolveAgentIdForPermissionUi({ flavor: metadata?.flavor, toolName });
    const copy = getPermissionFooterCopy(agentId);
    const isCodexDecision = copy.protocol === 'codexDecision';
    // Codex always provides proposed_execpolicy_amendment
    const execPolicyCommand = (() => {
        const proposedAmendment = toolInput?.proposedExecpolicyAmendment ?? toolInput?.proposed_execpolicy_amendment;
        if (Array.isArray(proposedAmendment)) {
            return proposedAmendment.filter((part: unknown): part is string => typeof part === 'string' && part.length > 0);
        }
        return [];
    })();
    const canApproveExecPolicy = isCodexDecision && execPolicyCommand.length > 0;

    const handleApprove = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingForSession) return;

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
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingForSession) return;

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

    const handleApproveForSession = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingForSession || loadingForSessionPrefix || !toolName) return;

        setLoadingForSession(true);
        try {
            // Special handling for shell/exec tools - include exact command
            let toolIdentifier = toolName;
            const command = extractShellCommand(toolInput);
            const lower = toolName.toLowerCase();
            if (command && (lower === 'bash' || lower === 'execute' || lower === 'shell')) {
                toolIdentifier = `${toolName}(${command})`;
            }
            
            await sessionAllow(sessionId, permission.id, undefined, [toolIdentifier]);
        } catch (error) {
            console.error('Failed to approve for session:', error);
        } finally {
            setLoadingForSession(false);
        }
    };

    const handleApproveForSessionSubcommand = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingForSession || loadingForSessionPrefix || loadingForSessionCommandName || !toolName) return;

        const command = extractShellCommand(toolInput);
        const lower = toolName.toLowerCase();
        if (!command || !(lower === 'bash' || lower === 'execute' || lower === 'shell')) return;

        const stripped = stripSimpleEnvPrelude(command);
        const parts = stripped.split(/\s+/).filter(Boolean);
        const cmd = parts[0];
        const sub = parts[1];
        const canUseSubcommand =
            Boolean(cmd) &&
            Boolean(sub) &&
            !sub.startsWith('-') &&
            // Only offer subcommand-level approvals for common subcommand CLIs.
            ['git', 'npm', 'yarn', 'pnpm', 'cargo', 'docker', 'kubectl', 'gh', 'brew'].includes(cmd);
        if (!canUseSubcommand) return;

        setLoadingForSessionPrefix(true);
        try {
            const toolIdentifier = `${toolName}(${cmd} ${sub}:*)`;
            await sessionAllow(sessionId, permission.id, undefined, [toolIdentifier]);
        } catch (error) {
            console.error('Failed to approve subcommand for session:', error);
        } finally {
            setLoadingForSessionPrefix(false);
        }
    };

    const handleApproveForSessionCommandName = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingForSession || loadingForSessionPrefix || loadingForSessionCommandName || !toolName) return;

        const command = extractShellCommand(toolInput);
        const lower = toolName.toLowerCase();
        if (!command || !(lower === 'bash' || lower === 'execute' || lower === 'shell')) return;

        const stripped = stripSimpleEnvPrelude(command);
        const first = stripped.split(/\s+/).filter(Boolean)[0];
        if (!first) return;

        setLoadingForSessionCommandName(true);
        try {
            const toolIdentifier = `${toolName}(${first}:*)`;
            await sessionAllow(sessionId, permission.id, undefined, [toolIdentifier]);
        } catch (error) {
            console.error('Failed to approve command name for session:', error);
        } finally {
            setLoadingForSessionCommandName(false);
        }
    };

    const handleDeny = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingForSession) return;

        setLoadingButton('deny');
        try {
            await sessionDeny(sessionId, permission.id, undefined, undefined, 'abort');
            // Denying a single tool call is not always enough to stop the agent from continuing.
            // Also abort the current session run so the agent stops and waits for the user.
            await sessionAbort(sessionId);
        } catch (error) {
            console.error('Failed to deny permission:', error);
        } finally {
            setLoadingButton(null);
        }
    };
    
    // Codex-specific handlers
    const handleCodexApprove = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingForSession || loadingExecPolicy) return;
        
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
        if (permission.status !== 'pending' || loadingButton !== null || loadingForSession || loadingExecPolicy) return;
        
        setLoadingForSession(true);
        try {
            await sessionAllow(sessionId, permission.id, undefined, undefined, 'approved_for_session');
        } catch (error) {
            console.error('Failed to approve for session:', error);
        } finally {
            setLoadingForSession(false);
        }
    };

    const handleCodexApproveExecPolicy = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingForSession || loadingExecPolicy || !canApproveExecPolicy) return;

        setLoadingExecPolicy(true);
        try {
            await sessionAllow(
                sessionId,
                permission.id,
                undefined,
                undefined,
                'approved_execpolicy_amendment',
                { command: execPolicyCommand }
            );
        } catch (error) {
            console.error('Failed to approve with execpolicy amendment:', error);
        } finally {
            setLoadingExecPolicy(false);
        }
    };
    
    const handleCodexAbort = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingForSession || loadingExecPolicy) return;
        
        setLoadingButton('abort');
        try {
            await sessionDeny(sessionId, permission.id, undefined, undefined, 'abort');
            // Denying a single tool call is not always enough to stop the agent from continuing.
            // Also abort the current session run so the agent stops and waits for the user.
            await sessionAbort(sessionId);
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
    const getAllowedToolsList = (permission: any): string[] | undefined => {
        const list = permission?.allowedTools ?? permission?.allowTools;
        return Array.isArray(list) ? list : undefined;
    };

    const shellToolNames = new Set(['bash', 'execute', 'shell']);

    const stripSimpleEnvPrelude = (command: string): string => {
        const parts = command.trim().split(/\s+/);
        let i = 0;
        while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i])) {
            i++;
        }
        return parts.slice(i).join(' ');
    };

    const matchesPrefix = (command: string, prefix: string): boolean => {
        if (!command || !prefix) return false;
        if (!command.startsWith(prefix)) return false;
        if (command.length === prefix.length) return true;
        if (prefix.endsWith(' ')) return true;
        return command[prefix.length] === ' ';
    };

    const isToolAllowed = (toolName: string, toolInput: any, allowedTools: string[] | undefined): boolean => {
        if (!allowedTools) return false;
        
        // Direct match for non-Bash tools
        if (allowedTools.includes(toolName)) return true;
        
        // For shell/exec tools, check exact command match
        const command = extractShellCommand(toolInput);
        const lower = toolName.toLowerCase();
        if (command && shellToolNames.has(lower)) {
            const exact = `${toolName}(${command})`;
            if (allowedTools.includes(exact)) return true;

            // Also accept prefixes (e.g. `Bash(git status:*)`) and shell-tool synonyms.
            const effectiveCommand = stripSimpleEnvPrelude(command);
            for (const item of allowedTools) {
                if (typeof item !== 'string') continue;
                const parsed = parseParenIdentifier(item);
                if (!parsed) continue;
                if (!shellToolNames.has(parsed.name.toLowerCase())) continue;

                const spec = parsed.spec;
                if (spec.endsWith(':*')) {
                    const prefix = spec.slice(0, -2);
                    if (prefix && matchesPrefix(effectiveCommand, prefix)) return true;
                } else if (spec === command) {
                    return true;
                }
            }
        }
        
        return false;
    };

    // Detect which button was used based on mode (for Claude) or decision (for Codex)
    const allowedTools = getAllowedToolsList(permission);
    const commandForShell = extractShellCommand(toolInput);
    const isShellTool = shellToolNames.has(toolName.toLowerCase());

    const isApprovedForSessionSubcommand = (() => {
        if (!isApproved || !allowedTools || !isShellTool || !commandForShell) return false;
        const effectiveCommand = stripSimpleEnvPrelude(commandForShell);
        const parts = effectiveCommand.split(/\s+/).filter(Boolean);
        const cmd = parts[0];
        const sub = parts[1];
        if (!cmd || !sub) return false;
        if (sub.startsWith('-')) return false;
        if (!['git', 'npm', 'yarn', 'pnpm', 'cargo', 'docker', 'kubectl', 'gh', 'brew'].includes(cmd)) return false;

        for (const item of allowedTools) {
            if (typeof item !== 'string') continue;
            const parsed = parseParenIdentifier(item);
            if (!parsed) continue;
            if (!shellToolNames.has(parsed.name.toLowerCase())) continue;
            const spec = parsed.spec;
            if (spec.endsWith(':*')) {
                const prefix = spec.slice(0, -2);
                if (prefix && matchesPrefix(effectiveCommand, prefix) && prefix.trim() === `${cmd} ${sub}`) return true;
            }
        }
        return false;
    })();

    const isApprovedForSessionExact = (() => {
        if (!isApproved || !allowedTools || !isShellTool || !commandForShell) return false;
        for (const item of allowedTools) {
            if (typeof item !== 'string') continue;
            const parsed = parseParenIdentifier(item);
            if (!parsed) continue;
            if (!shellToolNames.has(parsed.name.toLowerCase())) continue;
            if (!parsed.spec.endsWith(':*') && parsed.spec === commandForShell) return true;
        }
        return false;
    })();

    const isApprovedForSessionCommandName = (() => {
        if (!isApproved || !allowedTools || !isShellTool || !commandForShell) return false;
        const effective = stripSimpleEnvPrelude(commandForShell);
        const first = effective.split(/\s+/).filter(Boolean)[0];
        if (!first) return false;
        for (const item of allowedTools) {
            if (typeof item !== 'string') continue;
            const parsed = parseParenIdentifier(item);
            if (!parsed) continue;
            if (!shellToolNames.has(parsed.name.toLowerCase())) continue;
            if (parsed.spec === `${first}:*`) return true;
        }
        return false;
    })();

    const isApprovedForSession = isApproved && (
        isShellTool
            ? (isApprovedForSessionExact || isApprovedForSessionSubcommand)
            : isToolAllowed(toolName, toolInput, allowedTools)
    );

    const isApprovedViaAllow = isApproved && permission.mode !== 'acceptEdits' && !isApprovedForSession;
    const isApprovedViaAllEdits = isApproved && permission.mode === 'acceptEdits';
    
    // Codex-specific status detection with fallback
    const isCodexApproved = isCodexDecision && isApproved && (permission.decision === 'approved' || !permission.decision);
    const isCodexApprovedForSession = isCodexDecision && isApproved && permission.decision === 'approved_for_session';
    const isCodexApprovedExecPolicy = isCodexDecision && isApproved && permission.decision === 'approved_execpolicy_amendment';
    const isCodexAborted = isCodexDecision && isDenied && permission.decision === 'abort';

    const styles = StyleSheet.create({
        container: {
            paddingHorizontal: 12,
            paddingVertical: 8,
            justifyContent: 'center',
            gap: 10,
        },
        summary: {
            fontSize: 12,
            color: theme.colors.textSecondary,
        },
        buttonContainer: {
            flexDirection: 'column',
            gap: 4,
            alignItems: 'flex-start',
        },
        button: {
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderRadius: 1,
            backgroundColor: 'transparent',
            alignItems: 'flex-start',
            justifyContent: 'center',
            minHeight: 32,
            borderLeftWidth: 3,
            borderLeftColor: 'transparent',
            alignSelf: 'stretch',
        },
        buttonAllow: {
            backgroundColor: 'transparent',
        },
        buttonDeny: {
            backgroundColor: 'transparent',
        },
        buttonAllowAll: {
            backgroundColor: 'transparent',
        },
        buttonSelected: {
            backgroundColor: 'transparent',
            borderLeftColor: theme.colors.text,
        },
        buttonInactive: {
            opacity: 0.3,
        },
        buttonContent: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            minHeight: 20,
        },
        icon: {
            marginRight: 2,
        },
        buttonText: {
            fontSize: 14,
            fontWeight: '400',
            color: theme.colors.textSecondary,
        },
        buttonTextAllow: {
            color: theme.colors.permissionButton.allow.background,
            fontWeight: '500',
        },
        buttonTextDeny: {
            color: theme.colors.permissionButton.deny.background,
            fontWeight: '500',
        },
        buttonTextAllowAll: {
            color: theme.colors.permissionButton.allowAll.background,
            fontWeight: '500',
        },
        buttonTextSelected: {
            color: theme.colors.text,
            fontWeight: '500',
        },
        buttonForSession: {
            backgroundColor: 'transparent',
        },
        buttonTextForSession: {
            color: theme.colors.permissionButton.allowAll.background,
            fontWeight: '500',
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
        loadingIndicatorForSession: {
            color: theme.colors.permissionButton.allowAll.background,
        },
        iconApproved: {
            color: theme.colors.permissionButton.allow.background,
        },
        iconDenied: {
            color: theme.colors.permissionButton.deny.background,
        },
    });

    // Render Codex-style decision buttons if the agent uses the Codex decision protocol.
    if (copy.protocol === 'codexDecision') {
        return (
            <View style={styles.container}>
                <Text style={styles.summary} numberOfLines={2} ellipsizeMode="tail">
                    {formatPermissionRequestSummary({ toolName, toolInput })}
                </Text>
                <View style={styles.buttonContainer}>
                    {/* Codex: Yes button */}
                    <TouchableOpacity
                        style={[
                            styles.button,
                            isPending && styles.buttonAllow,
                            isCodexApproved && styles.buttonSelected,
                            (isCodexAborted || isCodexApprovedForSession || isCodexApprovedExecPolicy) && styles.buttonInactive
                        ]}
                        onPress={handleCodexApprove}
                        disabled={!isPending || loadingButton !== null || loadingForSession || loadingExecPolicy}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {loadingButton === 'allow' && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={styles.loadingIndicatorAllow.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextAllow,
                                    isCodexApproved && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {t('common.yes')}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>

                    {/* Codex: Yes, always allow this command button */}
                    {canApproveExecPolicy && (
                        <TouchableOpacity
                            style={[
                                styles.button,
                                isPending && styles.buttonForSession,
                                isCodexApprovedExecPolicy && styles.buttonSelected,
                                (isCodexAborted || isCodexApproved || isCodexApprovedForSession) && styles.buttonInactive
                            ]}
                            onPress={handleCodexApproveExecPolicy}
                            disabled={!isPending || loadingButton !== null || loadingForSession || loadingExecPolicy}
                            activeOpacity={isPending ? 0.7 : 1}
                        >
                            {loadingExecPolicy && isPending ? (
                                <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                    <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={styles.loadingIndicatorForSession.color} />
                                </View>
                            ) : (
                                <View style={styles.buttonContent}>
                                    <Text style={[
                                        styles.buttonText,
                                        isPending && styles.buttonTextForSession,
                                        isCodexApprovedExecPolicy && styles.buttonTextSelected
                                    ]} numberOfLines={1} ellipsizeMode="tail">
                                        {t(copy.yesAlwaysAllowCommandKey)}
                                    </Text>
                                </View>
                            )}
                        </TouchableOpacity>
                    )}

                    {/* Codex: Yes, and don't ask for a session button */}
                    <TouchableOpacity
                        style={[
                            styles.button,
                            isPending && styles.buttonForSession,
                            isCodexApprovedForSession && styles.buttonSelected,
                            (isCodexAborted || isCodexApproved || isCodexApprovedExecPolicy) && styles.buttonInactive
                        ]}
                        onPress={handleCodexApproveForSession}
                        disabled={!isPending || loadingButton !== null || loadingForSession || loadingExecPolicy}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {loadingForSession && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={styles.loadingIndicatorForSession.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextForSession,
                                    isCodexApprovedForSession && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {t(copy.yesForSessionKey)}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>

                    {/* Codex: Stop, and explain what to do button */}
                    <TouchableOpacity
                        style={[
                            styles.button,
                            isPending && styles.buttonDeny,
                            isCodexAborted && styles.buttonSelected,
                            (isCodexApproved || isCodexApprovedForSession || isCodexApprovedExecPolicy) && styles.buttonInactive
                        ]}
                        onPress={handleCodexAbort}
                        disabled={!isPending || loadingButton !== null || loadingForSession || loadingExecPolicy}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {loadingButton === 'abort' && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={styles.loadingIndicatorDeny.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextDeny,
                                    isCodexAborted && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {t(copy.stopAndExplainKey)}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>
                </View>
            </View>
        );
    }

    // Render Claude buttons (existing behavior)
    const showAllowForSessionSubcommand = isShellTool && typeof commandForShell === 'string' && (() => {
        const stripped = stripSimpleEnvPrelude(String(commandForShell));
        const parts = stripped.split(/\s+/).filter(Boolean);
        const cmd = parts[0];
        const sub = parts[1];
        return Boolean(cmd) && Boolean(sub) && !String(sub).startsWith('-') && ['git', 'npm', 'yarn', 'pnpm', 'cargo', 'docker', 'kubectl', 'gh', 'brew'].includes(String(cmd));
    })();
    const showAllowForSessionCommandName = isShellTool && typeof commandForShell === 'string' && commandForShell.length > 0 && Boolean(stripSimpleEnvPrelude(String(commandForShell)).split(/\s+/).filter(Boolean)[0]);
    return (
        <View style={styles.container}>
            <Text style={styles.summary} numberOfLines={2} ellipsizeMode="tail">
                {formatPermissionRequestSummary({ toolName, toolInput })}
            </Text>
            <View style={styles.buttonContainer}>
                <TouchableOpacity
                    style={[
                        styles.button,
                        isPending && styles.buttonAllow,
                        isApprovedViaAllow && styles.buttonSelected,
                        (isDenied || isApprovedViaAllEdits || isApprovedForSession) && styles.buttonInactive
                    ]}
                    onPress={handleApprove}
                    disabled={!isPending || loadingButton !== null || loadingAllEdits || loadingForSession}
                    activeOpacity={isPending ? 0.7 : 1}
                >
                    {loadingButton === 'allow' && isPending ? (
                        <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                            <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={styles.loadingIndicatorAllow.color} />
                        </View>
                    ) : (
                        <View style={styles.buttonContent}>
                            <Text style={[
                                styles.buttonText,
                                isPending && styles.buttonTextAllow,
                                isApprovedViaAllow && styles.buttonTextSelected
                            ]} numberOfLines={1} ellipsizeMode="tail">
                                {t('common.yes')}
                            </Text>
                        </View>
                    )}
                </TouchableOpacity>

                {/* Allow All Edits button - only show for edit/write tools */}
                {(toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write' || toolName === 'NotebookEdit') && (
                    <TouchableOpacity
                        style={[
                            styles.button,
                            isPending && styles.buttonAllowAll,
                            isApprovedViaAllEdits && styles.buttonSelected,
                            (isDenied || isApprovedViaAllow || isApprovedForSession) && styles.buttonInactive
                        ]}
                        onPress={handleApproveAllEdits}
                        disabled={!isPending || loadingButton !== null || loadingAllEdits || loadingForSession}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {loadingAllEdits && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={styles.loadingIndicatorAllowAll.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextAllowAll,
                                    isApprovedViaAllEdits && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {t(copy.yesAllowAllEditsKey)}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>
                )}

                {/* Allow for session button - only show for non-edit, non-exit-plan tools */}
                {toolName && toolName !== 'Edit' && toolName !== 'MultiEdit' && toolName !== 'Write' && toolName !== 'NotebookEdit' && toolName !== 'exit_plan_mode' && toolName !== 'ExitPlanMode' && (
                    <TouchableOpacity
                        style={[
                            styles.button,
                            isPending && styles.buttonForSession,
                            ((isShellTool ? isApprovedForSessionExact : isApprovedForSession) && styles.buttonSelected),
                            (isDenied || isApprovedViaAllow || isApprovedViaAllEdits) && styles.buttonInactive
                        ]}
                        onPress={handleApproveForSession}
                        disabled={!isPending || loadingButton !== null || loadingAllEdits || loadingForSession || loadingForSessionPrefix || loadingForSessionCommandName}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {loadingForSession && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={styles.loadingIndicatorForSession.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextForSession,
                                    (isShellTool ? isApprovedForSessionExact : isApprovedForSession) && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {t(copy.yesForToolKey)}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>
                )}

                {/* Allow subcommand for session (shell tools only) */}
                {toolName && toolName !== 'Edit' && toolName !== 'MultiEdit' && toolName !== 'Write' && toolName !== 'NotebookEdit' && toolName !== 'exit_plan_mode' && toolName !== 'ExitPlanMode' && showAllowForSessionSubcommand && (
                    <TouchableOpacity
                        style={[
                            styles.button,
                            isPending && styles.buttonForSession,
                            (isApprovedForSessionSubcommand && !isApprovedForSessionCommandName) && styles.buttonSelected,
                            (isDenied || isApprovedViaAllow || isApprovedViaAllEdits || (isShellTool ? isApprovedForSessionExact : isApprovedForSession)) && styles.buttonInactive
                        ]}
                        onPress={handleApproveForSessionSubcommand}
                        disabled={!isPending || loadingButton !== null || loadingAllEdits || loadingForSession || loadingForSessionPrefix || loadingForSessionCommandName}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {loadingForSessionPrefix && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={styles.loadingIndicatorForSession.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextForSession,
                                    (isApprovedForSessionSubcommand && !isApprovedForSessionCommandName) && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {(() => {
                                        const stripped = stripSimpleEnvPrelude(String(commandForShell));
                                        const parts = stripped.split(/\s+/).filter(Boolean);
                                        const cmd = parts[0] ?? '';
                                        const sub = parts[1] ?? '';
                                        return `${t('claude.permissions.yesForSubcommand')}${cmd && sub ? ` (${cmd} ${sub})` : ''}`;
                                    })()}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>
                )}

                {/* Allow command name for session (shell tools only) */}
                {toolName && toolName !== 'Edit' && toolName !== 'MultiEdit' && toolName !== 'Write' && toolName !== 'NotebookEdit' && toolName !== 'exit_plan_mode' && toolName !== 'ExitPlanMode' && showAllowForSessionCommandName && (
                    <TouchableOpacity
                        style={[
                            styles.button,
                            isPending && styles.buttonForSession,
                            isApprovedForSessionCommandName && styles.buttonSelected,
                            (isDenied || isApprovedViaAllow || isApprovedViaAllEdits || (isShellTool ? isApprovedForSessionExact : isApprovedForSession)) && styles.buttonInactive
                        ]}
                        onPress={handleApproveForSessionCommandName}
                        disabled={!isPending || loadingButton !== null || loadingAllEdits || loadingForSession || loadingForSessionPrefix || loadingForSessionCommandName}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {loadingForSessionCommandName && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={styles.loadingIndicatorForSession.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextForSession,
                                    isApprovedForSessionCommandName && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {t('claude.permissions.yesForCommandName')}{typeof commandForShell === 'string' ? ` (${stripSimpleEnvPrelude(commandForShell).split(/\s+/).filter(Boolean)[0] ?? ''})` : ''}
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
                    disabled={!isPending || loadingButton !== null || loadingAllEdits || loadingForSession}
                    activeOpacity={isPending ? 0.7 : 1}
                >
                    {loadingButton === 'deny' && isPending ? (
                        <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                            <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={styles.loadingIndicatorDeny.color} />
                        </View>
                    ) : (
                        <View style={styles.buttonContent}>
                            <Text style={[
                                styles.buttonText,
                                isPending && styles.buttonTextDeny,
                                isDenied && styles.buttonTextSelected
                            ]} numberOfLines={1} ellipsizeMode="tail">
                                {t(copy.noTellAgentKey)}
                            </Text>
                        </View>
                    )}
                </TouchableOpacity>
            </View>
        </View>
    );
};
