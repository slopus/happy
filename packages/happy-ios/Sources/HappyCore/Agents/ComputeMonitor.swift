import Foundation

/// Settings › Compute's list: the machines agents can join, online first,
/// and the requests to join the reader's private machines.
public struct ComputeMachines: Equatable, Sendable {
    public let nodes: [ComputeNode]
    public let approvals: [ComputeApproval]
    /// Member names by user ID, for the private machines of others a
    /// manager sees; a member with no saved name is left out.
    public let owners: [String: String]

    public init(nodes: [ComputeNode], approvals: [ComputeApproval], owners: [String: String] = [:]) {
        self.nodes = nodes.sorted {
            $0.status == .online && $1.status != .online
                || ($0.status == .online) == ($1.status == .online) && $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending
        }
        self.approvals = approvals
        self.owners = owners
    }
}

/// One visible compute page's reads. Cancellation and authorization are
/// checked again after every response, even if a transport ignores
/// cancellation.
@MainActor
public final class ComputeMonitor {
    public enum Page: Equatable, Sendable {
        case machines
        case machine(String)
    }
    public enum Snapshot: Equatable, Sendable {
        case machines(ComputeMachines)
        case machine(ComputeNode)
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
    /// Owner names already asked for, kept for the page's life.
    private var owners: [String: String?] = [:]

    /// A machine joining, leaving or changing says `runners.updated`; a
    /// request to join one of the reader's machines, or its answer,
    /// `compute.approvals.updated`. Neither carries a payload.
    public static let refreshEvents = ["runners.updated", "compute.approvals.updated"]

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
        let client = client, page = page, known = owners
        reading = Task { [weak self] in
            do {
                let next: Snapshot
                var named: [String: String?] = [:]
                switch page {
                case .machines:
                    async let nodes = client.computeNodes()
                    async let approvals = client.computeApprovals()
                    let (listed, waiting) = try await (nodes, approvals)
                    named = await Self.names(listed, known: known, client: client)
                    next = .machines(ComputeMachines(nodes: listed, approvals: waiting, owners: named.compactMapValues { $0 }))
                case .machine(let id): next = .machine(try await client.computeNode(id))
                }
                guard !Task.isCancelled, let self, visible, allowed else { return }
                owners = named.isEmpty ? owners : named
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

    /// The names of the private machines' owners, asked for only while one
    /// isn't known yet. A failed read leaves them unnamed, not the list.
    private nonisolated static func names(_ nodes: [ComputeNode], known: [String: String?], client: AgentClient) async -> [String: String?] {
        let owners = Set(nodes.compactMap { node -> String? in
            if case .private(let owner?) = node.mode { return owner }
            return nil
        })
        let missing = owners.subtracting(known.keys)
        guard !missing.isEmpty else { return known }
        guard let users = try? await client.teamUsers(missing.sorted()) else { return known }
        var names = known
        for owner in missing { names[owner] = .some(nil) }
        for user in users where !user.name.isEmpty { names[user.id] = user.name }
        return names
    }
}
