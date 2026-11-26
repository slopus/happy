import * as React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Text } from '@/components/StyledText';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { WorkspaceButton } from './WorkspaceButton';
import { readWorkspaceBytes } from './fileIO';
import { buildHtmlFilePreview } from './htmlPreviewRuntime.web';
import { readChunkedBytes } from './readChunkedBytes';

export const HtmlFilePreview = React.memo(function HtmlFilePreview({ sessionId, path, content, root, revision = 0, readBytes, onReady }: { sessionId: string; path: string; content: string; root: string; revision?: number; readBytes?: (path: string, signal?: AbortSignal) => Promise<Uint8Array>; onReady?: (ready: boolean) => void }) {
    const { theme } = useUnistyles();
    const [interactive, setInteractive] = React.useState(false);
    const frame = React.useRef<HTMLIFrameElement>(null);
    const [result, setResult] = React.useState<{ bundle?: Awaited<ReturnType<typeof buildHtmlFilePreview>>; error?: string }>({});
    React.useLayoutEffect(() => {
        const bundle = result.bundle;
        if (!interactive || !bundle || typeof window === 'undefined') return;
        let cancelled = false;
        const pending = new Set<number>();
        const receive = (event: MessageEvent) => {
            const target = frame.current?.contentWindow;
            const request = event.data;
            if (!target || event.source !== target || !request || request.type !== 'paws-preview-image-request'
                || request.channel !== bundle.channel || !Number.isSafeInteger(request.id) || request.id < 1
                || typeof request.reference !== 'string' || !request.reference || request.reference.length > 4096
                || pending.has(request.id)) return;
            const id: number = request.id;
            if (pending.size >= 256) { reply(); return; }
            pending.add(id);
            void bundle.readImage(request.reference).then(url => reply(url), () => reply());
            function reply(url?: string) {
                pending.delete(id);
                if (!cancelled && frame.current?.contentWindow === target) {
                    target!.postMessage({ type: 'paws-preview-image-response', channel: bundle!.channel, id, ...(url ? { url } : {}) }, '*');
                }
            }
        };
        window.addEventListener('message', receive);
        return () => { cancelled = true; window.removeEventListener('message', receive); };
    }, [result.bundle, interactive]);
    // A Task-provided reader survives conversation switches. Its iframe must too.
    const resourceScope = readBytes ?? sessionId;
    React.useEffect(() => {
        let cancelled = false; let cleanup: (() => void) | undefined;
        const abort = new AbortController();
        setResult({}); setInteractive(false); onReady?.(false);
        // Bound archive readers retain their original root. Normal session links
        // outside the workspace use the existing read-only RPC, scoped here to
        // the selected HTML directory for all relative dependencies.
        const external = !readBytes && !path.startsWith(root.replace(/\/+$/, '') + '/');
        const previewRoot = external ? path.slice(0, path.lastIndexOf('/')) || '/' : root;
        const read = async (file: string) => {
            if (readBytes) return readBytes(file, abort.signal);
            if (/\.(mp4|webm|mp3|wav|ogg)$/i.test(file)) {
                const { apiSocket } = await import('@/sync/apiSocket');
                return readChunkedBytes((offset, length, revision) => apiSocket.sessionRPC(sessionId, 'readFileChunk', { path: file, scopeRoot: previewRoot, offset, length, ...(revision ? { revision } : {}) }), abort.signal);
            }
            return readWorkspaceBytes(sessionId, file, undefined, external);
        };
        void buildHtmlFilePreview(content, path, previewRoot, read).then(value => {
            if (cancelled) { value.dispose(); return; }
            cleanup = value.dispose; setResult({ bundle: value }); onReady?.(true);
        }).catch(() => { if (!cancelled) setResult({ error: t('fileWorkspace.previewFailed') }); });
        return () => { cancelled = true; abort.abort(); cleanup?.(); };
    }, [resourceScope, path, content, root, revision, readBytes, onReady]);
    if (result.error) return <View style={{ padding: 24 }}><Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive }}>{result.error}</Text></View>;
    if (!result.bundle) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={theme.colors.textSecondary} /></View>;
    return <View style={{ flex: 1, minHeight: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: 7, gap: 8, borderBottomWidth: 1, borderColor: theme.colors.divider }}>
            <Text style={{ flex: 1, fontSize: 11, color: theme.colors.textSecondary }}>{t(interactive ? 'fileWorkspace.runningPreview' : 'fileWorkspace.staticPreview')}</Text>
            <WorkspaceButton label={t(interactive ? 'fileWorkspace.stopInteraction' : 'fileWorkspace.runInteraction')} icon={interactive ? 'stop-outline' : 'play-outline'} onPress={() => setInteractive(value => !value)} />
        </View>
        {React.createElement('iframe', { key: interactive ? 'interactive' : 'static', ref: frame, title: t('fileWorkspace.preview'), sandbox: interactive ? 'allow-scripts' : '', srcDoc: result.bundle.html, referrerPolicy: 'no-referrer', style: { width: '100%', flex: 1, minHeight: 0, border: 0, background: theme.colors.surface }, 'data-testid': 'workspace-html-preview' })}
    </View>;
});
