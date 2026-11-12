import Foundation

/// Settings › Compute's list: the computers agents can join, online first,
/// and the requests to join the reader's private computers.
public struct Computers: Equatable, Sendable {
    public let computers: [Computer]
    public let approvals: [ComputeApproval]
    /// Member names by user ID, for the private computers of others a
    /// manager sees; a member with no saved name is left out.
    public let owners: [String: String]

    public init(computers: [Computer], approvals: [ComputeApproval], owners: [String: String] = [:]) {
        self.computers = computers.sorted {
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
        case computers
        case computer(String)
    }
    public enum Snapshot: Equatable, Sendable {
        case computers(Computers)
        case computer(Computer)
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

    /// A computer joining, leaving or changing says `runners.updated` and
    /// `compute.nodes.updated`; a request to join one of the reader's
    /// computers, or its answer, `compute.approvals.updated`. None carries
    /// a payload.
    public static let refreshEvents = ["runners.updated", "compute.nodes.updated", "compute.approvals.updated"]

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
                case .computers:
                    async let computers = client.computers()
                    async let approvals = client.computerApprovals()
                    let (listed, waiting) = try await (computers, approvals)
                    named = await Self.names(listed, known: known, client: client)
                    next = .computers(Computers(computers: listed, approvals: waiting, owners: named.compactMapValues { $0 }))
                case .computer(let id): next = .computer(try await client.computer(id))
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

    /// The names of the private computers' owners, asked for only while one
    /// isn't known yet. A failed read leaves them unnamed, not the list.
    private nonisolated static func names(_ computers: [Computer], known: [String: String?], client: AgentClient) async -> [String: String?] {
        let owners = Set(computers.compactMap { computer -> String? in
            if case .private(let owner?) = computer.mode { return owner }
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
