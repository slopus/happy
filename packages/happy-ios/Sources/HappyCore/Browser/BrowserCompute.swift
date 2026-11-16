import Foundation
import HappyWire

/// Whether the computer an agent's page runs on is there. On Happy Cloud
/// the agent's `compute` says so: `type: "none"` is detached, `status:
/// "offline"` gone, `status: "online"` back.
public enum BrowserCompute: Equatable, Sendable {
    case attached
    case detached

    /// From an agent's `compute` object; nil when it says neither.
    public init?(compute: JSONValue?) {
        guard let compute else { return nil }
        if compute["type"]?.stringValue == "none" { self = .detached; return }
        switch compute["status"]?.stringValue {
        case "offline": self = .detached
        case "online": self = .attached
        default: return nil
        }
    }

    /// A refused tunnel that means the compute is gone rather than the
    /// page: `409 no_compute`, or `503` `compute_offline`,
    /// `runner_unavailable` or `draining`.
    public static func gone(status: Int, code: String?) -> Bool {
        switch (status, code) {
        case (409, "no_compute"), (503, "compute_offline"), (503, "runner_unavailable"), (503, "draining"): true
        default: false
        }
    }

    /// The same, from a refusal's JSON body (its `code`).
    public static func gone(status: Int, body: Data) -> Bool {
        gone(status: status, code: BrowserTunnel.code(body))
    }
}

/// Where the agent's compute comes from, for an open page to follow.
public protocol BrowserComputeSource: Sendable {
    /// The agent's compute as it changes, starting with what it is now.
    func changes(agentID: String) -> AsyncStream<BrowserCompute>
}

/// An agent's compute as its `agent.updated` events tell it, read whole
/// first and again after the event stream may have lost some. It is told
/// only once the compute has said online or offline: a computer's own
/// agents report `type: "none"`, and their pages never close for it.
public struct BrowserAgentCompute: BrowserComputeSource {
    private let client: AgentClient
    private let store: Store

    public init(client: AgentClient, store: Store) {
        self.client = client; self.store = store
    }

    public func changes(agentID: String) -> AsyncStream<BrowserCompute> {
        let client = client, store = store
        return AsyncStream { continuation in
            let task = Task {
                let events = await store.events(matching: ["agent.updated"]) { event in
                    event["payload"]?["agentId"]?.stringValue == agentID && event["payload"]?["changes"]?["compute"] != nil
                }
                var follows = false
                func tell(_ compute: JSONValue?) {
                    guard let compute, let state = BrowserCompute(compute: compute) else { return }
                    if compute["status"] != nil { follows = true }
                    if follows { continuation.yield(state) }
                }
                func read() async {
                    let agent = try? await client.decode(JSONValue.self, "GET", "/v0/agents/\(AgentClient.escape(agentID))")
                    tell(agent?["agent"]?["compute"])
                }
                await read()
                for await event in events {
                    switch event {
                    case .event(let envelope): tell(envelope["payload"]?["changes"]?["compute"])
                    case .resync: await read()
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// What a page does as its compute comes and goes: it closes once, saying
/// the compute is disconnected, and opens the same address again when the
/// compute is back. A tunnel refused for the compute being gone closes it
/// as the compute's own news does (`apply(.detached)`); only the
/// compute's return reopens it.
public struct BrowserComputeGate: Equatable, Sendable {
    public enum Action: Equatable, Sendable { case close, reopen }

    public private(set) var closed = false

    public init() {}

    public mutating func apply(_ compute: BrowserCompute) -> Action? {
        switch (compute, closed) {
        case (.detached, false): closed = true; return .close
        case (.attached, true): closed = false; return .reopen
        default: return nil
        }
    }
}

/// A page opened again for its compute whose server isn't responding yet
/// (a dev server still starting) loads again after 2, 4, 8 and 15 s, then
/// leaves it to Try Again. Only that reopen: an ordinary load never tries
/// again by itself, and a page that loaded, another failure, or anything
/// the person does ends it.
public struct BrowserReopenRetry: Equatable, Sendable {
    public static let delays: [Duration] = [.seconds(2), .seconds(4), .seconds(8), .seconds(15)]

    /// Tries made since the compute came back; nil when none are to come.
    private var tries: Int?

    public init() {}

    /// The compute came back and the page opens again.
    public mutating func reopened() { tries = 0 }

    /// The page failed with `problem`: how long until it loads again, or nil when it won't.
    public mutating func failed(_ problem: BrowserProblem) -> Duration? {
        guard problem == .serverNotResponding, let made = tries, made < Self.delays.count else { tries = nil; return nil }
        tries = made + 1
        return Self.delays[made]
    }

    /// The page loaded, or the person did something.
    public mutating func end() { tries = nil }
}
