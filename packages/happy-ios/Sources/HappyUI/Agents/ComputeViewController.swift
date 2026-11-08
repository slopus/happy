#if canImport(UIKit)
import HappyCore
import UIKit

/// Read-only pools → machines → host facts and sandbox placements.
/// Each page owns only its visible query, not an account-wide polling loop.
final class ComputeViewController: SettingsPageViewController {
    private let session: Session
    let monitor: ComputeMonitor
    private var visible = false
    private var invalidated = false
    private var expandedRevoked = false
    private var accessWatch: Watch?
    private var accountWatch: AccountsObservation?
    private var events: Task<Void, Never>?

    init(session: Session, page: ComputeMonitor.Page = .pools) {
        self.session = session
        monitor = ComputeMonitor(client: session.client, page: page)
        super.init(title: Strings.Compute.title)
        monitor.changed = { [weak self] in self?.reload() }
    }

    deinit { events?.cancel() }

    static func offered(_ session: Session) -> Bool {
        guard let context = session.context else { return false }
        return session.isCloud && HappyCloud.isOffered(in: context.variant) && session.gate.allows(.poolsManage)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "compute-monitoring"
        accessWatch = session.watchAccess { [weak self] in
            guard let self, !invalidated else { return }
            if visible { monitor.appear(allowed: Self.offered(session)) }
            else { monitor.authorize(Self.offered(session)) }
        }
        if let account = session.context?.account {
            let activeID = account.accounts.first(where: \.isActive)?.id
            accountWatch = account.observeAccounts { [weak self] accounts in
                guard let self else { return }
                guard accounts.contains(where: { $0.id == session.accountID }), accounts.first(where: \.isActive)?.id == activeID else {
                    invalidated = true
                    stop(clear: true)
                    return
                }
            }
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        guard !invalidated else { return }
        visible = true
        session.refreshPermissions()
        monitor.appear(allowed: Self.offered(session))
        let store = session.store
        events = Task { [weak self] in
            for await _ in await store.events(matching: ComputeMonitor.refreshEvents) {
                guard !Task.isCancelled, let self, visible, !invalidated else { return }
                monitor.refresh()
            }
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        stop()
    }

    private func stop(clear: Bool = false) {
        visible = false
        events?.cancel(); events = nil
        monitor.disappear(clear: clear)
    }

    override func makeRows() -> [[SettingsRow]] {
        typealias Text = Strings.Compute
        guard !invalidated else { return [] }
        var cards: [[SettingsRow]] = []
        if let failure = monitor.failure {
            let message: String
            switch failure {
            case .forbidden: message = Text.denied
            case .missing: message = Text.missing
            case .signedOut: message = Strings.ServerSignIn.needsSignIn
            case .unavailable: message = Text.failed
            }
            var row = SettingsRow(id: "compute-status", title: message, accessory: .none)
            if failure == .unavailable {
                row.action = { [weak self] in self?.monitor.refresh() }
                if monitor.snapshot != nil { row.subtitle = Text.stale }
            }
            cards.append([row])
        }
        guard let snapshot = monitor.snapshot else {
            if cards.isEmpty { cards.append([fact("compute-loading", Text.loading)]) }
            return cards
        }
        switch snapshot {
        case .pools(let pools):
            if pools.isEmpty { cards.append([fact("compute-empty", Text.emptyPools)]) }
            for pool in pools {
                var row = SettingsRow(id: "compute-pool-\(pool.id)", title: pool.name, value: Text.capacity(pool.sandboxCapacity), action: { [weak self] in self?.open(.pool(pool.id)) })
                row.subtitle = Text.counts(pool.nodeCounts)
                row.footer = Text.capacityNote
                cards.append([row])
            }
        case .pool(let detail):
            title = detail.pool.name
            var capacity = fact("compute-capacity", Text.capacity, Text.capacity(detail.pool.sandboxCapacity))
            capacity.footer = Text.capacityNote
            cards.append([capacity])
            let current = detail.nodes.filter { $0.status != "revoked" }
            let revoked = detail.nodes.filter { $0.status == "revoked" }
            cards += current.map { [nodeRow($0)] }
            if current.isEmpty { cards.append([fact("compute-nodes-empty", Text.emptyNodes)]) }
            if !revoked.isEmpty {
                cards.append([SettingsRow(id: "compute-revoked-toggle", title: Text.revoked(revoked.count), value: expandedRevoked ? "−" : "+", accessory: .none, action: { [weak self] in
                    self?.expandedRevoked.toggle()
                })])
                if expandedRevoked { cards += revoked.map { [nodeRow($0)] } }
            }
        case .node(let node):
            title = node.displayName
            cards += nodeFacts(node)
        }
        return cards
    }

    private func open(_ page: ComputeMonitor.Page) {
        guard Self.offered(session), !invalidated, monitor.failure != .forbidden else { return }
        navigationController?.pushViewController(ComputeViewController(session: session, page: page), animated: true)
    }

    private func fact(_ id: String, _ title: String, _ value: String? = nil) -> SettingsRow {
        SettingsRow(id: id, title: title, value: value, accessory: .none)
    }

    private func nodeRow(_ node: ComputeNode) -> SettingsRow {
        var row = SettingsRow(id: "compute-node-\(node.id)", title: node.displayName, value: node.status, action: { [weak self] in self?.open(.node(node.id)) })
        row.subtitle = Strings.Compute.capacity(node.sandboxCapacity)
        return row
    }

    private func nodeFacts(_ node: ComputeNode) -> [[SettingsRow]] {
        typealias Text = Strings.Compute
        let lastSeen = node.lastSeenAt.map { Date(timeIntervalSince1970: $0 / 1000).formatted(date: .abbreviated, time: .shortened) } ?? Text.unknown
        var capacity = fact("compute-capacity", Text.capacity, Text.capacity(node.sandboxCapacity))
        capacity.footer = Text.placementNote
        var disk = fact("compute-host-disk", Text.disk, Self.bytes(node.host?.totalDiskBytes))
        disk.footer = Text.hostNote
        var cards = [[
            fact("compute-node-status", node.displayName, node.status),
            fact("compute-last-seen", Text.lastSeen, lastSeen),
            fact("compute-version", Text.version, node.version ?? Text.unknown),
            fact("compute-os", Text.operatingSystem, [node.os, node.osVersion, node.arch].compactMap { $0 }.joined(separator: " · ")),
            fact("compute-backend", Text.backend, node.backend ?? Text.unknown),
        ], [capacity], [
            fact("compute-host-cpu", Text.cpu, node.host?.cpuCores.map { $0.formatted() } ?? Text.unknown),
            fact("compute-host-memory", Text.memory, Self.bytes(node.host?.totalMemoryBytes)), disk,
        ]]
        if let error = node.sandboxError, !error.isEmpty { cards.append([fact("compute-sandbox-error", error)]) }
        let placements = node.activeSandboxes.map {
            var row = fact("compute-placement-\($0.sandboxId)", $0.agentTitle.flatMap { $0.isEmpty ? nil : $0 } ?? $0.agentId)
            row.subtitle = $0.sandboxId
            return row
        }
        cards.append(placements.isEmpty ? [fact("compute-placements-empty", Text.emptyPlacements)] : placements)
        return cards
    }

    static func bytes(_ value: Double?) -> String {
        guard let value, value.isFinite, value >= 0, value < Double(Int64.max) else { return Strings.Compute.unknown }
        return ByteCountFormatter.string(fromByteCount: Int64(value), countStyle: .binary)
    }
}
#endif