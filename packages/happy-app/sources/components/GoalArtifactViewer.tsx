import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { GoalArtifact, GoalTask } from '@slopus/happy-wire';
import { Text } from '@/components/StyledText';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { SimpleSyntaxHighlighter } from '@/components/SimpleSyntaxHighlighter';
import { FileView } from '@/components/tools/views/FileView';
import { GoalHtmlPreview } from '@/components/GoalHtmlPreview';
import { goalArtifactIdentity, openGoalArtifact, type GoalArtifactResponse } from '@/sync/goalBoardArtifacts';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { t } from '@/text';
import type { ImageViewerSource } from '@/sync/imageViewer';

export type GoalArtifactViewerProps = {
    sessionId: string; featurePath: string; task: GoalTask; artifact: GoalArtifact; onClose: () => void;
    closeButtonRef?: React.RefObject<View | null>;
    onOpenImage?: (source: ImageViewerSource) => void;
};
type LoadState = { identity: string; response?: GoalArtifactResponse; error?: string };
// Bound syntax-token/DOM work while keeping every original character selectable.
const MAX_HIGHLIGHT_CHARACTERS = 64 * 1024;
const languages: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python', sh: 'bash', json: 'json', yaml: 'yaml', yml: 'yaml', css: 'css', html: 'html', rs: 'rust', go: 'go', sql: 'sql', md: 'markdown', markdown: 'markdown' };

/** Mount only from the user's explicit artifact-open action. No body reads belong to board rendering. */
export const GoalArtifactViewer = React.memo(function GoalArtifactViewer({ sessionId, featurePath, task, artifact, onClose, closeButtonRef, onOpenImage }: GoalArtifactViewerProps) {
    const { theme } = useUnistyles();
    const request = { sessionId, featurePath, taskId: task.id, artifact };
    const identity = goalArtifactIdentity(request);
    const [state, setState] = React.useState<LoadState>({ identity });
    const [sourceMode, setSourceMode] = React.useState(false);
    const [retry, setRetry] = React.useState(0);
    const remote = ['text', 'image', 'audio', 'video', 'pdf'].includes(artifact.kind);
    const latestIdentity = React.useRef(identity);
    latestIdentity.current = identity;
    React.useEffect(() => {
        const controller = new AbortController();
        setState({ identity }); setSourceMode(false);
        if (remote) {
            void openGoalArtifact(request, controller.signal).then(response => {
                if (!controller.signal.aborted && latestIdentity.current === identity) setState({ identity, response });
            }).catch((cause: unknown) => {
                if (!controller.signal.aborted && latestIdentity.current === identity) {
                    setState({ identity, error: cause instanceof Error ? cause.message : t('goalBoard.artifactReadFailed') });
                }
            });
        }
        return () => controller.abort();
        // The identity includes every request/version field; artifact object changes alone do not reread.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [identity, remote, retry]);
    const current = state.identity === identity ? state : null;
    const response = current?.response;
    // Link labels describe the deliverable and need not contain its file extension.
    const originalName = artifact.path ?? (response?.kind === 'text' ? response.name : artifact.name);
    const extension = originalName.split('.').pop()?.toLowerCase() ?? '';
    const markdown = extension === 'md' || extension === 'markdown';
    const html = extension === 'html' || extension === 'htm';
    const externalUrl = artifact.url && /^https?:\/\//i.test(artifact.url) ? artifact.url : null;
    const [linkError, setLinkError] = React.useState<string | null>(null);
    const button = { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6 };
    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.surface }} testID="goal-artifact-viewer">
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderBottomWidth: 1, borderColor: theme.colors.divider }}>
                <Text style={{ flex: 1, color: theme.colors.text }} selectable>{artifact.name}</Text>
                {(markdown || html) && response?.kind === 'text' && (
                    <Pressable testID="goal-artifact-source" accessibilityRole="button" onPress={() => setSourceMode(value => !value)} style={({ pressed }) => [button, { backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceSelected }]}>
                        <Text style={{ color: theme.colors.text }}>{sourceMode ? t('goalBoard.artifactPreview') : t('goalBoard.artifactSource')}</Text>
                    </Pressable>
                )}
                <Pressable ref={closeButtonRef} testID="goal-artifact-close" accessibilityRole="button" onPress={onClose} style={({ pressed }) => [button, { backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface }]}>
                    <Text style={{ color: theme.colors.text }}>{t('goalBoard.artifactClose')}</Text>
                </Pressable>
            </View>
            {remote ? current?.error ? (
                <View style={{ padding: 16, gap: 12 }}>
                    <Text style={{ color: theme.colors.textDestructive }}>{t('goalBoard.artifactReadFailed')}{'\n'}{current.error}</Text>
                    <Pressable testID="goal-artifact-retry" accessibilityRole="button" onPress={() => setRetry(value => value + 1)} style={({ pressed }) => [button, { backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface }]}>
                        <Text style={{ color: theme.colors.text }}>{t('goalBoard.artifactRetry')}</Text>
                    </Pressable>
                </View>
            ) : !response ? <ActivityIndicator color={theme.colors.textSecondary} /> : (
                html && !sourceMode && response.kind === 'text' ? <GoalHtmlPreview content={response.content} title={artifact.name} /> :
                <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
                    {response.kind === 'text' ? markdown && !sourceMode ? (
                        <MarkdownView markdown={response.content} sessionId={sessionId} readOnly />
                    ) : (
                        <SimpleSyntaxHighlighter code={response.content} language={response.content.length <= MAX_HIGHLIGHT_CHARACTERS ? languages[extension] ?? null : null} selectable />
                    ) : (
                        <FileView key={identity} sessionId={sessionId} metadata={null} messages={[]} onOpenImage={onOpenImage} tool={{
                            name: 'file', state: 'completed', input: response.attachment,
                            createdAt: 0, startedAt: null, completedAt: null, description: null,
                        }} />
                    )}
                </ScrollView>
            ) : (
                <View style={{ padding: 16, gap: 12 }}>
                    {externalUrl ? <Pressable accessibilityRole="link" onPress={() => {
                        void openExternalUrl(externalUrl).catch((cause: unknown) => setLinkError(cause instanceof Error ? cause.message : t('goalBoard.artifactReadFailed')));
                    }}><Text style={{ color: theme.colors.text }} selectable>{externalUrl}</Text></Pressable> : <Text style={{ color: theme.colors.textSecondary }}>{t('goalBoard.artifactUnsupported')}</Text>}
                    {linkError && <Text style={{ color: theme.colors.textDestructive }}>{linkError}</Text>}
                </View>
            )}
        </View>
    );
});
