import Foundation

/// One visible read-only monitoring page. Cancellation and authorization
/// are checked again after every response, even if a transport ignores cancellation.
@MainActor
public final class ComputeMonitor {
    public enum Page: Equatable, Sendable {
        case pools
        case pool(String)
        case node(String)
    }
    public enum Snapshot: Equatable, Sendable {
        case pools([ComputePool])
        case pool(ComputePoolDetail)
        case node(ComputeNode)
    }
    public enum Failure: Equatable, Sendable { case unavailable, forbidden, missing, signedOut }

    public let page: Page
    public private(set) var snapshot: Snapshot?
    public private(set) var failure: Failure?
    public private(set) var reading: Task<Void, Never>?
    public var changed: (() -> Void)?
    private let client: AgentClient
    private var visible = false
    private var allowed = false
    private var again = false
    private var poll: Task<Void, Never>?

    public static let refreshEvents = ["compute.nodes.updated", "compute.pools.updated"]

    public init(client: AgentClient, page: Page) {
        self.client = client
        self.page = page
    }

    deinit { reading?.cancel(); poll?.cancel() }

    public func appear(allowed: Bool, interval: Duration = .seconds(30)) {
        visible = true
        authorize(allowed)
        guard allowed, failure != .forbidden, failure != .signedOut, poll == nil else { return }
        poll = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: interval) } catch { return }
                self?.refresh()
            }
        }
    }

    public func disappear(clear: Bool = false) {
        visible = false
        cancel()
        if clear { snapshot = nil; changed?() }
    }

    public func authorize(_ allowed: Bool) {
        let wasAllowed = self.allowed
        self.allowed = allowed
        guard allowed else {
            cancel()
            snapshot = nil
            failure = .forbidden
            changed?()
            return
        }
        if !wasAllowed { failure = nil }
        if visible { refresh() }
    }

    private func cancel() {
        reading?.cancel(); reading = nil
        poll?.cancel(); poll = nil
        again = false
    }

    /// Overlapping polling/event reads become at most one follow-up read.
    public func refresh() {
        guard visible, allowed, failure != .forbidden, failure != .signedOut else { return }
        guard reading == nil else { again = true; return }
        let client = client, page = page
        reading = Task { [weak self] in
            do {
                let next: Snapshot
                switch page {
                case .pools: next = .pools(try await client.computePools())
                case .pool(let id): next = .pool(try await client.computePool(id))
                case .node(let id): next = .node(try await client.computeNode(id))
                }
                guard !Task.isCancelled, let self, visible, allowed else { return }
                snapshot = next
                failure = nil
            } catch {
                guard !Task.isCancelled, let self, visible, allowed else { return }
                switch error {
                case AgentClientError.revoked:
                    snapshot = nil; failure = .signedOut; poll?.cancel(); poll = nil
                case AgentClientError.status(403, _, _):
                    snapshot = nil; failure = .forbidden; poll?.cancel(); poll = nil
                case AgentClientError.status(404, _, _):
                    snapshot = nil; failure = .missing
                default:
                    // A transient failure retains the last reading, marked stale.
                    failure = .unavailable
                }
            }
            guard !Task.isCancelled, let self, visible, allowed else { return }
            reading = nil
            changed?()
            if again { again = false; refresh() }
        }
    }
}