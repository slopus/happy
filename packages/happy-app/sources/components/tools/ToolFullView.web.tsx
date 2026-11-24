import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useLocalSetting } from '@/sync/storage';
import type { Message, ToolCall } from '@/sync/typesMessage';
import type { Metadata } from '@/sync/storageTypes';
import { t } from '@/text';
import { getTerminalToolCommand } from '@/utils/toolDisplay';
import { getEffectiveToolName } from '@/utils/toolIdentity';
import { CodeView } from '../CodeView';
import { CommandView } from '../CommandView';
import { TranscriptReadOnlyContext } from '../TranscriptReadOnlyContext';
import { PermissionFooter } from './PermissionFooter';
import { getToolFullViewComponent } from './views/_all';
import { ToolDetailContentSizeContext } from './ToolDetailLayout';

interface ToolFullViewProps {
    tool: ToolCall;
    metadata?: Metadata | null;
    messages?: Message[];
    sessionId?: string;
}

const hasValue = (value: unknown) => value !== undefined && value !== null && value !== '';
const formatValue = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

/** Web detail bodies live inside the existing desktop navigation dialog. */
export function ToolFullView({ tool: originalTool, metadata, messages = [], sessionId }: ToolFullViewProps) {
    const { theme } = useUnistyles();
    const reportContentSize = React.useContext(ToolDetailContentSizeContext);
    const contentHeight = React.useRef(0);
    const onContentSizeChange = React.useCallback((_width: number, height: number) => {
        contentHeight.current = height;
        reportContentSize?.(height);
    }, [reportContentSize]);
    React.useEffect(() => {
        if (contentHeight.current > 0) reportContentSize?.(contentHeight.current);
    }, [reportContentSize]);
    const contextReadOnly = React.useContext(TranscriptReadOnlyContext);
    const readOnly = contextReadOnly || Boolean(metadata?.continuedBySessionId);
    const devModeEnabled = useLocalSetting('devModeEnabled') || __DEV__;
    const effectiveName = getEffectiveToolName(originalTool);
    const tool = effectiveName === originalTool.name ? originalTool : { ...originalTool, name: effectiveName };
    const command = getTerminalToolCommand(tool);
    const SpecializedFullView = command ? null : getToolFullViewComponent(tool.name);
    const pendingPermission = tool.state === 'running' && tool.permission?.status === 'pending';
    const summary = typeof tool.input?.toolSummary === 'string' && tool.input.toolSummary.trim()
        ? tool.input.toolSummary.trim() : tool.description;
    const resultPresent = hasValue(tool.result);
    const terminalStreams = command && tool.result && typeof tool.result === 'object'
        && (typeof tool.result.stdout === 'string' || typeof tool.result.stderr === 'string')
        ? { stdout: typeof tool.result.stdout === 'string' ? tool.result.stdout : null,
            stderr: typeof tool.result.stderr === 'string' ? tool.result.stderr : null } : null;
    const outputPresent = terminalStreams
        ? Boolean(terminalStreams.stdout?.trim() || terminalStreams.stderr?.trim()) : resultPresent;
    const statusText = pendingPermission ? t('status.permissionRequired')
        : tool.state === 'completed' ? t('toolGroup.subagentStatus.completed')
        : tool.state === 'error' ? t('toolGroup.subagentStatus.failed')
        : tool.state === 'cancelled' ? t('toolGroup.subagentStatus.cancelled')
        : t('toolGroup.subagentStatus.running');
    const statusColor = pendingPermission ? theme.colors.warning
        : tool.state === 'completed' ? theme.colors.success
        : tool.state === 'error' ? theme.colors.textDestructive : theme.colors.textSecondary;

    return <ScrollView style={styles.container} contentContainerStyle={styles.content} onContentSizeChange={onContentSizeChange} testID="tool-detail-body">
        <View style={styles.status} accessibilityLiveRegion="polite">
            {tool.state === 'running' && !pendingPermission
                ? <ActivityIndicator size="small" color={theme.colors.accent} />
                : <Ionicons size={18} color={statusColor} name={pendingPermission ? 'shield-checkmark-outline'
                    : tool.state === 'completed' ? 'checkmark-circle-outline'
                    : tool.state === 'error' ? 'close-circle-outline' : 'remove-circle-outline'} />}
            <Text style={styles.statusText}>{statusText}</Text>
            {tool.state === 'completed' && !outputPresent && !SpecializedFullView
                ? <Text style={styles.secondary}>{t('tools.fullView.noOutput')}</Text> : null}
        </View>

        {summary ? <Text selectable style={styles.description}>{summary}</Text> : null}

        {SpecializedFullView ? <TranscriptReadOnlyContext.Provider value={readOnly}>
            <SpecializedFullView tool={tool} metadata={metadata || null} messages={messages} sessionId={sessionId} />
        </TranscriptReadOnlyContext.Provider> : <>
            {command ? <Section title={t('tools.names.terminal')}>
                {terminalStreams ? <CommandView command={command} stdout={terminalStreams.stdout} stderr={terminalStreams.stderr} fullWidth hideEmptyOutput />
                    : <CodeView code={command} />}
            </Section> : null}
            {resultPresent && !terminalStreams ? <Section title={t(tool.state === 'error' ? 'tools.fullView.error' : 'tools.fullView.output')}>
                <CodeView code={formatValue(tool.result)} />
            </Section> : null}
        </>}

        {tool.state === 'error' && tool.failure && (SpecializedFullView || !outputPresent) ? <Text selectable style={styles.errorText}>
            {tool.failure.detail || tool.failure.summary}
        </Text> : null}
        {tool.state === 'cancelled' && tool.cancellationReason
            ? <Text selectable style={styles.secondary}>{tool.cancellationReason}</Text> : null}

        {pendingPermission && !readOnly && sessionId && tool.name !== 'AskUserQuestion' ? <View style={styles.permission}>
            <PermissionFooter permission={tool.permission!} sessionId={sessionId} metadata={metadata}
                toolName={tool.name} toolInput={tool.input} />
        </View> : null}

        {hasValue(tool.input) ? <Disclosure title={t('tools.fullView.inputParams')} testID="tool-detail-input">
            {() => <CodeView code={formatValue(tool.input)} />}
        </Disclosure> : null}
        {devModeEnabled ? <Disclosure title={t('tools.fullView.rawJsonDevMode')} testID="tool-detail-raw">
            {() => <CodeView code={JSON.stringify({ ...originalTool, messages }, null, 2)} />}
        </Disclosure> : null}
    </ScrollView>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text>{children}</View>;
}

function Disclosure({ title, testID, children }: { title: string; testID: string; children: () => React.ReactNode }) {
    const { theme } = useUnistyles();
    const [expanded, setExpanded] = React.useState(false);
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    const id = React.useId();
    return <View style={styles.disclosure}>
        <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded }}
            aria-expanded={expanded} aria-controls={id} testID={testID} onPress={() => setExpanded(value => !value)}
            onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
            onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
            style={({ pressed }) => [styles.disclosureButton, (hovered || pressed) && styles.pressed, focused && styles.focused]}>
            <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={15} color={theme.colors.textSecondary} />
            <Text style={styles.disclosureTitle}>{title}</Text>
        </Pressable>
        {expanded ? <View nativeID={id} style={styles.disclosureContent}>{children()}</View> : null}
    </View>;
}

const styles = StyleSheet.create(theme => ({
    container: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface },
    content: { padding: 20, gap: 16, width: '100%', maxWidth: 800, alignSelf: 'center' },
    status: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
    statusText: { ...Typography.default('semiBold'), fontSize: 13, lineHeight: 20, color: theme.colors.text },
    secondary: { ...Typography.default(), fontSize: 13, lineHeight: 20, color: theme.colors.textSecondary },
    description: { ...Typography.default(), fontSize: 14, lineHeight: 21, color: theme.colors.textSecondary },
    section: { gap: 8, minWidth: 0 },
    sectionTitle: { ...Typography.default('semiBold'), fontSize: 13, lineHeight: 20, color: theme.colors.text },
    sectionFullWidth: { marginBottom: 16 },
    errorText: { ...Typography.default(), fontSize: 14, lineHeight: 21, color: theme.colors.textDestructive },
    permission: { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, borderRadius: 8, padding: 12 },
    disclosure: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider, paddingTop: 8 },
    disclosureButton: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8, borderRadius: 6, borderWidth: 1, borderColor: 'transparent', backgroundColor: theme.colors.surface },
    disclosureTitle: { ...Typography.default(), fontSize: 13, color: theme.colors.textSecondary },
    disclosureContent: { paddingTop: 8 },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    focused: { borderColor: theme.colors.textLink },
}));

// Specialized edit views already consume this shared style export.
export const toolFullViewStyles = styles;
