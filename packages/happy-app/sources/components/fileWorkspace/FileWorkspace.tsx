import * as React from 'react';
import { View, ScrollView, ActivityIndicator, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { useUnistyles } from 'react-native-unistyles';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { CodeEditor } from '@/components/CodeEditor';
import { Modal } from '@/modal';
import { t } from '@/text';
import { documentDirty } from './controller';
import { useFileWorkspace } from './context';
import { VersionHistoryPanel } from './VersionHistoryPanel';
import { ArtifactPreview } from './ArtifactPreview';
import { HtmlFilePreview } from './HtmlFilePreview';
import { WorkspaceButton as Button } from './WorkspaceButton';
import { documentBodyStyle, documentScrollStyle, workspaceChatMinWidth, workspaceResizeWidth } from './documentPresentation';

const language = (path: string) => ({ md: 'markdown', mdx: 'markdown', html: 'html', htm: 'html', js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx', css: 'css', json: 'json', yml: 'yaml', yaml: 'yaml', py: 'python', sh: 'bash', svg: 'xml' }[path.split('.').pop()?.toLowerCase() ?? ''] ?? null);
export function FileWorkspace({ sessionId }: { sessionId: string }) {
    const workspace = useFileWorkspace();
    const { theme } = useUnistyles();
    const [modes, setModes] = React.useState<Record<string, boolean>>({});
    const [historyPath, setHistoryPath] = React.useState<string | null>(null);
    const [workspaceWidth, setWorkspaceWidth] = React.useState(0);
    const historyExpanded = React.useRef(false);
    const [quote, setQuote] = React.useState('');
    const contentRef = React.useRef<any>(null);
    const scroll = React.useRef<Record<string, number>>({});
    const scrollView = React.useRef<ScrollView>(null);
    const path = workspace?.snapshot.active;
    const document = path ? workspace?.snapshot.documents[path] : null;
    const closeHistory = React.useCallback(() => {
        setHistoryPath(null);
        if (historyExpanded.current) { historyExpanded.current = false; workspace?.setMaximized(false); }
    }, [workspace?.setMaximized]);
    React.useEffect(() => {
        if (historyPath && historyPath !== path) { closeHistory(); return; }
        if (historyPath && workspaceWidth > 0 && workspaceWidth < 600 && workspace && !workspace.maximized) {
            historyExpanded.current = true; workspace.setMaximized(true);
        }
    }, [historyPath, path, workspaceWidth, workspace?.maximized, workspace?.setMaximized, closeHistory]);
    React.useEffect(() => { setQuote(''); const selected=globalThis.window?.getSelection(); if(selected?.anchorNode && contentRef.current?.contains?.(selected.anchorNode)) selected.removeAllRanges(); if (path) scrollView.current?.scrollTo({ y: scroll.current[path] ?? 0, animated: false }); }, [path, document?.hash]);
    if (!workspace?.enabled || !workspace.snapshot.open || !path) return null;
    const { controller, snapshot } = workspace;
    const versionState = workspace.versions.state(path);
    const currentArtifact = versionState.current;
    const cachedDraft = controller.exportDrafts()[path];
    const dirty = document ? documentDirty(document) : false;
    const previewable = /\.(md|markdown|html?|svg)$/i.test(path);
    const preview = previewable && modes[path] !== false;
    const close = (file: string) => {
        if (controller.close(file)) return;
        if (snapshot.documents[file]?.saving) return;
        Modal.alert(t('fileWorkspace.unsavedTitle'), t('fileWorkspace.unsavedMessage'), [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('fileWorkspace.discard'), style: 'destructive', onPress: () => { controller.close(file, true); } },
            ...(snapshot.documents[file]?.phase === 'ready' && !snapshot.documents[file].conflict ? [{ text: t('fileWorkspace.save'), onPress: () => { void controller.save(file).then(ok => { if (ok) controller.close(file); }); } }] : []),
        ]);
    };
    const refresh = async () => {
        if (dirty && !await Modal.confirm(t('fileWorkspace.refresh'), t('fileWorkspace.reloadConfirm'))) return;
        await controller.refresh(path, dirty);
    };
    const download = () => {
        if (!document || Platform.OS !== 'web') return;
        const url = URL.createObjectURL(new Blob([document.phase === 'ready' ? document.draft : cachedDraft?.draft ?? ''], { type: 'text/plain;charset=utf-8' }));
        const anchor = globalThis.document.createElement('a'); anchor.href = url; anchor.download = path.split('/').pop() ?? 'file'; anchor.click(); URL.revokeObjectURL(url);
    };
    return <View testID="file-workspace" onLayout={event => setWorkspaceWidth(Math.round(event.nativeEvent.layout.width))} style={{ flex: 1, minWidth: 0, paddingTop: workspace.maximized ? 52 : 0, borderLeftWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface, borderRadius: 12, overflow: 'hidden' }} {...({ onKeyDown: (event: any) => { if (historyPath === path) return; if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); void controller.save(path); } } } as any)}>
        <View style={{flex:1,minHeight:0}} {...(historyPath === path ? {"aria-hidden":true,inert:true} : {}) as any}>
        <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 46, borderBottomWidth: 1, borderColor: theme.colors.divider }}>
            <ScrollView horizontal style={{ flex: 1, minWidth: 0 }} contentContainerStyle={{ alignItems: 'center', paddingHorizontal: 6 }}>
                {snapshot.tabs.map(file => <View key={file} style={{ flexDirection: 'row', alignItems: 'center', borderRadius: 7, backgroundColor: file === path ? theme.colors.surfaceSelected : 'transparent' }}>
                    <Button label={(file.split('/').pop() ?? file) + (documentDirty(snapshot.documents[file]) ? ' •' : '')} onPress={() => { void controller.open(file); }} selected={file === path} />
                    <Button label={`${t('fileWorkspace.closeTab')}: ${file}`} icon="close-outline" compact disabled={snapshot.documents[file]?.saving} onPress={() => close(file)} />
                </View>)}
            </ScrollView>
            {/\.(md|markdown|html?)$/i.test(path) && <Button label={t('fileWorkspace.history')} icon="time-outline" compact={workspaceWidth > 0 && workspaceWidth < 400} testID="workspace-history-open" onPress={() => setHistoryPath(path)} />}
            <Button label={workspace.maximized ? t('fileWorkspace.restore') : t('fileWorkspace.maximize')} icon={workspace.maximized ? 'contract-outline' : 'expand-outline'} compact onPress={() => workspace.setMaximized(!workspace.maximized)} />
            <Button label={t('fileWorkspace.close')} icon="close-outline" compact onPress={() => controller.setOpen(false)} />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: 8, gap: 4, borderBottomWidth: 1, borderColor: theme.colors.divider, flexWrap: 'wrap' }}>
            <Text numberOfLines={1} selectable style={{ flexGrow: 1, flexShrink: 1, fontSize: 12, color: theme.colors.textSecondary }}>{path.startsWith(workspace.root + '/') ? path.slice(workspace.root.length + 1).replaceAll('/', ' / ') : path}</Text>
            {previewable && <Button label={t('fileWorkspace.preview')} selected={preview} onPress={() => setModes(value => ({ ...value, [path]: true }))} />}
            <Button label={t('fileWorkspace.code')} selected={!preview} onPress={() => setModes(value => ({ ...value, [path]: false }))} />
            <Button label={t('fileWorkspace.refresh')} icon="refresh-outline" compact onPress={() => { void refresh(); }} disabled={document?.saving} />
            <Button label={t('fileWorkspace.mention')} icon="at-outline" compact disabled={document?.phase !== 'ready' || dirty || !document.hash} onPress={() => { if (document?.hash) workspace.setReference({ path, hash: document.hash, ...(quote ? { quote } : {}), ...(currentArtifact ? {artifact:{workspaceId:currentArtifact.artifact.workspaceId,artifactId:currentArtifact.artifact.id,expectedRevision:currentArtifact.workingRevision,...(currentArtifact.readRef.kind === 'version' ? {versionId:currentArtifact.readRef.versionId}: {})}} : {}) }); }} />
            <Button label={t('fileWorkspace.download')} icon="download-outline" compact onPress={download} disabled={document?.phase !== 'ready' && !cachedDraft} />
            <Button label={document?.saving ? t('common.loading') : t('fileWorkspace.save')} icon="save-outline" testID="workspace-save" onPress={() => { void controller.save(path); }} disabled={!dirty || document?.saving || document?.conflict} />
        </View>
        {workspace.draftCacheError && <Text accessibilityRole="alert" style={{ padding: 10, color: theme.colors.textDestructive }}>{t('fileWorkspace.draftCacheUnavailable')}</Text>}
        {document?.conflict && <View style={{ padding: 10, backgroundColor: theme.colors.surfaceSelected }}><Text accessibilityRole="alert" style={{ color: theme.colors.textDestructive }}>{t('fileWorkspace.conflict')}</Text><Button label={t('fileWorkspace.refresh')} onPress={() => { void refresh(); }} /></View>}
        {document?.error && <Text accessibilityRole="alert" style={{ padding: 12, color: theme.colors.textDestructive }}>{document.error}</Text>}
        {document?.phase === 'error' && cachedDraft && <ScrollView contentContainerStyle={{ padding: 16 }}><Text style={{ color: theme.colors.textSecondary }}>{t('fileWorkspace.cachedDraft')}</Text><Text selectable style={{ color: theme.colors.text }}>{cachedDraft.draft}</Text></ScrollView>}
        {!document || document.phase === 'loading' ? <ActivityIndicator style={{ padding: 30 }} color={theme.colors.textSecondary} /> : document.phase === 'ready' ? <>
            {preview && currentArtifact && !dirty ? <ArtifactPreview sessionId={sessionId} versions={workspace.versions} value={currentArtifact}/> : preview && /\.(html?|svg)$/i.test(path) ? <HtmlFilePreview key={path} sessionId={sessionId} path={path} content={document.draft} root={workspace.root} revision={document.revision} /> :
                <ScrollView ref={scrollView} onScroll={event => { scroll.current[path] = event.nativeEvent.contentOffset.y; }} scrollEventThrottle={100} style={{ flex: 1 }} contentContainerStyle={preview ? documentScrollStyle : { padding: 12 }}>
                    <View ref={contentRef} testID={preview ? "workspace-document-body" : undefined} style={preview ? documentBodyStyle : undefined} {...({ onMouseUp: () => {
                        const selected = globalThis.window?.getSelection();
                        if (selected?.anchorNode && contentRef.current?.contains?.(selected.anchorNode)) setQuote(selected.toString().slice(0, 4000));
                    }, onKeyUp: () => {
                        const selected = globalThis.window?.getSelection();
                        if (selected?.anchorNode && contentRef.current?.contains?.(selected.anchorNode)) setQuote(selected.toString().slice(0, 4000));
                    } } as any)}>
                        {preview ? <MarkdownView markdown={document.draft} typography="document" readOnly sessionId={sessionId} /> : <CodeEditor value={document.draft} onChange={value => controller.edit(path, value)} language={language(path)} darkMode={theme.dark} />}
                    </View>
                </ScrollView>}
            <Text style={{ fontSize: 11, padding: 7, color: theme.colors.textSecondary, borderTopWidth: 1, borderColor: theme.colors.divider }}>{dirty ? t('fileWorkspace.dirty') : t('fileWorkspace.saved')}</Text>
        </> : null}
        </View>
        {historyPath === path && <VersionHistoryPanel key={path} path={path} sessionId={sessionId} onClose={() => {closeHistory(); queueMicrotask(() => globalThis.document?.querySelector<HTMLElement>('[data-testid="workspace-history-open"]')?.focus());}}/>}
    </View>;
}

export function FileWorkspaceResizeHandle({ width, maximumWidth }: { width: number; maximumWidth: number }) {
    const workspace = useFileWorkspace();
    const { theme } = useUnistyles();
    const start = React.useRef<{ x: number; width: number; pointerId: number } | null>(null);
    if (!workspace || Platform.OS !== 'web') return null;
    const resize = (value: number) => workspace.setChatWidth(Math.max(workspaceChatMinWidth, Math.min(maximumWidth, value)));
    return React.createElement('div', {
        role: 'separator', tabIndex: 0, 'aria-label': t('fileWorkspace.resize'), 'aria-orientation': 'vertical',
        'aria-valuemin': workspaceChatMinWidth, 'aria-valuemax': maximumWidth, 'aria-valuenow': width,
        onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
            event.preventDefault();
            const renderedWidth = event.currentTarget.previousElementSibling?.getBoundingClientRect().width ?? width;
            start.current = { x: event.clientX, width: renderedWidth, pointerId: event.pointerId };
            event.currentTarget.setPointerCapture(event.pointerId);
        },
        onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
            const active = start.current;
            if (active?.pointerId === event.pointerId) resize(active.width + event.clientX - active.x);
        },
        onPointerUp: () => { start.current = null; },
        onPointerCancel: () => { start.current = null; },
        onLostPointerCapture: () => { start.current = null; },
        onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                resize(event.key === 'Home' ? workspaceChatMinWidth : event.key === 'End' ? maximumWidth : width + (event.key === 'ArrowLeft' ? -16 : 16));
            }
        },
        style: { flexShrink: 0, width: workspaceResizeWidth, background: theme.colors.divider, cursor: 'col-resize', touchAction: 'none' },
    });
}
