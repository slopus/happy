import * as React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Text } from '@/components/StyledText';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { WorkspaceButton } from './WorkspaceButton';
import { readWorkspaceBytes } from './fileIO';
import { buildHtmlFilePreview } from './htmlPreviewBundle';

export const HtmlFilePreview = React.memo(function HtmlFilePreview({ sessionId, path, content, root, revision = 0, readBytes, onReady }: { sessionId: string; path: string; content: string; root: string; revision?: number; readBytes?: (path: string, signal?: AbortSignal) => Promise<Uint8Array>; onReady?: (ready: boolean) => void }) {
    const { theme } = useUnistyles();
    const [interactive, setInteractive] = React.useState(false);
    const [result, setResult] = React.useState<{ html?: string; error?: string }>({});
    // A Task-provided reader survives conversation switches. Its iframe must too.
    const resourceScope = readBytes ?? sessionId;
    React.useEffect(() => {
        let cancelled = false; let cleanup: (() => void) | undefined;
        const abort = new AbortController();
        setResult({}); setInteractive(false); onReady?.(false);
        void buildHtmlFilePreview(content, path, root, readBytes ? file => readBytes(file, abort.signal) : file => readWorkspaceBytes(sessionId, file)).then(value => {
            if (cancelled) { value.dispose(); return; }
            cleanup = value.dispose; setResult({ html: value.html }); onReady?.(true);
        }).catch(() => { if (!cancelled) setResult({ error: t('fileWorkspace.previewFailed') }); });
        return () => { cancelled = true; abort.abort(); cleanup?.(); };
    }, [resourceScope, path, content, root, revision, readBytes, onReady]);
    if (result.error) return <View style={{ padding: 24 }}><Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive }}>{result.error}</Text></View>;
    if (!result.html) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={theme.colors.textSecondary} /></View>;
    return <View style={{ flex: 1, minHeight: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: 7, gap: 8, borderBottomWidth: 1, borderColor: theme.colors.divider }}>
            <Text style={{ flex: 1, fontSize: 11, color: theme.colors.textSecondary }}>{t(interactive ? 'fileWorkspace.runningPreview' : 'fileWorkspace.staticPreview')}</Text>
            <WorkspaceButton label={t(interactive ? 'fileWorkspace.stopInteraction' : 'fileWorkspace.runInteraction')} icon={interactive ? 'stop-outline' : 'play-outline'} onPress={() => setInteractive(value => !value)} />
        </View>
        {React.createElement('iframe', { key: interactive ? 'interactive' : 'static', title: t('fileWorkspace.preview'), sandbox: interactive ? 'allow-scripts' : '', srcDoc: result.html, referrerPolicy: 'no-referrer', style: { width: '100%', flex: 1, minHeight: 0, border: 0, background: theme.colors.surface }, 'data-testid': 'workspace-html-preview' })}
    </View>;
});
