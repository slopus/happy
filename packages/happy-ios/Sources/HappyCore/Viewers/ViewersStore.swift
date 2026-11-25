import Foundation
import HappyWire

/// What a header shows of one target's viewers.
public enum ViewersState: Equatable, Sendable {
    /// The computer serves no viewers (standalone, or older than them).
    case unavailable
    /// Everyone else who looks or looked at it. `live` once the server
    /// answered for it on this stream; false for what was kept from before.
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
    /// What the server holds for this stream.
    private var said: [ViewerTarget] = []
    private var lastSaid: ContinuousClock.Instant?
    private var pump: Task<Void, Never>?
    private var nap: Task<Void, Never>?
    private var changed = false

    public init(heartbeat: Duration = .seconds(15), settle: Duration = .milliseconds(100), put: @escaping Put) {
        self.heartbeat = heartbeat
        self.settle = settle
        self.put = put
    }

    /// `target`'s viewers while the caller iterates; it counts as shown
    /// until the iteration ends.
    public func view(_ target: ViewerTarget) -> AsyncStream<ViewersState> {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: ViewersState.self, bufferingPolicy: .bufferingNewest(1))
        viewings.append(Viewing(id: id, target: target, continuation: continuation))
        continuation.yield(state(target))
        continuation.onTermination = { [weak self] _ in Task { await self?.leave(id) } }
        wake()
        return stream
    }

    private func leave(_ id: UUID) {
        viewings.removeAll { $0.id == id }
        wake()
    }

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
        if refused {
            refused = false
            publishAll()
        }
        wake()
    }

    /// The stream ended; the server ended what it looked at with it.
    public func closed() {
        streamId = nil
        said = []
        lastSaid = nil
        for (target, list) in lists where list.live { lists[target]?.live = false }
        publishAll()
    }

    public static func isViewersFrame(_ event: String) -> Bool { event == "viewers.updated" }

    public func frame(_ data: String) {
        guard let frame = try? JSONDecoder().decode(ViewersFrame.self, from: Data(data.utf8)) else { return }
        lists[frame.target] = (ViewerTiers.applying(frame.viewer, to: lists[frame.target]?.viewers ?? []), true)
        publish(frame.target)
    }

    /// The app came to the front or went away: away, nothing is looked at.
    public func setForeground(_ active: Bool) {
        guard foreground != active else { return }
        foreground = active
        wake()
    }

    public func stop() {
        pump?.cancel(); pump = nil
        nap?.cancel(); nap = nil
        streamId = nil
        for viewing in viewings { viewing.continuation.finish() }
        viewings = []
    }

    // MARK: Telling the server

    private func wake() {
        changed = true
        nap?.cancel()
        guard pump == nil else { return }
        pump = Task { await self.run() }
    }

    /// Says what is looked at whenever that changes, and again every
    /// heartbeat while anything is; stops once nothing is and the server
    /// was told so.
    private func run() async {
        while !Task.isCancelled {
            if changed {
                // A push is one screen leaving and another coming: said once.
                try? await Task.sleep(for: settle)
                changed = false
            }
            guard let stream = streamId, !refused else { break }
            let targets = wanted
            if targets.isEmpty && said.isEmpty { break }
            var wait = heartbeat
            if targets != said || lastSaid.map({ ContinuousClock.now - $0 >= heartbeat }) != false {
                do {
                    let answer = try await put(stream, targets)
                    guard streamId == stream else { continue }
                    said = targets
                    lastSaid = .now
                    for (target, viewers) in answer {
                        lists[target] = (viewers, true)
                        publish(target)
                    }
                } catch let error as AgentClientError where error.status == 404 {
                    guard streamId == stream else { continue }
                    refused = true
                    said = []
                    publishAll()
                    break
                } catch {
                    // The next heartbeat says it again.
                }
                if changed { continue }
                if targets.isEmpty && said.isEmpty { break }
            } else if let lastSaid {
                // Nothing new to say: the heartbeat keeps its time.
                wait = heartbeat - (ContinuousClock.now - lastSaid)
            }
            let nap = Task<Void, Never> { try? await Task.sleep(for: wait) }
            self.nap = nap
            await nap.value
            if self.nap == nap { self.nap = nil }
        }
        pump = nil
    }

    // MARK: Telling the headers

    private func state(_ target: ViewerTarget) -> ViewersState {
        if refused { return .unavailable }
        let list = lists[target]
        return .viewers(list?.viewers ?? [], live: list?.live ?? false)
    }

    private func publish(_ target: ViewerTarget) {
        let state = state(target)
        for viewing in viewings where viewing.target == target { viewing.continuation.yield(state) }
    }

    private func publishAll() {
        for viewing in viewings { viewing.continuation.yield(state(viewing.target)) }
    }
}
