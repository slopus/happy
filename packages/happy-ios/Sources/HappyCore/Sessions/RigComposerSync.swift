import Foundation
import HappyStore
import HappyWire

/// rigComposer.ts, owned once by each account. Local edits are synchronous so
/// OutboxSender's composer API stays independent of the harness and network.
public final class RigComposerSync: Sendable {
    private let store: LocalStore
    private let now: @Sendable () -> Int64
    private let editLock = NSLock()
    private let writer: Writer
    private let commands: AsyncStream<Command>.Continuation
    private let commandPump: Task<Void, Never>

    private enum Command: Sendable {
        case schedule(String, Duration, Double)
        case configure(any MetadataUpdateTransport, CheckedContinuation<Void, Never>)
        case flush(String, CheckedContinuation<Void, any Error>)
        case flushAhead(CheckedContinuation<Void, Never>)
        case connected(Bool, CheckedContinuation<Void, Never>)
    }

    public init(store: LocalStore, keyRing: KeyRing, now: @escaping @Sendable () -> Int64,
                sleep: @escaping InvalidateSync.Sleep = InvalidateSync.taskSleep) {
        self.store = store
        self.now = now
        let writer = Writer(store: store, keyRing: keyRing, sleep: sleep)
        let (stream, continuation) = AsyncStream<Command>.makeStream()
        self.writer = writer
        self.commands = continuation
        self.commandPump = Task { await writer.consume(stream) }
    }

    deinit { commands.finish() }

    /// Supplies the account's versioned metadata acknowledgements.
    public func configure(transport: any MetadataUpdateTransport) async {
        await withCheckedContinuation { continuation in
            if case .terminated = commands.yield(.configure(transport, continuation)) { continuation.resume() }
        }
    }

    /// Ports rigComposerSetText: 250ms debounce, empty text written immediately.
    public func setText(sessionId: String, text: String) throws {
        try editLock.withLock {
            guard let session = try store.session(id: sessionId), session.isRigV1 else { return }
            let existing = try store.draft(sessionId: sessionId)?.text ?? ""
            if existing == text { return }
            try edit(session: session, text: text, changes: [:], clear: false)
            if let stamp = try store.composerState(sessionId: sessionId).values["draftUpdatedAt"]?.numberValue {
                commands.yield(.schedule(sessionId, text.isEmpty ? .zero : .milliseconds(250), stamp))
            }
        }
    }

    /// Ports rigComposerSetMode: writes all picks together with the current text.
    public func setModes(sessionId: String, changes: [String: JSONValue], transport: any MetadataUpdateTransport) async throws {
        await configure(transport: transport)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            do {
                try editLock.withLock {
                    guard let session = try store.session(id: sessionId), session.isRigV1 else {
                        continuation.resume(throwing: SessionActionError.notDecryptable)
                        return
                    }
                    let text = try store.draft(sessionId: sessionId)?.text ?? ""
                    try edit(session: session, text: text, changes: changes, clear: false)
                    enqueueFlush(sessionId, continuation: continuation)
                }
            } catch { continuation.resume(throwing: error) }
        }
    }

    /// Ports rigComposerClear: clears text under a fresh stamp, retaining picks.
    public func clear(sessionId: String) throws {
        try clear(sessionId: sessionId, expectedStamp: nil, conditional: false)
    }

    /// Acceptance must not erase writing that started while the send was awaiting.
    func clearAfterSend(sessionId: String, expectedStamp: JSONValue?) throws {
        try clear(sessionId: sessionId, expectedStamp: expectedStamp, conditional: true)
    }

    private func clear(sessionId: String, expectedStamp: JSONValue?, conditional: Bool) throws {
        try editLock.withLock {
            guard let session = try store.session(id: sessionId), session.isRigV1 else { return }
            let values = try store.composerState(sessionId: sessionId).values
            guard !conditional || values["draftUpdatedAt"] == expectedStamp,
                  values["draftIsNull"] != .bool(true) else { return }
            if values["draftIsNull"] == nil, try store.draft(sessionId: sessionId) == nil,
               session.metadata?["draft"]?.objectValue == nil { return }
            try edit(session: session, text: nil, changes: [:], clear: true)
            if let stamp = try store.composerState(sessionId: sessionId).values["draftUpdatedAt"]?.numberValue {
                commands.yield(.schedule(sessionId, .zero, stamp))
            }
        }
    }

    /// Ports rigComposerFlushPending; bypasses any text debounce.
    public func flushPending(sessionId: String) async throws {
        try await withCheckedThrowingContinuation { enqueueFlush(sessionId, continuation: $0) }
    }

    private func enqueueFlush(_ id: String, continuation: CheckedContinuation<Void, any Error>) {
        if case .terminated = commands.yield(.flush(id, continuation)) {
            continuation.resume(throwing: CancellationError())
        }
    }

    /// Ports rigComposerFlushAheadSessions on foreground/reconnect.
    public func flushAheadSessions() async {
        await withCheckedContinuation { continuation in
            if case .terminated = commands.yield(.flushAhead(continuation)) { continuation.resume() }
        }
    }

    /// Retries only while connected; reconnect replays local drafts still ahead.
    public func setConnected(_ value: Bool) async {
        await withCheckedContinuation { continuation in
            if case .terminated = commands.yield(.connected(value, continuation)) { continuation.resume() }
        }
    }

    /// Cancels this account's timers and writers on switch/sign-out.
    public func stop() async {
        commands.finish()
        await commandPump.value
        await writer.stop()
    }

    private func edit(session: SessionRecord, text: String?, changes: [String: JSONValue], clear: Bool) throws {
        var composer = try store.composerState(sessionId: session.id)
        var values = composer.values.objectValue ?? [:]
        values.merge(changes) { _, value in value }
        let seen = max(values["draftUpdatedAt"]?.numberValue ?? 0, session.metadata?["draftUpdatedAt"]?.numberValue ?? 0)
        let stamp = max(Double(now()), seen + 1)
        values["draftUpdatedAt"] = .number(stamp)
        values["draftIsNull"] = .bool(clear)
        if changes["modelMode"] != nil || changes["effortLevel"] == .null {
            let draft = RigDraftBuilder.compose(metadata: session.metadata ?? .object([:]), composer: .object(values), text: text)
            values["effortLevel"] = draft["effort"]?.stringValue?.isEmpty == false ? draft["effort"] : .null
            values["serviceTier"] = draft["serviceTier"]
        }
        composer.values = .object(values)
        try store.saveRigComposer(composer, text: text, at: now())
    }

    private actor Writer {
        struct State {
            var running: Task<Void, Never>?
            var timer: Task<Void, Never>?
            var timerID: UUID?
            var dirty = false
            var retryMs = 1000
            var scheduledStamp: Double?
            var waiters: [CheckedContinuation<Void, any Error>] = []
        }

        let store: LocalStore
        let keyRing: KeyRing
        let sleep: InvalidateSync.Sleep
        var transport: (any MetadataUpdateTransport)?
        var states: [String: State] = [:]
        var connected = false
        var stopped = false

        init(store: LocalStore, keyRing: KeyRing, sleep: @escaping InvalidateSync.Sleep) {
            self.store = store
            self.keyRing = keyRing
            self.sleep = sleep
        }

        /// One consumer orders every edit and barrier; it never waits for an RPC.
        func consume(_ stream: AsyncStream<Command>) async {
            for await command in stream {
                switch command {
                case .schedule(let id, let delay, let stamp):
                    schedule(id, delay: delay, stamp: stamp)
                case .configure(let transport, let continuation):
                    self.transport = transport
                    continuation.resume()
                case .flush(let id, let continuation):
                    schedule(id, delay: .zero)
                    states[id, default: State()].waiters.append(continuation)
                case .flushAhead(let continuation):
                    flushAhead()
                    continuation.resume()
                case .connected(let value, let continuation):
                    if setConnected(value), value { flushAhead() }
                    continuation.resume()
                }
            }
        }

        func flushAhead() {
            guard let sessions = try? store.sessions() else { return }
            for session in sessions where session.isRigV1 {
                guard let local = try? store.composerState(sessionId: session.id).values["draftUpdatedAt"]?.numberValue,
                      local > (session.metadata?["draftUpdatedAt"]?.numberValue ?? -1) else { continue }
                schedule(session.id, delay: .zero)
            }
        }

        func setConnected(_ connected: Bool) -> Bool {
            let changed = self.connected != connected
            self.connected = connected
            if !connected {
                for id in Array(states.keys) {
                    states[id]?.timer?.cancel()
                    states[id]?.timer = nil
                    states[id]?.timerID = nil
                }
            }
            return changed
        }

        func schedule(_ id: String, delay: Duration, retry: Bool = false, stamp: Double? = nil) {
            guard !stopped else { return }
            if states[id] == nil { states[id] = State() }
            if let stamp {
                if let scheduled = states[id]?.scheduledStamp, stamp <= scheduled { return }
                states[id]?.scheduledStamp = stamp
            } else if let current = try? store.composerState(sessionId: id).values["draftUpdatedAt"]?.numberValue {
                let scheduled = states[id]?.scheduledStamp ?? current
                states[id]?.scheduledStamp = max(scheduled, current)
            }
            states[id]?.timer?.cancel()
            states[id]?.timer = nil
            states[id]?.timerID = nil
            if delay == .zero {
                start(id)
            } else {
                let sleep = self.sleep
                let timerID = UUID()
                states[id]?.timerID = timerID
                states[id]?.timer = Task { [weak self] in
                    do { try await sleep(delay) } catch { return }
                    guard !Task.isCancelled else { return }
                    await self?.timerFired(id, retry: retry, timerID: timerID)
                }
            }
        }

        func timerFired(_ id: String, retry: Bool, timerID: UUID) {
            guard states[id]?.timerID == timerID else { return }
            states[id]?.timer = nil
            states[id]?.timerID = nil
            if retry {
                guard connected, let session = try? store.session(id: id), session.isRigV1,
                      let local = try? store.composerState(sessionId: id).values["draftUpdatedAt"]?.numberValue,
                      local > (session.metadata?["draftUpdatedAt"]?.numberValue ?? -1) else { return }
            }
            start(id)
        }

        func start(_ id: String) {
            guard !stopped else { return }
            if states[id]?.running != nil {
                states[id]?.dirty = true
                return
            }
            states[id, default: State()].dirty = false
            states[id]?.running = Task { [weak self] in
                guard let self else { return }
                do {
                    try await self.write(id)
                    await self.finished(id, error: nil)
                } catch {
                    await self.finished(id, error: error)
                }
            }
        }

        func finished(_ id: String, error: (any Error)?) {
            states[id]?.running = nil
            guard !stopped else { return }
            if error == nil { states[id]?.retryMs = 1000 }
            if states[id]?.dirty == true {
                start(id)
                return
            }
            let waiters = states[id]?.waiters ?? []
            states[id]?.waiters = []
            for waiter in waiters {
                if let error { waiter.resume(throwing: error) } else { waiter.resume() }
            }
            if error != nil, connected, states[id]?.timer == nil {
                let delay = states[id]?.retryMs ?? 1000
                states[id]?.retryMs = min(30000, delay * 2)
                schedule(id, delay: .milliseconds(delay), retry: true)
            }
        }

        func stop() async {
            stopped = true
            let tasks = states.values.compactMap(\.running)
            for state in states.values {
                state.timer?.cancel()
                state.running?.cancel()
                for waiter in state.waiters { waiter.resume(throwing: CancellationError()) }
            }
            states.removeAll()
            for task in tasks { await task.value }
        }

        func write(_ id: String) async throws {
            guard let transport, let first = try store.session(id: id), first.isRigV1,
                  let cipher = keyRing.cipher(wrappedKey: first.dataKeyCipher),
                  var base = first.metadata?.objectValue else { throw SessionActionError.notDecryptable }
            var version = first.metadataVersion
            for _ in 0..<3 {
                try Task.checkCancellation()
                guard let session = try store.session(id: id), session.isRigV1 else { return }
                let composer = try store.composerState(sessionId: id)
                let stamp = composer.values["draftUpdatedAt"] ?? .null
                let draft: JSONValue = composer.values["draftIsNull"]?.boolValue == true ? .null
                    : RigDraftBuilder.compose(metadata: session.metadata ?? .object([:]), composer: composer.values,
                                              text: try store.draft(sessionId: id)?.text ?? "")
                base["draft"] = draft
                base["draftUpdatedAt"] = stamp
                let result = try await transport.updateMetadata(event: "update-metadata", payload: .object([
                    "sid": .string(id), "metadata": .string(try cipher.encrypt(.object(base))),
                    "expectedVersion": .number(Double(version)),
                ]))
                try Task.checkCancellation()
                if result["result"]?.stringValue == "success", result["metadata"] == nil { return }
                guard ["success", "version-mismatch"].contains(result["result"]?.stringValue ?? ""),
                      let encrypted = result["metadata"]?.stringValue,
                      let latest = cipher.decrypt(base64: encrypted)?.objectValue else {
                    throw SessionActionError.failed("Failed to update session metadata")
                }
                version = try opsVersion(result["version"])
                _ = try store.applySessionUpdate(
                    id: id, metadata: VersionedPayload(version: version, cipher: encrypted, value: .object(latest)),
                    agentState: nil, projectId: nil,
                    reconcileComposer: { session, previous, composer, draft in
                        SessionModesReconciler.state(session: session, previous: previous, composer: composer,
                                                     draft: draft, pending: [])
                    }
                )
                if result["result"]?.stringValue == "success" { return }
                base = latest
                let local = try store.composerState(sessionId: id).values["draftUpdatedAt"]?.numberValue ?? -1
                if let remote = latest["draftUpdatedAt"]?.numberValue, remote >= local { return }
            }
            throw SessionOpsError.versionConflicts
        }
    }
}
