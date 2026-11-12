#if canImport(UIKit)
import HappyCore
import UIKit

/// Settings › Compute on Happy Cloud: the requests to join the reader's
/// private machines, then every machine agents can join, with its mode,
/// and adding one; or one machine's own page. Each page owns only its
/// visible query, not an account-wide polling loop.
final class ComputeViewController: SettingsPageViewController {
    private let session: Session
    let monitor: ComputeMonitor
    private var visible = false
    private var invalidated = false
    private var accessWatch: Watch?
    private var accountWatch: AccountsObservation?
    /// Owned event subscription, exposed internally for lifecycle tests.
    private(set) var events: Task<Void, Never>?
    /// Answers sent and not yet settled, approve or not, by request.
    private(set) var answering: [String: Bool] = [:]
    /// Machines being freed from the agent holding them.
    private(set) var releasing: Set<String> = []
    /// Adding a machine, while its sheet is up.
    private(set) var adding: ComputeAddFlow?

    init(session: Session, page: ComputeMonitor.Page = .machines) {
        self.session = session
        monitor = ComputeMonitor(client: session.client, page: page)
        super.init(title: Strings.Compute.title)
        monitor.changed = { [weak self] in self?.reload() }
    }

    deinit { events?.cancel() }

    static func offered(_ session: Session) -> Bool {
        guard let context = session.context else { return false }
        return session.isCloud && HappyCloud.isOffered(in: context.variant) && ComputeAccess(session.gate) != .none
    }

    private var access: ComputeAccess { ComputeAccess(session.gate) }
    /// Who reads, for which private machines are theirs.
    private var viewer: String? { session.home.userId ?? session.context?.account.agentConnections.userId(for: session.accountID) }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "compute"
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
        // A cancelled interactive pop can announce another appearance
        // without disappearing first. Keep exactly one owned subscription.
        events?.cancel()
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
        case .machines(let list):
            cards += requestCards(list)
            var machines = list.nodes.map { machineRow($0, owners: list.owners) }
            if machines.isEmpty {
                var none = fact("compute-empty", Text.noMachines)
                none.dimmed = true
                machines = [none]
            }
            if access != .none {
                machines.append(SettingsRow(id: "compute-add", title: Text.addMachine, icon: ("add", .action), accessory: .none, action: { [weak self] in self?.add() }))
            }
            machines[0].header = Text.machines
            machines[machines.count - 1].footer = Text.machinesNote(access)
            cards.append(machines)
        case .machine(let node):
            title = node.displayName
            cards += machinePage(node)
        }
        return cards
    }

    // MARK: Join requests

    /// A card for each request: who asks to join which machine, then
    /// Approve and Deny, so neither is behind a menu.
    private func requestCards(_ list: ComputeMachines) -> [[SettingsRow]] {
        typealias Text = Strings.Compute
        let now = Date().timeIntervalSince1970 * 1000
        var cards = list.approvals.map { approval -> [SettingsRow] in
            let answer = answering[approval.id]
            let machine = approval.nodeName ?? list.nodes.first { $0.id == approval.nodeId }?.displayName ?? Text.yourMachine
            var request = SettingsRow(id: "compute-request-\(approval.id)", title: approval.agentTitle ?? Text.anAgent, icon: ("shield-checkmark-outline", .purple), accessory: .none)
            request.subtitle = Text.wantsToJoin(machine, Strings.UserProfile.ago(DetailFormat.age(since: approval.createdAt, now: now)).lowercased())
            func choice(_ approve: Bool) -> SettingsRow {
                var row = SettingsRow(id: "compute-\(approve ? "approve" : "deny")-\(approval.id)", title: approve ? Text.approve : Text.deny,
                                      icon: approve ? ("checkmark", .green) : ("close", .red), accessory: .none)
                if let answer {
                    row.dimmed = true
                    if answer == approve { row.valueView = Self.spinner() }
                } else {
                    row.action = { [weak self] in self?.answer(approval, approve: approve) }
                }
                return row
            }
            return [request, choice(true), choice(false)]
        }
        if !cards.isEmpty {
            cards[0][0].header = Text.joinRequests
            cards[cards.count - 1][2].footer = Text.joinRequestsNote
        }
        return cards
    }

    func answer(_ approval: ComputeApproval, approve: Bool) {
        guard answering[approval.id] == nil else { return }
        answering[approval.id] = approve
        reload()
        let client = session.client
        Task { @MainActor [weak self] in
            do {
                try await client.answerComputeApproval(approval, approve: approve)
                self?.answering[approval.id] = nil
                self?.monitor.refresh()
            } catch {
                guard let self else { return }
                answering[approval.id] = nil
                reload()
                Alerts.show(Strings.Compute.actionFailed, Self.words(error), on: self)
            }
        }
    }

    // MARK: Machines

    static func icon(_ kind: ComputeMode.Kind) -> (glyph: String, tile: SettingsRow.Tile) {
        switch kind {
        case .sandbox: ("cube-outline", .teal)
        case .shared: ("people-outline", .blue)
        case .exclusive: ("lock-closed-outline", .orange)
        case .private: ("person-outline", .indigo)
        }
    }

    /// Its mode, who holds or owns it, and where it runs, then what
    /// agents read about it: a few lines of that in the list, all of it on
    /// its own page.
    private func machineRow(_ node: ComputeNode, owners: [String: String], whole: Bool = false) -> SettingsRow {
        typealias Text = Strings.Compute
        let who: String?
        switch node.mode {
        case .exclusive(let holder?): who = Text.heldBy(holder.title)
        case .private(let owner?): who = node.ownedBy(viewer) ? Text.yours : Text.owner(owners[owner])
        default: who = nil
        }
        let platform = [Text.platform(node.os), node.arch].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
        let line = [Text.mode(node.mode.kind), who, platform.isEmpty ? nil : platform].compactMap { $0 }.joined(separator: " · ")
        var row = SettingsRow(id: "compute-node-\(node.id)", title: node.displayName, icon: Self.icon(node.mode.kind),
                              value: releasing.contains(node.id) ? nil : Text.status(node.status, held: node.mode.holder != nil && node.status == .online),
                              accessory: whole ? .none : .chevron)
        row.subtitle = node.description.map { "\(line)\n\($0)" } ?? line
        row.subtitleLines = whole ? 0 : 4
        if releasing.contains(node.id) { row.valueView = Self.spinner() }
        guard !whole else { return row }
        let actions = machineActions(node)
        if actions.isEmpty {
            row.action = { [weak self] in self?.open(.machine(node.id)) }
        } else {
            row.pullDown = { [weak self] in
                guard let self else { return nil }
                let details = UIAction(title: Text.details, image: Glyphs.image("server-outline", size: 17)) { [weak self] _ in self?.open(.machine(node.id)) }
                return UIMenu(children: [details] + machineActions(node).map { item in
                    UIAction(title: item.title, image: Glyphs.image(item.glyph, size: 17), attributes: item.destructive ? .destructive : []) { _ in item.run() }
                })
            }
            row.menu = actions
        }
        return row
    }

    /// Edit for a manager or a private machine's owner, Release for a
    /// manager while an agent holds it.
    private func machineActions(_ node: ComputeNode) -> [SettingsRow.MenuItem] {
        typealias Text = Strings.Compute
        var items: [SettingsRow.MenuItem] = []
        if node.editable(by: access, userId: viewer) {
            items.append(.init(title: Text.edit, glyph: "create-outline") { [weak self] in self?.edit(node) })
        }
        if node.releasable(by: access), !releasing.contains(node.id) {
            items.append(.init(title: Text.release, glyph: "exit-outline", destructive: true) { [weak self] in self?.confirmRelease(node) })
        }
        return items
    }

    private func machinePage(_ node: ComputeNode) -> [[SettingsRow]] {
        typealias Text = Strings.Compute
        var cards = [[machineRow(node, owners: [:], whole: true)]]
        let lastSeen = node.lastSeenAt.map { Date(timeIntervalSince1970: $0 / 1000).formatted(date: .abbreviated, time: .shortened) } ?? Text.unknown
        let system = [Text.platform(node.os), node.osVersion, node.arch].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        cards.append([
            fact("compute-os", Text.operatingSystem, system.isEmpty ? Text.unknown : system),
            fact("compute-version", Text.version, node.version ?? Text.unknown),
            fact("compute-last-seen", Text.lastSeen, lastSeen),
        ])
        var actions: [SettingsRow] = []
        if node.editable(by: access, userId: viewer) {
            actions.append(SettingsRow(id: "compute-edit", title: Text.edit, icon: ("create-outline", .action), accessory: .none, action: { [weak self] in self?.edit(node) }))
        }
        if node.releasable(by: access) {
            var release = SettingsRow(id: "compute-release", title: Text.release, accessory: .none, destructive: true)
            if releasing.contains(node.id) { release.valueView = Self.spinner(); release.dimmed = true }
            else { release.action = { [weak self] in self?.confirmRelease(node) } }
            release.footer = Text.releaseNote
            actions.append(release)
        }
        if !actions.isEmpty { cards.append(actions) }
        if let error = node.sandboxError, !error.isEmpty {
            var row = fact("compute-sandbox-error", Text.sandboxError(error))
            row.destructive = true
            cards.append([row])
        }
        // Host facts and placements come only to managers.
        if let capacityValue = node.sandboxCapacity {
            var capacity = fact("compute-capacity", Text.capacity, Text.capacity(capacityValue))
            capacity.footer = Text.placementNote
            cards.append([fact("compute-backend", Text.backend, node.backend ?? Text.unknown), capacity])
        }
        if node.host != nil || node.sandboxCapacity != nil {
            var disk = fact("compute-host-disk", Text.disk, Self.bytes(node.host?.totalDiskBytes))
            disk.footer = Text.hostNote
            cards.append([
                fact("compute-host-cpu", Text.cpu, node.host?.cpuCores.map { $0.formatted() } ?? Text.unknown),
                fact("compute-host-memory", Text.memory, Self.bytes(node.host?.totalMemoryBytes)), disk,
            ])
        }
        if let placements = node.activeSandboxes {
            let rows = placements.map {
                var row = fact("compute-placement-\($0.sandboxId)", $0.agentTitle.flatMap { $0.isEmpty ? nil : $0 } ?? $0.agentId)
                row.subtitle = $0.sandboxId
                return row
            }
            cards.append(rows.isEmpty ? [fact("compute-placements-empty", Text.emptyPlacements)] : rows)
        }
        return cards
    }

    private func open(_ page: ComputeMonitor.Page) {
        guard Self.offered(session), !invalidated, monitor.failure != .forbidden else { return }
        navigationController?.pushViewController(ComputeViewController(session: session, page: page), animated: true)
    }

    func confirmRelease(_ node: ComputeNode) {
        typealias Text = Strings.Compute
        guard case .exclusive(let holder?) = node.mode else { return }
        Task { @MainActor [weak self] in
            guard let self, await Alerts.confirm(Text.releaseTitle(node.displayName), Text.releaseMessage(holder.title ?? Text.anAgent),
                                                 confirmTitle: Text.release, destructive: true, on: self) else { return }
            release(node)
        }
    }

    func release(_ node: ComputeNode) {
        guard node.releasable(by: access), releasing.insert(node.id).inserted else { return }
        reload()
        let client = session.client
        Task { @MainActor [weak self] in
            do {
                try await client.releaseComputeLock(node.id)
                self?.releasing.remove(node.id)
                self?.monitor.refresh()
            } catch {
                guard let self else { return }
                releasing.remove(node.id)
                reload()
                Alerts.show(Strings.Compute.actionFailed, Self.words(error), on: self)
            }
        }
    }

    func edit(_ node: ComputeNode) {
        let form = ComputeFormViewController(edit: node, client: session.client) { [weak self] in self?.monitor.refresh() }
        present(UINavigationController(rootViewController: form), animated: true)
    }

    func add() {
        guard let flow = ComputeAddFlow(access: access, client: session.client, added: { [weak self] in self?.monitor.refresh() }) else { return }
        adding = flow
        flow.closed = { [weak self] in self?.adding = nil }
        present(flow.navigation, animated: true)
    }

    // MARK: Pieces

    private func fact(_ id: String, _ title: String, _ value: String? = nil) -> SettingsRow {
        SettingsRow(id: id, title: title, value: value, accessory: .none)
    }

    private static func spinner() -> UIView {
        let spinner = UIActivityIndicatorView(style: .medium)
        spinner.startAnimating()
        return spinner
    }

    static func bytes(_ value: Double?) -> String {
        guard let value, value.isFinite, value >= 0, value < Double(Int64.max) else { return Strings.Compute.unknown }
        return ByteCountFormatter.string(fromByteCount: Int64(value), countStyle: .binary)
    }

    /// The server's words for a refusal, where it gave some.
    static func words(_ error: any Error) -> String {
        if case AgentClientError.status(_, _, let message?) = error { return message }
        return error.localizedDescription
    }
}

extension ComputeMode {
    /// The agent holding an exclusive machine.
    var holder: ComputeHolder? {
        if case .exclusive(let holder) = self { return holder }
        return nil
    }
}
#endif
