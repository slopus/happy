import Foundation
import HappyStore
import HappyWire

/// Each subscriber has a reducer and insertion cursor. The store is the
/// only input, so disk produces the first snapshot without a network call.
public final class LocalChatFeed: ChatFeed {
    private let store: LocalStore

    /// Reads one account's local store without owning its sync lifecycle.
    public init(store: LocalStore) { self.store = store }

    /// Yields disk immediately, then only visible chat changes. Terminating
    /// the stream cancels its database observation and releases the reducer.
    public func snapshots(sessionId: String) -> AsyncStream<ChatSnapshot> {
        AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let task = Task {
                var state = FeedState(sessionId: sessionId)
                do {
                    // Register observation first so a write during the first
                    // disk read cannot fall between read and subscription.
                    let changes = store.chatChanges(sessionId: sessionId)
                    var lastSnapshot = state.apply(try store.chatPage(sessionId: sessionId))
                    continuation.yield(lastSnapshot)
                    for try await change in changes {
                        if Task.isCancelled {
                            break
                        }
                        guard change != state.lastChange else {
                            continue
                        }
                        var page = try store.chatPage(sessionId: sessionId, afterRowId: state.lastRowId)
                        // The transactional page can be newer than the
                        // observation hint. Reset from its actual boundary.
                        let discarded = state.discardsRecords(for: page.change)
                        let reset = discarded ||
                            page.change.messageCount < state.recordCount || page.change.lastRowId < state.lastRowId
                        if reset {
                            state.reset(windowDiscarded: discarded)
                            page = try store.chatPage(sessionId: sessionId)
                        }
                        if page.change.messageCount != state.recordCount + page.records.count {
                            state.reset(windowDiscarded: false)
                            page = try store.chatPage(sessionId: sessionId)
                        }
                        let snapshot = state.apply(page)
                        if snapshot != lastSnapshot {
                            continuation.yield(snapshot)
                            lastSnapshot = snapshot
                        }
                    }
                } catch {
                    // ChatFeed's stream is nonthrowing. Keep the last disk
                    // snapshot visible when observation ends with an error.
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// Kept separate from observation to exercise incremental work without wall
/// clock assertions. Outbox rows are an overlay: discard removes one without
/// resetting the history reducer or losing an acceptance join.
struct FeedState: Sendable {
    let sessionId: String
    var reducer = ChatReducer()
    var lastRowId: Int64 = 0
    var recordCount = 0
    var lastChange: ChatStoreChange?
    private var serverLocalIds: Set<String> = []
    private var minimumServerSeq: Int?
    private(set) var windowEpoch = 0
    private(set) var normalizedRecordCount = 0

    init(sessionId: String) { self.sessionId = sessionId }

    func discardsRecords(for change: ChatStoreChange) -> Bool {
        guard let lower = change.lowerSeqExclusive, let minimumServerSeq else { return false }
        return minimumServerSeq <= lower
    }

    mutating func reset(windowDiscarded: Bool) {
        let epoch = windowEpoch + (windowDiscarded ? 1 : 0)
        self = FeedState(sessionId: sessionId)
        windowEpoch = epoch
    }

    mutating func apply(_ page: ChatStorePage) -> ChatSnapshot {
        ThreadRules.assertOffMain()
        let change = page.change
        let records = page.records.compactMap(ChatNormalizer.normalize)
        normalizedRecordCount += page.records.count
        for record in page.records {
            if record.seq > 0 { minimumServerSeq = min(minimumServerSeq ?? record.seq, record.seq) }
            if let local = record.localId {
                serverLocalIds.insert(local)
            }
        }
        let metadata = change.session?.metadata
        let hold = SessionMetadata.sendsMessageReceipts(metadata)
        _ = reducer.reduce(
            records, agentState: change.session?.agentState, holdUserMessagesUntilAccepted: hold)
        var messages = reducer.messages
        var overlayMessages: [ChatMessage] = []
        var delivery: [String: OutboxDelivery] = [:]
        for item in change.outbox where !serverLocalIds.contains(item.localId) {
            let normalized = ChatNormalizer.normalize(
                id: item.localId, localId: item.localId, createdAt: item.createdAt, raw: item.payload)
            if let normalized {
                switch normalized.body {
                case .user(let text):
                    overlayMessages.append(
                        .userText(
                            UserTextMessage(
                                id: item.localId, localId: item.localId, createdAt: item.createdAt,
                                text: text, displayText: normalized.meta?.displayText, meta: normalized.meta,
                                pending: true, sortAt: ChatMessage.pendingSortKey(item.createdAt))))
                default:
                    // File sends are already completed file rows once sent;
                    // before that, the normalizer still gives the UI the file.
                    var overlay = ChatReducer()
                    _ = overlay.reduce([normalized])
                    overlayMessages.append(contentsOf: overlay.messages)
                }
            }
            switch item.state {
            case .queued: delivery[item.localId] = .queued
            case .sending: delivery[item.localId] = .sending
            case .failed: delivery[item.localId] = .failed(item.lastError ?? "")
            }
        }
        // History is already sorted. Sort only the (usually tiny) overlay,
        // then merge in linear time, including attachments amongst history.
        if !overlayMessages.isEmpty {
            func before(_ a: ChatMessage, _ b: ChatMessage) -> Bool {
                a.sortKey == b.sortKey ? a.id < b.id : a.sortKey < b.sortKey
            }
            overlayMessages.sort(by: before)
            var merged: [ChatMessage] = []
            merged.reserveCapacity(messages.count + overlayMessages.count)
            var index = 0
            for overlay in overlayMessages {
                while index < messages.count && before(messages[index], overlay) {
                    merged.append(messages[index])
                    index += 1
                }
                merged.append(overlay)
            }
            merged.append(contentsOf: messages[index...])
            messages = merged
        }
        lastRowId = change.lastRowId
        recordCount = change.messageCount
        lastChange = change
        let loaded = change.session?.isLoaded ?? false
        return ChatSnapshot(
            sessionId: sessionId, messages: messages, delivery: delivery, isLoaded: loaded,
            usage: reducer.usage, todos: reducer.todos, hasMoreOlder: change.hasMoreOlder,
            olderBoundary: change.olderBoundary, windowEpoch: windowEpoch)
    }
}
