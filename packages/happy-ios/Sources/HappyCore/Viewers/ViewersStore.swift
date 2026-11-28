import Foundation
import HappyWire

/// What a header shows of one target's viewers.
public enum ViewersState: Equatable, Sendable {
    /// The computer serves no viewers (standalone, or older than them).
    case unavailable
    /// Everyone else who looks or looked at it. `live` once the server
    /// answered for it on this stream and it stayed on screen since; kept
    /// from before, nobody in it is here, only seen when last heard.
    case viewers([Viewer], live: Bool)
}

/// Who else looks at what this phone shows, over one account's event
/// stream. Screens say what they show by watching a target (`view`);
/// the store tells the server everything shown at once, again every 15
/// seconds, and nothing while the app is in the background. `SyncEngine`
/// says when the stream opens, closes, and brings a `viewers.updated`.
public actor ViewersStore {
    public typealias Put = @Sendable (_ streamId: String, _ targets: [ViewerTarget]) async throws -> [(target: ViewerTarget, viewers: [Viewer])]

    public static let mostTargets = 8

    private struct Viewing {
        let id: UUID
        let target: ViewerTarget
        let continuation: AsyncStream<ViewersState>.Continuation
    }

    private let put: Put
    private let heartbeat: Duration
    private let settle: Duration
    private var streamId: String?
    /// The server answered 404 (standalone, older, or a stream it doesn't
    /// know): nothing is asked again until the next stream says hello.
    private var refused = false
    private var foreground = true
    /// Oldest first; a target shown twice is said once.
    private var viewings: [Viewing] = []
    private var lists: [ViewerTarget: (viewers: [Viewer], live: Bool)] = [:]
    /// What the server holds for this stream; nil while unknown: a PUT
    /// went out and no answer came back, so it may have been applied.
    private var said: [ViewerTarget]? = []
    private var lastSaid: ContinuousClock.Instant?
    /// After a failed PUT: the next try comes sooner than a heartbeat,
    /// doubling up to it.
    private let retry: Duration
    private var failures = 0
    private var availability: [UUID: AsyncStream<Bool>.Continuation] = [:]
    private var pump: Task<Void, Never>?
    /// The pump that speaks for the current stream; one retired with its
    /// stream changes nothing after its awaits.
    private var pumpID: UUID?
    private var nap: Task<Void, Never>?
    private var changed = false

    public init(heartbeat: Duration = .seconds(15), settle: Duration = .milliseconds(100), retry: Duration = .seconds(2), put: @escaping Put) {
        self.heartbeat = heartbeat
        self.settle = settle
        self.retry = retry
        self.put = put
    }

    /// `target`'s viewers while the caller iterates; it counts as shown
    /// until the iteration ends.
    public func view(_ target: ViewerTarget) -> AsyncStream<ViewersState> {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: ViewersState.self, bufferingPolicy: .bufferingNewest(1))
        viewings.append(Viewing(id: id, target: target, continuation: continuation))
        continuation.yield(state(target))
        // Kept from before: asked again now, not at the next heartbeat.
        if lists[target]?.live != true { lastSaid = nil }
        continuation.onTermination = { [weak self] _ in Task { await self?.leave(id) } }
        wake()
        return stream
    }

    private func leave(_ id: UUID) {
        guard let gone = viewings.first(where: { $0.id == id }) else { return }
        viewings.removeAll { $0.id == id }
        // Off screen, its frames stop: what was heard is history now.
        if !viewings.contains(where: { $0.target == gone.target }) { lists[gone.target]?.live = false }
        wake()
    }

    /// Whether the computer serves viewers, now and as that changes: false
    /// after a 404, true again from the next stream. Watching it is not
    /// looking at anything.
    public func available() -> AsyncStream<Bool> {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: Bool.self, bufferingPolicy: .bufferingNewest(1))
        availability[id] = continuation
        continuation.yield(!refused)
        continuation.onTermination = { [weak self] _ in Task { await self?.forget(id) } }
        return stream
    }

    private func forget(_ id: UUID) { availability[id] = nil }

    /// What this stream looks at: the newest shown, at most eight.
    var wanted: [ViewerTarget] {
        guard foreground else { return [] }
        var seen = Set<ViewerTarget>()
        let newestFirst = viewings.reversed().map(\.target).filter { seen.insert($0).inserted }
        return Array(newestFirst.prefix(Self.mostTargets).reversed())
    }

    // MARK: The event stream

    /// The `hello` frame.
    public func opened(_ hello: JSONValue) {
        guard let id = hello["streamId"]?.stringValue, id != streamId else { return }
        streamId = id
        said = []
        lastSaid = nil
        failures = 0
        // A PUT still out on the old stream answers for nothing now: its
        // pump is cancelled, request and all, and this one starts at once.
        retire()
        // Another stream: nothing heard on the last one is live.
        if refused || lists.values.contains(where: \.live) {
            refused = false
            settleAll()
            publishAll()
        }
        wake()
    }

    /// The stream ended; the server ended what it looked at with it.
    public func closed() {
        streamId = nil
        said = []
        lastSaid = nil
        retire()
        settleAll()
        publishAll()
    }

    public static func isViewersFrame(_ event: String) -> Bool { event == "viewers.updated" }

    public func frame(_ data: String) {
        guard let frame = try? JSONDecoder().decode(ViewersFrame.self, from: Data(data.utf8)) else { return }
        // News on top of what was heard; live only once an answer was.
        let list = lists[frame.target]
        lists[frame.target] = (ViewerTiers.applying(frame.viewer, to: list?.viewers ?? []), list?.live ?? false)
        publish(frame.target)
    }

    /// The app came to the front or went away: away, nothing is looked at.
    public func setForeground(_ active: Bool) {
        guard foreground != active else { return }
        foreground = active
        // Away, no frames come: back, the lists are asked for afresh.
        if active {
            lastSaid = nil
        } else {
            settleAll()
            publishAll()
        }
        wake()
    }

    public func stop() {
        retire()
        streamId = nil
        for viewing in viewings { viewing.continuation.finish() }
        viewings = []
        for continuation in availability.values { continuation.finish() }
        availability = [:]
    }

    // MARK: Telling the server

    private func wake() {
        changed = true
        nap?.cancel()
        guard pump == nil else { return }
        let id = UUID()
        pumpID = id
        pump = Task { await self.run(id) }
    }

    private func retire() {
        pump?.cancel(); pump = nil; pumpID = nil
        nap?.cancel(); nap = nil
    }

    /// Says what is looked at whenever that changes, and again every
    /// heartbeat while anything is; stops once nothing is and the server
    /// surely holds nothing. A PUT whose answer was lost may have been
    /// applied, so it counts as said until one is heard: leaving or going
    /// away after it still says `[]`. One PUT at a time, so the server
    /// applies them in order, and none is cancelled while its stream
    /// lasts: a cancelled body may still land after a later `[]`. A new or
    /// closed stream retires the pump (`retire`): the server ended the old
    /// stream's views with it, so its request is cancelled and its answer
    /// ignored. In the background this runs inside the
    /// engine's hold (`SyncEngine.background`); without one, the stream
    /// closes, and the server ends what it looked at with it.
    private func run(_ id: UUID) async {
        defer { if pumpID == id { pump = nil; pumpID = nil } }
        while pumpID == id {
            if changed {
                // A push is one screen leaving and another coming: said once.
                try? await Task.sleep(for: settle)
                guard pumpID == id else { return }
                changed = false
            }
            guard let stream = streamId, !refused else { break }
            let targets = wanted
            if targets.isEmpty && said == [] { break }
            var wait = heartbeat
            if targets != said || lastSaid.map({ ContinuousClock.now - $0 >= heartbeat }) != false {
                said = nil
                do {
                    let answer = try await put(stream, targets)
                    guard pumpID == id, streamId == stream else { return }
                    said = targets
                    lastSaid = .now
                    failures = 0
                    let shown = Set(wanted)
                    for (target, viewers) in answer {
                        // Gone from screen while it was asked: not live.
                        lists[target] = (viewers, shown.contains(target))
                        publish(target)
                    }
                } catch let error as AgentClientError where error.status == 404 {
                    guard pumpID == id, streamId == stream else { return }
                    refused = true
                    said = []
                    publishAll()
                    break
                } catch {
                    guard pumpID == id, streamId == stream else { return }
                    // It may have been applied: said again soon, `[]` included.
                    wait = min(heartbeat, retry * (1 << min(failures, 8)))
                    failures += 1
                }
                if changed { continue }
                if targets.isEmpty && said == [] { break }
            } else if let lastSaid {
                // Nothing new to say: the heartbeat keeps its time.
                wait = heartbeat - (ContinuousClock.now - lastSaid)
            }
            let nap = Task<Void, Never> { try? await Task.sleep(for: wait) }
            self.nap = nap
            await nap.value
            guard pumpID == id else { return }
            if self.nap == nap { self.nap = nil }
        }
    }

    // MARK: Telling the headers

    private func state(_ target: ViewerTarget) -> ViewersState {
        if refused { return .unavailable }
        guard let list = lists[target] else { return .viewers([], live: false) }
        if list.live { return .viewers(list.viewers, live: true) }
        // Heard before, maybe long ago: whoever was here was last seen
        // then, not now (a here viewer's `lastSeenAt` is their last word).
        let then = list.viewers.map { Viewer(userId: $0.userId, here: false, lastSeenAt: $0.lastSeenAt) }
        return .viewers(ViewerTiers.ordered(then), live: false)
    }

    private func settleAll() {
        for target in lists.keys { lists[target]?.live = false }
    }

    private func publish(_ target: ViewerTarget) {
        let state = state(target)
        for viewing in viewings where viewing.target == target { viewing.continuation.yield(state) }
    }

    private func publishAll() {
        for viewing in viewings { viewing.continuation.yield(state(viewing.target)) }
        for continuation in availability.values { continuation.yield(!refused) }
    }
}
