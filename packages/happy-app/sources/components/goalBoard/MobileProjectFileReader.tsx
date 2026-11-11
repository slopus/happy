import * as React from 'react';
import { ActivityIndicator, Platform, ScrollView, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useFileWorkspace } from '@/components/fileWorkspace/context';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { GoalHtmlPreview } from '@/components/GoalHtmlPreview';
import { HtmlFilePreview } from '@/components/fileWorkspace/HtmlFilePreview';
import { WorkspaceMediaPreview } from '@/components/fileWorkspace/WorkspaceMediaPreview';
import { encodeBase64 } from '@/encryption/base64';
import { getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { t } from '@/text';
import { GoalBoardButton as Button } from './GoalBoardButton';

// Reading position belongs to the Task/file revision, never the selected conversation.
const positions = new Map<string, number>();

/** A touch reader; desktop editing, browser download and DOM selection stay in FileWorkspace. */
export function MobileProjectFileReader({ path, scope, footer }: { path: string; scope: string; footer?: (readable: boolean) => React.ReactNode }) {
    const workspace = useFileWorkspace()!;
    const { theme } = useUnistyles();
    const [source, setSource] = React.useState(false);
    const scroll = React.useRef<ScrollView>(null);
    const document = workspace.snapshot.documents[path];
    const account = getRuntimeAccountSelection();
    const positionKey = JSON.stringify([account?.key, account?.generation, account?.serverUrl, scope, workspace.root, path, document?.fileRevision]);
    React.useEffect(() => { void workspace.openReference(path); }, [path, workspace.openReference]);
    const restore = () => scroll.current?.scrollTo({ y: positions.get(positionKey) ?? 0, animated: false });
    const markdown = /\.(md|markdown)$/i.test(path);
    const html = /\.(html?|svg)$/i.test(path);
    const mediaUri = React.useMemo(() => document?.media?.mime.startsWith('image/') ? `data:${document.media.mime};base64,${encodeBase64(document.media.bytes)}` : undefined, [document?.media]);
    return <View style={styles.reader} testID="project-mobile-reader">
        <View style={styles.toolbar}>
            <Text numberOfLines={1} style={styles.name}>{path.slice(workspace.root.length + 1)}</Text>
            {(markdown || html) && <Button variant="toolbar" label={t(source ? 'goalBoard.artifactPreview' : 'goalBoard.artifactSource')} onPress={() => setSource(value => !value)}><Text style={styles.link}>{t(source ? 'goalBoard.artifactPreview' : 'goalBoard.artifactSource')}</Text></Button>}
        </View>
        {document?.error && <View style={styles.error}><Text accessibilityRole="alert" style={styles.errorText}>{document.error}</Text><Button label={t('common.retry')} onPress={() => { void workspace.controller.refresh(path); }}><Text style={styles.link}>{t('common.retry')}</Text></Button></View>}
        {!document || document.phase === 'loading' ? <ActivityIndicator style={{ padding: 24 }} color={theme.colors.textSecondary} /> : document.phase === 'ready' ?
            document.media ? (Platform.OS === 'web' ? <WorkspaceMediaPreview media={document.media} name={path.split('/').pop() ?? path} /> : mediaUri ? <Image source={{ uri: mediaUri }} style={{ flex: 1, width: '100%' }} contentFit="contain" accessibilityLabel={path.split('/').pop()} /> : <Text style={styles.text}>{t('goalBoard.artifactUnsupported')}</Text>) :
            html && !source ? (Platform.OS === 'web' ? <HtmlFilePreview sessionId={workspace.sessionId} path={path} content={document.content} root={workspace.root} revision={document.revision} readBytes={workspace.readBytes} /> : <GoalHtmlPreview content={document.content} title={path.split('/').pop() ?? path} />) :
                <ScrollView ref={scroll} onContentSizeChange={restore} onScroll={event => {
                    positions.set(positionKey, event.nativeEvent.contentOffset.y);
                    if (positions.size > 150) positions.delete(positions.keys().next().value!);
                }} scrollEventThrottle={100} style={{ flex: 1 }} contentContainerStyle={styles.content}>
                    {markdown && !source ? <MarkdownView markdown={document.content} sessionId={workspace.sessionId} readOnly typography="document" /> : <Text selectable style={styles.text}>{document.content}</Text>}
                </ScrollView> : null}
        {footer && <View style={styles.footer}>{footer(document?.phase === 'ready' && (!document.media || !!mediaUri || Platform.OS === 'web'))}</View>}
    </View>;
}

const styles = StyleSheet.create(theme => ({
    reader: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface },
    toolbar: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    name: { flex: 1, fontSize: 13, color: theme.colors.textSecondary },
    link: { color: theme.colors.textLink, fontSize: 14 },
    content: { padding: 16 }, text: { color: theme.colors.text, fontSize: 15, lineHeight: 24 },
    error: { padding: 16, gap: 8 }, errorText: { color: theme.colors.textDestructive },
    footer: { padding: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
}));
