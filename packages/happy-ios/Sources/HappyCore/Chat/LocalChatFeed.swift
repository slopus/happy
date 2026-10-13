import Foundation
import HappyStore
import HappyWire

/// Each subscriber has a reducer and insertion cursor. The store is the
/// only input, so disk produces the first snapshot without a network call.
public final class LocalChatFeed: ChatFeed {
    private let store: LocalStore

    public init(store: LocalStore) { self.store = store }

    public func snapshots(sessionId: String) -> AsyncStream<ChatSnapshot> {
        AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let task = Task {
                var state = FeedState(sessionId: sessionId)
                do {
                    // Register observation first so a write during the first
                    // disk read cannot fall between read and subscription.
                    let changes = store.chatChanges(sessionId: sessionId)
                    continuation.yield(state.apply(try store.chatPage(sessionId: sessionId)))
                    for try await change in changes {
                        if Task.isCancelled { break }
                        guard change != state.lastChange else { continue }
                        let reset = change.messageCount < state.recordCount || change.lastRowId < state.lastRowId
                        if reset { state = FeedState(sessionId: sessionId) }
                        var page = try store.chatPage(sessionId: sessionId, afterRowId: state.lastRowId)
                        if page.change.messageCount != state.recordCount + page.records.count {
                            state = FeedState(sessionId: sessionId)
                            page = try store.chatPage(sessionId: sessionId)
                        }
                        continuation.yield(state.apply(page))
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
    private(set) var normalizedRecordCount = 0

    init(sessionId: String) { self.sessionId = sessionId }

    mutating func apply(_ page: ChatStorePage) -> ChatSnapshot {
        let change = page.change
        let records = page.records.compactMap(ChatNormalizer.normalize)
        normalizedRecordCount += page.records.count
        for record in page.records { if let local = record.localId { serverLocalIds.insert(local) } }
        let metadata = change.session?.metadata
        let hold = metadata?["client"]?["id"]?.stringValue == "rig"
            && (metadata?["rigMetadataVersion"]?.numberValue ?? 0) >= 1
            && metadata?["capabilities"]?["messageReceipts"]?.boolValue == true
        _ = reducer.reduce(records, agentState: change.session?.agentState, holdUserMessagesUntilAccepted: hold)
        var messages = reducer.messages
        var delivery: [String: OutboxDelivery] = [:]
        for item in change.outbox where !serverLocalIds.contains(item.localId) {
            let normalized = ChatNormalizer.normalize(id: item.localId, localId: item.localId, createdAt: item.createdAt, raw: item.payload)
            if let normalized {
                switch normalized.body {
                case .user(let text):
                    messages.append(.userText(UserTextMessage(id: item.localId, localId: item.localId, createdAt: item.createdAt, text: text, displayText: normalized.meta?.displayText, meta: normalized.meta, pending: true, sortAt: item.createdAt + ChatMessage.pendingSortOffset)))
                default:
                    // File sends are already completed file rows once sent;
                    // before that, the normalizer still gives the UI the file.
                    var overlay = ChatReducer()
                    _ = overlay.reduce([normalized])
                    messages.append(contentsOf: overlay.messages)
                }
            }
            switch item.state {
            case .queued: delivery[item.localId] = .queued
            case .sending: delivery[item.localId] = .sending
            case .failed: delivery[item.localId] = .failed(item.lastError ?? "")
            }
        }
        // History is already sorted. Merge only the (usually tiny) overlay.
        if !delivery.isEmpty {
            messages.sort { $0.sortKey == $1.sortKey ? $0.id < $1.id : $0.sortKey < $1.sortKey }
        }
        lastRowId = change.lastRowId
        recordCount = change.messageCount
        lastChange = change
        let loaded = change.session.map { $0.syncedMessageSeq > 0 || $0.seq == 0 } ?? false
        return ChatSnapshot(sessionId: sessionId, messages: messages, delivery: delivery, isLoaded: loaded, usage: reducer.usage, todos: reducer.todos)
    }
}