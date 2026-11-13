import * as React from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, TextInput, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { DrawerActions, useIsFocused } from '@react-navigation/native';
import { useNavigation } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { MessageView } from '@/components/MessageView';
import { useDraft } from '@/hooks/useDraft';
import { sync } from '@/sync/sync';
import { machineResumeSession, machineSpawnNewSession, sessionAbort } from '@/sync/ops';
import { storage, useAllMachines, useIsDataReady, usePersonalAgentConversations, useSession, useSessionMessages, useSetting, useLocalSettingMutable } from '@/sync/storage';
import { isPersonalAgentConversation, personalAgentDisplayName, selectPersonalAgentConversation } from '@/sync/personalAgent';
import { useSessionTextPreviews } from '@/sync/sessionTextStream';
import { selectVisibleTextPreviews } from '@/components/sessionTextPreviewProjection';
import { isMachineOnline } from '@/utils/machineUtils';
import { useIsTablet } from '@/utils/responsive';
import type { Message } from '@/sync/typesMessage';
import type { SessionRouteOwner } from '@/sync/sessionRouteOwnership';
import { t } from '@/text';
import { PersonalAvatar } from './PersonalAvatar';
import { PersonalProfileDialog } from './PersonalProfileDialog';

export function PersonalAgentScreen() {
    const conversations = usePersonalAgentConversations();
    const [preferred, setPreferred] = useLocalSettingMutable('personalAgentConversationId');
    const conversationId = selectPersonalAgentConversation(conversations, preferred);
    const name = personalAgentDisplayName(useSetting('personalAgentName'));
    const avatar = useSetting('personalAgentAvatar');
    const ready = useIsDataReady();
    const machines = useAllMachines().filter(machine => machine.metadata?.cliAvailability?.personal && isMachineOnline(machine));
    const [machineId, setMachineId] = React.useState<string | null>(null);
    const [starting, setStarting] = React.useState(false);
    const startingRef = React.useRef(false);
    const [error, setError] = React.useState<string | null>(null);
    const [editing, setEditing] = React.useState(false);
    const focused = useIsFocused();
    const focusedRef = React.useRef(focused);
    focusedRef.current = focused;
    React.useEffect(() => () => { focusedRef.current = false; }, []);
    const { theme } = useUnistyles();
    const navigation = useNavigation();
    const isTablet = useIsTablet();
    const selectedMachine = machines.find(machine => machine.id === machineId) ?? machines[0];

    React.useEffect(() => {
        if (focused && ready && !preferred && conversationId) setPreferred(conversationId);
    }, [conversationId, focused, preferred, ready, setPreferred]);

    const start = async () => {
        if (startingRef.current || !selectedMachine) return;
        startingRef.current = true; setStarting(true); setError(null);
        try {
            const home = selectedMachine.metadata?.happyHomeDir;
            if (!home) throw new Error('personal-home-unavailable');
            const result = await machineSpawnNewSession({ machineId: selectedMachine.id,
                directory: `${home.replace(/[\\/]+$/, '')}/personal-agent/workspace`,
                agent: 'personal', approvedNewDirectoryCreation: true });
            if (result.type !== 'success') throw new Error('personal-start-failed');
            // Store identity before hydration: network failure must not create
            // another thread on the user's next visit.
            if (focusedRef.current) setPreferred(result.sessionId);
        } catch { if (focusedRef.current) setError(t('personalAgent.loadFailed')); }
        finally { startingRef.current = false; if (focusedRef.current) setStarting(false); }
    };

    return <View style={styles.screen} testID="personal-agent-screen">
        <View style={styles.header}>
            {!isTablet && <Pressable accessibilityRole="button" accessibilityLabel={t('personalAgent.openMenu')} onPress={() => navigation.dispatch(DrawerActions.openDrawer())} style={styles.icon}><Feather name="menu" size={21} color={theme.colors.text} /></Pressable>}
            <Pressable accessibilityRole="button" accessibilityLabel={t('personalAgent.editProfile')} onPress={() => setEditing(true)} style={styles.identity} testID="personal-header-profile">
                <PersonalAvatar uri={avatar} size={36} /><Text style={styles.title} numberOfLines={1}>{name}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={t('personalAgent.editProfile')} onPress={() => setEditing(true)} style={styles.icon}><Feather name="more-horizontal" size={21} color={theme.colors.textSecondary} /></Pressable>
        </View>
        {conversationId ? <PersonalConversation key={conversationId} id={conversationId} name={name} />
            : <View style={styles.empty}>
                <PersonalAvatar uri={avatar} size={80} />
                <Text style={styles.emptyTitle}>{t('personalAgent.emptyTitle', { name })}</Text>
                <Text style={styles.hint}>{t('personalAgent.emptyDescription')}</Text>
                {!ready || starting ? <ActivityIndicator color={theme.colors.textSecondary} /> : machines.length ? <>
                    <Text style={styles.hint}>{t('personalAgent.chooseMachine')}</Text>
                    {machines.map(machine => <Pressable key={machine.id} accessibilityRole="radio" accessibilityState={{ checked: selectedMachine?.id === machine.id }} onPress={() => setMachineId(machine.id)} style={({ pressed }) => [styles.machine, selectedMachine?.id === machine.id && styles.machineSelected, pressed && styles.pressed]}><Text style={styles.text}>{machine.metadata?.displayName || machine.metadata?.host || machine.id}</Text></Pressable>)}
                    <Pressable accessibilityRole="button" onPress={() => void start()} style={styles.primary} testID="personal-start-conversation"><Text style={styles.primaryText}>{t('personalAgent.startConversation')}</Text></Pressable>
                </> : <Text style={styles.hint}>{t('personalAgent.noMachine')}</Text>}
                {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
            </View>}
        {editing && <PersonalProfileDialog visible onClose={() => setEditing(false)} />}
    </View>;
}

function PersonalConversation({ id, name }: { id: string; name: string }) {
    const session = useSession(id);
    const { messages, isLoaded, hasMoreOlder, isLoadingOlder, isAtLatest, olderError } = useSessionMessages(id);
    const previews = useSessionTextPreviews(id);
    const visiblePreviews = selectVisibleTextPreviews(id, isAtLatest, messages, previews);
    const [resolution, setResolution] = React.useState<'loading' | 'ready' | 'error'>('loading');
    const [retry, setRetry] = React.useState(0);
    const [error, setError] = React.useState<string | null>(null);
    const [sending, setSending] = React.useState(false);
    const sendingRef = React.useRef(false);
    const [resuming, setResuming] = React.useState(false);
    const [text, setText] = React.useState(session?.draft ?? '');
    const textRef = React.useRef(text); textRef.current = text;
    const draftRestored = React.useRef(!!session);
    React.useEffect(() => {
        if (!session || draftRestored.current) return;
        draftRestored.current = true;
        if (!textRef.current && session.draft) setText(session.draft);
    }, [session]);
    const focused = useIsFocused();
    const ownerRef = React.useRef<SessionRouteOwner | null>(null);
    const { clearDraft, updateDraft } = useDraft(id, text, setText);
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const list = React.useRef<FlatList<Message>>(null);
    const following = React.useRef(true);

    React.useEffect(() => {
        if (!focused) return;
        let cancelled = false;
        const owner = sync.beginSessionRoute(id);
        ownerRef.current = owner;
        setResolution('loading'); setError(null);
        void sync.openSession(id, owner, { retry: retry > 0 }).then(async result => {
            if (cancelled || !sync.isSessionRouteOwner(owner)) return;
            if (result !== 'ready' || !isPersonalAgentConversation(storage.getState().sessions[id] ?? {})) {
                setResolution('error'); return;
            }
            if (storage.getState().sessionMessages?.[id]?.isAtLatest === false) {
                await sync.jumpToLatestMessages(id);
                if (cancelled || !sync.isSessionRouteOwner(owner)) return;
            }
            sync.promoteSessionRoute(owner);
            storage.getState().setCurrentViewingSession(id);
            void sync.sessionRouteBecameInteractive();
            setResolution('ready');
        }).catch(() => { if (!cancelled) setResolution('error'); });
        return () => {
            cancelled = true;
            if (sync.isSessionRouteOwner(owner) && storage.getState().currentViewingSessionId === id) storage.getState().setCurrentViewingSession(null);
            sync.leaveSessionRoute(owner);
            if (ownerRef.current === owner) ownerRef.current = null;
        };
    }, [focused, id, retry]);

    const isCurrent = () => !!ownerRef.current && sync.isSessionRouteOwner(ownerRef.current)
        && isPersonalAgentConversation(storage.getState().sessions[id] ?? {});
    const send = async () => {
        const submitted = textRef.current.trim();
        if (!submitted || sendingRef.current || !session?.active || resolution !== 'ready' || !isCurrent()) return;
        const submittingOwner = ownerRef.current;
        const submissionIsCurrent = () => !!submittingOwner && sync.isSessionRouteOwner(submittingOwner);
        sendingRef.current = true; setSending(true); setError(null);
        try {
            await sync.sendMessage(id, submitted, { source: 'chat', isCurrent: submissionIsCurrent });
            if (isCurrent() && textRef.current.trim() === submitted) { clearDraft(); setText(''); textRef.current = ''; }
            if (isCurrent()) { following.current = true; list.current?.scrollToOffset({ offset: 0, animated: true }); }
        } catch { if (isCurrent()) setError(t('personalAgent.sendFailed')); }
        finally { sendingRef.current = false; if (isCurrent()) setSending(false); }
    };
    const reconnect = async () => {
        if (!session?.metadata?.machineId || resuming) return;
        setResuming(true); setError(null);
        try {
            const result = await machineResumeSession({ machineId: session.metadata.machineId, sessionId: id, agent: 'personal' });
            if (result.type !== 'success' || result.sessionId !== id) throw new Error('personal-resume-failed');
            if (isCurrent()) setRetry(value => value + 1);
        } catch { if (isCurrent()) setError(t('personalAgent.loadFailed')); }
        finally { if (isCurrent()) setResuming(false); }
    };
    const chatMessages = messages.filter(message => message.kind !== 'agent-event');
    if (resolution === 'error') return <View style={styles.empty}><Text style={styles.hint}>{t('personalAgent.loadFailed')}</Text><Pressable accessibilityRole="button" onPress={() => setRetry(value => value + 1)} style={styles.machine}><Text style={styles.text}>{t('common.retry')}</Text></Pressable></View>;
    if (resolution !== 'ready' || !isLoaded || !session || !isPersonalAgentConversation(session)) return <View style={styles.empty}><ActivityIndicator color={theme.colors.textSecondary} /></View>;
    return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.conversation}>
        <FlatList ref={list} inverted data={chatMessages} keyExtractor={item => item.id}
            testID="personal-conversation-messages"
            contentContainerStyle={styles.messages}
            keyboardShouldPersistTaps="handled"
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
            onScroll={event => { following.current = event.nativeEvent.contentOffset.y < 80; }}
            scrollEventThrottle={100}
            onContentSizeChange={() => { if (following.current) list.current?.scrollToOffset({ offset: 0, animated: false }); }}
            ListFooterComponent={<>
                {(hasMoreOlder || olderError) && <Pressable accessibilityRole="button" disabled={isLoadingOlder} onPress={() => void sync.loadOlderMessages(id)} style={styles.loadOlder}><Text style={styles.hint}>{isLoadingOlder ? t('common.loading') : t('personalAgent.loadMore')}</Text></Pressable>}
                {!chatMessages.length && <View style={styles.empty}><Text style={styles.hint}>{t('personalAgent.emptyTitle', { name })}</Text></View>}
            </>}
            ListHeaderComponent={<>
                {visiblePreviews.map(preview => <View key={`${preview.turnId}:${preview.itemId}`} style={[styles.bubble, styles.assistant]}><Text selectable style={styles.text}>{preview.text}</Text></View>)}
                {session.thinking && !visiblePreviews.length && <View style={styles.thinking}><ActivityIndicator size="small" color={theme.colors.textSecondary} /><Text style={styles.hint}>{t('personalAgent.thinking')}</Text></View>}
            </>}
            renderItem={({ item, index }) => <PersonalChatMessage message={item} sessionId={id} metadata={session.metadata} showTime={!chatMessages[index + 1] || item.createdAt - chatMessages[index + 1].createdAt > 5 * 60_000} />}
        />
        <View style={[styles.composeArea, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            {!isAtLatest && <Pressable accessibilityRole="button" onPress={() => { void sync.jumpToLatestMessages(id).catch(() => setError(t('personalAgent.loadFailed'))); }} style={styles.reconnect}><Text style={styles.hint}>{t('session.scrollToBottom')}</Text></Pressable>}
            {!session.active && <Pressable accessibilityRole="button" disabled={resuming} onPress={() => void reconnect()} style={styles.reconnect} testID="personal-reconnect"><Text style={styles.hint}>{resuming ? t('personalAgent.connecting') : t('personalAgent.reconnect')}</Text></Pressable>}
            {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
            <View style={styles.composer}>
                <TextInput multiline accessibilityLabel={t('personalAgent.messagePlaceholder', { name })} placeholder={t('personalAgent.messagePlaceholder', { name })} placeholderTextColor={theme.colors.textSecondary}
                    value={text} onChangeText={value => { setText(value); updateDraft(value); }} style={styles.composeInput} testID="personal-message-input"
                    onKeyPress={event => {
                        if (Platform.OS !== 'web') return;
                        const native = event.nativeEvent as typeof event.nativeEvent & { shiftKey?: boolean; isComposing?: boolean; keyCode?: number };
                        if (native.key === 'Enter' && !native.shiftKey && !native.isComposing && native.keyCode !== 229) { event.preventDefault(); void send(); }
                    }}
                />
                {session.thinking ? <Pressable accessibilityRole="button" accessibilityLabel={t('personalAgent.stop')} onPress={() => { void sessionAbort(id).catch(() => setError(t('personalAgent.sendFailed'))); }} style={styles.send}><Feather name="square" size={16} color={theme.colors.button.composer.tint} /></Pressable>
                    : <Pressable accessibilityRole="button" accessibilityLabel={t('personalAgent.send')} disabled={!text.trim() || sending || !session.active} onPress={() => void send()} testID="personal-message-send" style={[styles.send, (!text.trim() || sending || !session.active) && styles.disabled]}><Feather name="arrow-up" size={20} color={theme.colors.button.composer.tint} /></Pressable>}
            </View>
        </View>
    </KeyboardAvoidingView>;
}

function PersonalChatMessage({ message, sessionId, metadata, showTime }: {
    message: Message; sessionId: string; metadata: React.ComponentProps<typeof MessageView>['metadata']; showTime: boolean;
}) {
    const [expanded, setExpanded] = React.useState(false);
    const user = message.kind === 'user-text';
    if (message.kind === 'agent-event') return null;
    const pending = message.kind === 'tool-call' && message.tool.permission?.status === 'pending';
    return <View testID={`personal-message-${message.id}`} style={styles.message}>
        {showTime && <Text style={styles.time}>{new Date(message.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</Text>}
        <View style={[styles.bubble, user ? styles.user : styles.assistant]} testID={user ? 'personal-user-bubble' : 'personal-assistant-bubble'}>
            {message.kind === 'user-text' ? <Text selectable style={styles.userText}>{message.displayText ?? message.text}</Text>
                : message.kind === 'agent-text' ? <MarkdownView markdown={message.text} sessionId={sessionId} />
                : <>
                    <Pressable accessibilityRole="button" accessibilityState={{ expanded: expanded || pending }} onPress={() => setExpanded(value => !value)} style={styles.toolToggle}><Text style={styles.hint}>{message.tool.description || message.tool.name}{expanded || pending ? '  −' : '  +'}</Text></Pressable>
                    {(expanded || pending) && <MessageView message={message} metadata={metadata} sessionId={sessionId} />}
                </>}
        </View>
    </View>;
}

const styles = StyleSheet.create(theme => ({
    screen: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface },
    header: { height: 72, paddingHorizontal: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider },
    identity: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 24, padding: 6, minWidth: 0, flexShrink: 1 },
    title: { fontSize: 18, fontWeight: '600', color: theme.colors.text, flexShrink: 1 },
    icon: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18 },
    conversation: { flex: 1, minHeight: 0, width: '100%', maxWidth: 1100, alignSelf: 'center' },
    messages: { flexGrow: 1, justifyContent: 'flex-end', paddingHorizontal: 24, paddingVertical: 24 },
    message: { width: '100%', marginBottom: 14 },
    bubble: { maxWidth: '84%', borderRadius: 20, paddingHorizontal: 18, paddingVertical: 12, minWidth: 0 },
    assistant: { alignSelf: 'flex-start', backgroundColor: theme.colors.surfaceHigh },
    user: { alignSelf: 'flex-end', backgroundColor: theme.colors.userMessageBackground },
    userText: { color: theme.colors.userMessageText, fontSize: 16, lineHeight: 26 },
    text: { color: theme.colors.text, fontSize: 15, lineHeight: 24 },
    time: { color: theme.colors.textSecondary, textAlign: 'center', fontSize: 12, marginVertical: 16 },
    toolToggle: { minHeight: 32, justifyContent: 'center' },
    thinking: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 16 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 16 },
    emptyTitle: { color: theme.colors.text, fontSize: 26, fontWeight: '600', textAlign: 'center' },
    hint: { color: theme.colors.textSecondary, fontSize: 14, lineHeight: 22, textAlign: 'center', maxWidth: 440 },
    composeArea: { paddingHorizontal: 24, paddingTop: 12, gap: 8 },
    composer: { backgroundColor: theme.colors.input.background, borderColor: theme.colors.divider, borderWidth: StyleSheet.hairlineWidth, borderRadius: 28, flexDirection: 'row', alignItems: 'flex-end', gap: 12, padding: 10 },
    composeInput: { flex: 1, minWidth: 0, color: theme.colors.text, fontSize: 16, lineHeight: 24, paddingHorizontal: 10, paddingVertical: 8, minHeight: 40, maxHeight: 160 },
    send: { width: 40, height: 40, borderRadius: 20, backgroundColor: theme.colors.button.composer.background, alignItems: 'center', justifyContent: 'center' },
    primary: { paddingHorizontal: 24, paddingVertical: 12, borderRadius: 20, backgroundColor: theme.colors.button.primary.background },
    primaryText: { color: theme.colors.button.primary.tint, fontSize: 15 },
    machine: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, backgroundColor: theme.colors.surface },
    machineSelected: { backgroundColor: theme.colors.surfaceSelected },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    disabled: { opacity: 0.4 },
    error: { color: theme.colors.textDestructive, fontSize: 13, textAlign: 'center' },
    reconnect: { padding: 10, alignItems: 'center' },
    loadOlder: { padding: 16, alignSelf: 'center' },
}));
