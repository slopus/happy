import Foundation
import HappyCrypto
import HappyStore

public struct ChatHistoryFailure: Equatable, Sendable {
    public enum Operation: Equatable, Sendable { case newest, older }
    public var operation: Operation
    public var message: String
}

public struct ChatHistoryState: Equatable, Sendable {
    public var sessionId: String
    public var initialLoaded: Bool
    public var loadingNewest: Bool
    public var loadingOlder: Bool
    public var hasMore: Bool
    public var oldestSeq: Int?
    public var error: ChatHistoryFailure?
}

public struct OlderPageResult: Equatable, Sendable {
    public var advanced: Bool
    public var hasMore: Bool
    public var oldestSeq: Int? = nil
    /// An explicit failure lets the UI offer Retry instead of auto-paging
    /// again on the next scroll event while the account is offline.
    public var failureOperation: ChatHistoryFailure.Operation? = nil
    public var failed: Bool { failureOperation != nil }
}

/// Remote tail pagination. Forward gap recovery retains its own cursor and
/// remains in SyncEngine; loading/errors never enter message row equality.
public actor ChatHistory {
    // SessionMessage.seq is a Postgres int4 through Prisma Int.
    private static let newestPageUpperBound = Int(Int32.max)

    private struct Entry {
        var coverage: ChatHistoryCoverage?
        var output: ChatHistoryState?
        var failure: ChatHistoryFailure?
        var subscribers: [UUID: AsyncStream<ChatHistoryState>.Continuation] = [:]
        var observation: Task<Void, Never>?
        var epoch = UUID()
    }
    private struct Operation {
        var id: UUID
        var kind: ChatHistoryFailure.Operation
        var task: Task<OlderPageResult, Never>
    }
    private enum Failure: Error { case missingSession, unavailableKey, changedKey }
    private let api: HappyAPI
    private let store: LocalStore
    private let decoder: RecordDecoder
    private let pageSize: Int
    private var stopped = false
    private var stopping: Task<Void, Never>?
    private var entries: [String: Entry] = [:]
    private var operations: [String: Operation] = [:]
    private var olderRequests: [String: (id: UUID, task: Task<OlderPageResult, Never>)] = [:]
    private var retiring: [UUID: Task<Void, Never>] = [:]
    /// Internal probe lets tests release held HTTP only after a second caller
    /// has actually joined the request, without scheduler timing assumptions.
    private var requestCoalesced: (@Sendable (ChatHistoryFailure.Operation) -> Void)?

    func observeCoalescing(_ observer: @escaping @Sendable (ChatHistoryFailure.Operation) -> Void) {
        requestCoalesced = observer
    }

    public init(api: HappyAPI, store: LocalStore, keys: AccountKeys, pageSize: Int = 100) {
        self.api = api; self.store = store; self.decoder = RecordDecoder(keyRing: KeyRing(keys: keys))
        self.pageSize = max(1, min(pageSize, 100))
    }

    public nonisolated func snapshots(sessionId: String) -> AsyncStream<ChatHistoryState> {
        AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let id = UUID()
            let registration = Task.detached { await self.subscribe(sessionId, id, continuation) }
            continuation.onTermination = { _ in
                registration.cancel()
                Task { await self.remove(sessionId, id) }
            }
        }
    }

    public func current(sessionId: String) -> ChatHistoryState {
        if !stopped { hydrate(sessionId) }
        return state(sessionId)
    }

    public func ensureNewest(sessionId: String) async {
        _ = await newestResult(sessionId: sessionId)
    }

    private func newestResult(sessionId: String) async -> OlderPageResult {
        guard !stopped else { return .init(advanced: false, hasMore: false) }
        if let operation = operations[sessionId] {
            requestCoalesced?(.newest)
            let result = await operation.task.value
            if operation.kind == .older { return await newestResult(sessionId: sessionId) }
            return result
        }
        hydrate(sessionId)
        if let coverage = entries[sessionId]?.coverage, coverage.marker == nil, !coverage.hasMore {
            if entries[sessionId]?.failure?.operation == .newest { entries[sessionId]?.failure = nil }
            publish(sessionId)
            return .init(advanced: false, hasMore: false)
        }
        if let coverage = entries[sessionId]?.coverage, let marker = coverage.marker,
           marker.newestLoaded, marker.checkedThroughSeq >= coverage.seq {
            if entries[sessionId]?.failure?.operation == .newest { entries[sessionId]?.failure = nil }
            publish(sessionId)
            return .init(advanced: false, hasMore: coverage.hasMore, oldestSeq: marker.oldestRawSeq)
        }
        return await start(sessionId, kind: .newest).value
    }

    public func loadOlder(sessionId: String) async -> OlderPageResult {
        guard !stopped else { return .init(advanced: false, hasMore: false) }
        if let request = olderRequests[sessionId] {
            requestCoalesced?(.older)
            return await request.task.value
        }
        let id = UUID()
        let task = Task { await self.loadOlderOnce(sessionId: sessionId) }
        olderRequests[sessionId] = (id, task)
        let result = await task.value
        if olderRequests[sessionId]?.id == id { olderRequests.removeValue(forKey: sessionId) }
        return result
    }

    private func loadOlderOnce(sessionId: String) async -> OlderPageResult {
        guard !stopped else { return .init(advanced: false, hasMore: false) }
        if let operation = operations[sessionId] {
            requestCoalesced?(.older)
            let result = await operation.task.value
            if operation.kind == .older || result.failed { return result }
        }
        hydrate(sessionId)
        guard let initial = entries[sessionId]?.coverage else { return .init(advanced: false, hasMore: false) }
        if initial.marker == nil {
            guard initial.hasMore else { return .init(advanced: false, hasMore: false) }
            let newest = await newestResult(sessionId: sessionId)
            if newest.failed { return newest }
        }
        guard !stopped, let coverage = entries[sessionId]?.coverage,
              coverage.hasMore, coverage.marker?.oldestRawSeq != nil else {
            return .init(advanced: false, hasMore: entries[sessionId]?.coverage?.hasMore ?? false,
                         oldestSeq: entries[sessionId]?.coverage?.marker?.oldestRawSeq)
        }
        // Another caller may have started an older operation while newest
        // was awaited. Share that page instead of downloading a second one.
        if let operation = operations[sessionId] { return await operation.task.value }
        return await start(sessionId, kind: .older).value
    }

    /// Select the immutable failed request's operation, not current().error:
    /// another request may have cleared that scalar error meanwhile.
    @discardableResult
    public func retry(sessionId: String, operation: ChatHistoryFailure.Operation) async -> OlderPageResult {
        switch operation {
        case .newest: return await newestResult(sessionId: sessionId)
        case .older: return await loadOlder(sessionId: sessionId)
        }
    }

    public func stop() async {
        if let stopping { await stopping.value; return }
        stopped = true
        let requests = operations.values.map(\.task) + olderRequests.values.map(\.task)
        let observations = entries.values.compactMap(\.observation) + Array(retiring.values)
        let continuations = entries.values.flatMap { Array($0.subscribers.values) }
        operations.removeAll(); olderRequests.removeAll(); entries.removeAll(); retiring.removeAll()
        for continuation in continuations { continuation.finish() }
        for task in requests { task.cancel() }
        for task in observations { task.cancel() }
        let drain = Task.detached {
            for task in requests { _ = await task.value }
            for task in observations { await task.value }
        }
        stopping = drain
        await drain.value
    }

    private func start(_ sessionId: String, kind: ChatHistoryFailure.Operation) -> Task<OlderPageResult, Never> {
        let id = UUID()
        entries[sessionId]?.failure = nil
        let task = Task { await self.download(sessionId, kind: kind, id: id) }
        operations[sessionId] = Operation(id: id, kind: kind, task: task)
        publish(sessionId)
        return task
    }

    private func download(_ sessionId: String, kind: ChatHistoryFailure.Operation, id: UUID) async -> OlderPageResult {
        let oldCursor = entries[sessionId]?.coverage?.marker?.oldestRawSeq
        var succeeded = false
        var failureOperation: ChatHistoryFailure.Operation?
        do {
            let request = try { () -> (seq: Int, key: String?) in
                guard let session = try store.session(id: sessionId) else { throw Failure.missingSession }
                return (session.seq, session.dataKeyCipher)
            }()
            guard let cipher = decoder.keyRing.cipher(wrappedKey: request.key) else { throw Failure.unavailableKey }
            let before = kind == .newest ? Self.newestPageUpperBound : (oldCursor ?? 0)
            let page = try await api.messagesBefore(sessionId: sessionId, beforeSeq: before, limit: pageSize)
            try Task.checkCancellation()
            guard !stopped, operations[sessionId]?.id == id else { return .init(advanced: false, hasMore: false) }
            let currentKey = try { () -> String? in
                guard let session = try store.session(id: sessionId) else { throw Failure.missingSession }
                return session.dataKeyCipher
            }()
            guard currentKey == request.key else { throw Failure.changedKey }
            let records = page.messages.reversed().map { decoder.message($0, sessionId: sessionId, cipher: cipher) }
            let direction: ChatHistoryPage = kind == .newest ? .newest(checkedThroughSeq: request.seq) : .older(beforeSeq: before)
            let coverage = try store.applyChatHistoryPage(sessionId: sessionId, messages: records,
                                                         hasMore: page.hasMore, page: direction)
            entries[sessionId]?.coverage = coverage
            entries[sessionId]?.failure = nil
            succeeded = coverage != nil
        } catch Failure.missingSession {
            guard !stopped, operations[sessionId]?.id == id else { return .init(advanced: false, hasMore: false) }
            // Deletion retires a request; it is not an offline failure that
            // should leave the paging UI offering Retry for a dead session.
            entries[sessionId]?.coverage = nil
            entries[sessionId]?.failure = nil
        } catch {
            guard !stopped, operations[sessionId]?.id == id else { return .init(advanced: false, hasMore: false) }
            entries[sessionId]?.failure = ChatHistoryFailure(operation: kind, message: "Could not load messages. Try again.")
            failureOperation = kind
        }
        guard !stopped, operations[sessionId]?.id == id else { return .init(advanced: false, hasMore: false) }
        operations.removeValue(forKey: sessionId)
        publish(sessionId)
        let coverage = entries[sessionId]?.coverage
        let cursor = coverage?.marker?.oldestRawSeq
        return .init(advanced: succeeded && cursor != nil && cursor != oldCursor,
                     hasMore: coverage?.hasMore ?? false, oldestSeq: cursor, failureOperation: failureOperation)
    }

    private func hydrate(_ sessionId: String) {
        let coverage = try? store.chatHistoryCoverage(sessionId: sessionId)
        if entries[sessionId] == nil { entries[sessionId] = Entry(coverage: coverage) }
        else { entries[sessionId]?.coverage = coverage }
    }

    private func state(_ sessionId: String) -> ChatHistoryState {
        let coverage = entries[sessionId]?.coverage
        let kind = operations[sessionId]?.kind
        return ChatHistoryState(sessionId: sessionId,
                                initialLoaded: coverage?.isLoaded ?? false,
                                loadingNewest: kind == .newest, loadingOlder: kind == .older,
                                hasMore: coverage?.hasMore ?? false, oldestSeq: coverage?.marker?.oldestRawSeq,
                                error: entries[sessionId]?.failure)
    }

    private func publish(_ sessionId: String) {
        let next = state(sessionId)
        guard entries[sessionId]?.output != next else { return }
        entries[sessionId]?.output = next
        for continuation in entries[sessionId]?.subscribers.values ?? Dictionary<UUID, AsyncStream<ChatHistoryState>.Continuation>().values {
            continuation.yield(next)
        }
    }

    private func subscribe(_ sessionId: String, _ id: UUID, _ continuation: AsyncStream<ChatHistoryState>.Continuation) {
        guard !stopped, !Task.isCancelled else { continuation.finish(); return }
        hydrate(sessionId)
        guard !Task.isCancelled else { continuation.finish(); return }
        entries[sessionId]?.subscribers[id] = continuation
        continuation.yield(state(sessionId))
        guard entries[sessionId]?.observation == nil else { return }
        let epoch = UUID()
        entries[sessionId]?.epoch = epoch
        let store = store
        entries[sessionId]?.observation = Task { [weak self] in
            for await coverage in store.chatHistoryCoverageSnapshots(sessionId: sessionId) {
                guard !Task.isCancelled else { break }
                await self?.receive(sessionId, coverage, epoch: epoch)
            }
            await self?.observationEnded(sessionId, epoch: epoch)
        }
    }

    private func observationEnded(_ sessionId: String, epoch: UUID) {
        guard !stopped, entries[sessionId]?.epoch == epoch else { return }
        let continuations = Array(entries[sessionId]?.subscribers.values ?? Dictionary<UUID, AsyncStream<ChatHistoryState>.Continuation>().values)
        entries[sessionId]?.observation = nil
        entries[sessionId]?.subscribers.removeAll()
        for continuation in continuations { continuation.finish() }
    }

    private func receive(_ sessionId: String, _ coverage: ChatHistoryCoverage?, epoch: UUID) {
        guard !stopped, entries[sessionId]?.epoch == epoch, !Task.isCancelled else { return }
        entries[sessionId]?.coverage = coverage
        publish(sessionId)
    }

    private func remove(_ sessionId: String, _ id: UUID) {
        guard entries[sessionId]?.subscribers.removeValue(forKey: id) != nil,
              entries[sessionId]?.subscribers.isEmpty == true else { return }
        guard let task = entries[sessionId]?.observation else { return }
        entries[sessionId]?.observation = nil
        entries[sessionId]?.epoch = UUID()
        let retired = UUID()
        task.cancel()
        retiring[retired] = task
        Task { await task.value; self.retiring.removeValue(forKey: retired) }
    }
}