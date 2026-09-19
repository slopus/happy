import type { HistoryViewportReader } from '@/sync/historyWindowPolicy';
import * as React from 'react';
import { useContinuationHistory } from '@/hooks/useContinuationHistory';
import { composeContinuationItems } from './continuationTranscript';
import { transcriptViewportRange } from './transcriptViewportRange';
import { itemMessages } from './transcriptReading';
import { Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHeaderHeight } from '@/utils/responsive';
import { useSession, useSessionMessages, useSetting } from '@/sync/storage';
import { sync } from '@/sync/sync';
import type { Session } from '@/sync/storageTypes';
import { isSessionTurnActive } from '@/hooks/useGroupedMessages';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { ChatFooter } from './ChatFooter';
import { ConversationTranscript } from './ConversationTranscript';
import type { TranscriptReadingAdapter } from './transcriptReading';
import { useSessionTextPreviews } from '@/sync/sessionTextStream';
import { selectVisibleTextPreviews } from './sessionTextPreviewProjection';
import { StreamingTextPreviews } from './StreamingTextPreviews';

type ChatListProps = { session: Session; followLatestRequest?: number };
export const ChatList = React.memo((props: ChatListProps) => props.session.metadata?.continuationOfSessionId
    ? <ContinuationChatList key={props.session.id} {...props} /> : <SingleSessionChatList {...props} />);

const ContinuationChatList = React.memo((props: ChatListProps) => {
    const history = useContinuationHistory(props.session.id);
    const session = useSession(props.session.id) ?? props.session;
    const groupToolCalls = useSetting('groupToolCalls');
    const previews = useSessionTextPreviews(props.session.id);
    const { canFork, forkFromMessage, forkingFromMessageId } = useSessionQuickActions(session);
    const sections = history.sections.map(section => ({ ...section, reading: {
        key: section.id, read: () => Promise.resolve(null), save: () => {},
        wireId: (id: string) => sync.getMessageWireId(section.id, id),
        wireSeq: (id: string) => sync.getMessageWireSeq(section.id, id),
        blockKey: (id: string) => sync.getMessageWireBlockKey(section.id, id),
    } }));
    const messages = history.sections.flatMap(section => section.messages);
    const items = React.useMemo(() => composeContinuationItems(sections, props.session.id,
        groupToolCalls, isSessionTurnActive(session)), [sections, props.session.id, groupToolCalls, session]);
    return <ConversationTranscript sessionId={props.session.id} metadata={session.metadata}
        messages={messages} scopedItems={items} groupToolCalls={groupToolCalls}
        scopedViewport={(visible, direction) => {
            const section = direction === 'older' ? sections.at(-1) : sections[0];
            if (!section) return undefined;
            return transcriptViewportRange(section.messages, visible.filter(item => item.source?.sessionId === section.id).flatMap(itemMessages),
                section.reading.wireSeq, { oldestSeq: sync.getHistoryBoundarySeq(section.id, 'older'), newestSeq: sync.getHistoryBoundarySeq(section.id, 'newer') });
        }}
        showMessageActions={Platform.OS === 'web'} canEditLatestUserMessage={history.isAtLatest && !session.thinking}
        hasPendingPermission={Boolean(session.agentState?.requests && Object.keys(session.agentState.requests).length)}
        onEditUserMessage={async (id, text) => { await sync.sendMessage(session.id, text, { source: 'chat', editedFromMessageId: id }); }}
        onForkFromMessage={canFork ? (messageId, rewindPointId, messageText, retainSelectedTurn, messageCreatedAt, excludeSelectedPrompt) => {
            forkFromMessage({ messageId, rewindPointId, messageText, retainSelectedTurn, messageCreatedAt: messageCreatedAt ?? 0, excludeSelectedPrompt });
        } : undefined} forkingFromMessageId={forkingFromMessageId}
        currentTurnActive={history.isAtLatest && isSessionTurnActive(session)}
        followLatestRequest={props.followLatestRequest}
        onLoadOlder={history.loadOlder} onLoadNewer={history.loadNewer}
        hasMoreOlder={history.hasMoreOlder} hasMoreNewer={history.hasMoreNewer}
        isLoadingOlder={history.loading} isLoadingNewer={history.loading}
        olderError={history.olderError} newerError={history.newerError}
        boundaryScope={`${history.olderCursor}/${history.newerCursor}`}
        isAtLatest={history.isAtLatest} onJumpToLatest={history.jumpLatest}
        showAnchorNavigation={false} visualTop={<ListHeader />}
        visualBottom={history.isAtLatest ? <>
            <StreamingTextPreviews previews={selectVisibleTextPreviews(props.session.id, true,
                history.sections.find(section => section.id === props.session.id)?.messages ?? [], previews)} />
            <ListFooter sessionId={props.session.id} />
        </> : null} />;
});

const SingleSessionChatList = React.memo((props: ChatListProps) => {
    const { messages, isLoaded, hasMoreOlder, isLoadingOlder, hasMoreNewer, isLoadingNewer, isAtLatest,
        olderError, newerError } = useSessionMessages(props.session.id);
    const session = useSession(props.session.id);
    const textPreviews = useSessionTextPreviews(props.session.id);
    const visibleTextPreviews = React.useMemo(
        () => selectVisibleTextPreviews(props.session.id, isAtLatest, messages, textPreviews),
        [props.session.id, isAtLatest, messages, textPreviews],
    );
    const groupToolCalls = useSetting('groupToolCalls');
    const hasPendingPermission = Boolean(
        session?.agentState?.requests && Object.keys(session.agentState.requests).length > 0,
    );
    const { canFork, forkFromMessage, forkingFromMessageId } = useSessionQuickActions(session!, {});
    const handleForkFromMessage = React.useCallback((
        messageId: string,
        rewindPointId: string | undefined,
        messageText: string,
        retainSelectedTurn?: boolean,
        messageCreatedAt?: number,
        excludeSelectedPrompt?: boolean,
    ) => {
        forkFromMessage({
            messageId,
            messageText,
            messageCreatedAt: messageCreatedAt ?? 0,
            rewindPointId,
            retainSelectedTurn,
            excludeSelectedPrompt,
        });
    }, [forkFromMessage]);
    const handleEditUserMessage = React.useCallback(async (messageId: string, messageText: string) => {
        await sync.sendMessage(props.session.id, messageText, {
            source: 'chat',
            editedFromMessageId: messageId,
        });
    }, [props.session.id]);
    const handleLoadOlder = React.useCallback((viewport?: HistoryViewportReader) => {
        if (!hasMoreOlder || isLoadingOlder) return;
        void sync.loadOlderMessages(props.session.id, viewport).catch(() => undefined);
    }, [hasMoreOlder, isLoadingOlder, props.session.id]);
    const handleLoadNewer = React.useCallback((viewport?: HistoryViewportReader) => {
        if (!hasMoreNewer || isLoadingNewer) return;
        void sync.loadNewerMessages(props.session.id, viewport).catch(() => undefined);
    }, [hasMoreNewer, isLoadingNewer, props.session.id]);
    const handleJumpToLatest = React.useCallback(() => sync.jumpToLatestMessages(props.session.id), [props.session.id]);
    const history = sync.getLocalHistoryScope();
    const encryption = sync.encryption;
    const sessionEncryption = encryption?.getSessionEncryption(props.session.id);
    const reading = React.useMemo<TranscriptReadingAdapter | undefined>(() => {
        if (!history && (Platform.OS !== 'web' || !encryption)) return undefined;
        const id = props.session.id;
        const fence = history?.captureSessionFence(id);
        const current = () => sync.getLocalHistoryScope() === history && (history
            ? !!fence && history.isFenceCurrent(fence)
            : sync.encryption === encryption && encryption.getSessionEncryption(id) === sessionEncryption);
        return {
            key: JSON.stringify([history?.scope ?? 'memory', id]),
            read: async () => current() ? sync.readSessionReadingState(id) : null,
            save: async state => { if (current()) await sync.saveSessionReadingState(id, state); },
            wireId: renderedId => current() ? sync.getMessageWireId(id, renderedId) : null,
            wireSeq: renderedId => current() ? sync.getMessageWireSeq(id, renderedId) : null,
            blockKey: renderedId => current() ? sync.getMessageWireBlockKey(id, renderedId) : null,
        };
    }, [history, encryption, sessionEncryption, props.session.id]);

    return (
        <ConversationTranscript
            metadata={props.session.metadata}
            sessionId={props.session.id}
            messages={messages}
            reading={reading}
            groupToolCalls={groupToolCalls}
            currentTurnActive={isAtLatest && isSessionTurnActive(session)}
            followLatestRequest={props.followLatestRequest}
            hasPendingPermission={isAtLatest && hasPendingPermission}
            onLoadOlder={handleLoadOlder}
            olderCursor={sync.getHistoryBoundarySeq(props.session.id, 'older')}
            newerCursor={sync.getHistoryBoundarySeq(props.session.id, 'newer')}
            hasMoreOlder={hasMoreOlder || !isLoaded}
            isLoadingOlder={isLoadingOlder || !isLoaded}
            onLoadNewer={handleLoadNewer}
            onJumpToLatest={handleJumpToLatest}
            hasMoreNewer={hasMoreNewer}
            isLoadingNewer={isLoadingNewer}
            isAtLatest={isAtLatest}
            olderError={olderError}
            newerError={newerError}
            visualTop={<ListHeader />}
            visualBottom={isAtLatest ? <>
                <StreamingTextPreviews previews={visibleTextPreviews} />
                <ListFooter sessionId={props.session.id} />
            </> : null}
            showMessageActions={Platform.OS === 'web'}
            canEditLatestUserMessage={isAtLatest && session?.thinking !== true}
            onEditUserMessage={handleEditUserMessage}
            onForkFromMessage={canFork ? handleForkFromMessage : undefined}
            forkingFromMessageId={forkingFromMessageId}
        />
    );
});

const ListHeader = React.memo(() => {
    const headerHeight = useHeaderHeight();
    const safeArea = useSafeAreaInsets();
    return (
        <View>
            <View style={{ flexDirection: 'row', alignItems: 'center', height: headerHeight + safeArea.top + 32 }} />
        </View>
    );
});

const ListFooter = React.memo((props: { sessionId: string }) => {
    const session = useSession(props.sessionId)!;
    return <ChatFooter controlledByUser={session.agentState?.controlledByUser || false} />;
});
