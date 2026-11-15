#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Settings › Compute on Happy Cloud: the requests to join the reader's
/// private computers, then every computer agents can join, shared or
/// private and how full, and adding one; or one computer's own page, where
/// its agents are and how many it runs at once. Each page owns only its
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
    /// Agents being taken off a computer, by `computer/agent`.
    private(set) var removing: Set<String> = []
    /// Computers whose concurrency is being saved.
    private(set) var saving: Set<String> = []
    /// Adding a computer, while its sheet is up.
    private(set) var adding: ComputeAddFlow?

    init(session: Session, page: ComputeMonitor.Page = .computers) {
        self.session = session
        monitor = ComputeMonitor(client: session.client, page: page)
        super.init(title: Strings.Compute.title)
        monitor.changed = { [weak self] in self?.reload() }
    }

    deinit { events?.cancel() }

    static func offered(_ session: Session) -> Bool {
        guard let context = session.context else { return false }
        return session.isCloud && HappyCloud.isOffered(in: context.variant) && ComputeRole(session.gate) != .none
    }

    private var role: ComputeRole { ComputeRole(session.gate) }
    /// Who reads, for which private computers are theirs.
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
        case .computers(let list):
            cards += requestCards(list)
            var computers = list.computers.map { computerRow($0, owners: list.owners) }
            if computers.isEmpty {
                var none = fact("compute-empty", Text.noComputers)
                none.dimmed = true
                computers = [none]
            }
            if role != .none {
                computers.append(SettingsRow(id: "compute-add", title: Text.addComputer, icon: ("add", .action), accessory: .none, action: { [weak self] in self?.add() }))
            }
            computers[0].header = Text.computers
            computers[computers.count - 1].footer = Text.computersNote(role)
            cards.append(computers)
        case .computer(let node):
            title = node.displayName
            cards += computerPage(node)
        }
        return cards
    }

    // MARK: Join requests

    /// A card for each request: who asks to join which computer, then
    /// Approve and Deny, so neither is behind a menu.
    private func requestCards(_ list: Computers) -> [[SettingsRow]] {
        typealias Text = Strings.Compute
        let now = Date().timeIntervalSince1970 * 1000
        var cards = list.approvals.map { approval -> [SettingsRow] in
            let answer = answering[approval.id]
            let computer = approval.computerName ?? list.computers.first { $0.id == approval.computerId }?.displayName
            var request = SettingsRow(id: "compute-request-\(approval.id)", title: approval.agentTitle ?? Text.anAgent, icon: ("shield-checkmark-outline", .purple), accessory: .none)
            request.subtitle = Text.wantsToJoin(computer, Strings.UserProfile.ago(DetailFormat.age(since: approval.createdAt, now: now)).lowercased())
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
                try await client.answerComputerApproval(approval, approve: approve)
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

    // MARK: Computers

    static func icon(_ access: ComputeAccess) -> (glyph: String, tile: SettingsRow.Tile) {
        switch access {
        case .shared: ("people-outline", .blue)
        case .private: ("person-outline", .indigo)
        }
    }

    /// Shared or whose, how full, and where it runs, then what agents read
    /// about it: a few lines of that in the list, all of it on its own page.
    private func computerRow(_ node: Computer, owners: [String: String], whole: Bool = false) -> SettingsRow {
        typealias Text = Strings.Compute
        let who: String? = node.access == .private ? (node.ownedBy(viewer) ? Text.yours : Text.owner(node.owner.flatMap { owners[$0] })) : nil
        let platform = [Text.platform(node.os), node.arch].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
        let line = [Text.access(node.access), who, Text.agents(node.agents.count, of: node.concurrency),
                    node.boundary.available ? nil : Text.fullAccessOnly, platform.isEmpty ? nil : platform].compactMap { $0 }.joined(separator: " · ")
        var row = SettingsRow(id: "compute-node-\(node.id)", title: node.displayName, icon: Self.icon(node.access),
                              value: Text.status(node.status, full: node.full), accessory: whole ? .none : .chevron)
        row.subtitle = node.description.map { "\(line)\n\($0)" } ?? line
        row.subtitleLines = whole ? 0 : 4
        if !whole { row.action = { [weak self] in self?.open(.computer(node.id)) } }
        return row
    }

    private func computerPage(_ node: Computer) -> [[SettingsRow]] {
        typealias Text = Strings.Compute
        var cards = [[computerRow(node, owners: [:], whole: true)]]
        let manageable = node.manageable(by: role, userId: viewer)
        if !node.boundary.available {
            var warning = fact("compute-boundary", Text.boundaryMissing)
            warning.icon = ("warning-outline", .orange)
            warning.subtitle = node.boundary.reason
            warning.subtitleLines = 0
            warning.footer = Text.boundaryNote
            cards.append([warning])
        }
        var agents = node.agents.map { agent -> SettingsRow in
            let key = "\(node.id)/\(agent.id)"
            var row = fact("compute-agent-\(agent.id)", agent.title.flatMap { $0.isEmpty ? nil : $0 } ?? Text.anAgent)
            row.subtitle = agent.id
            if removing.contains(key) {
                row.valueView = Self.spinner()
                row.dimmed = true
            } else if manageable {
                // A tap asks before it takes the agent off.
                let glyph = UIImageView(image: Glyphs.image("close-circle-outline", size: 22))
                glyph.tintColor = UIColor(Palette.settingsDestructive)
                glyph.sizeToFit()
                glyph.accessibilityLabel = Text.remove
                row.valueView = glyph
                row.action = { [weak self] in self?.confirmRemove(agent, from: node) }
                row.menu = [SettingsRow.MenuItem(title: Text.remove, glyph: "close-circle-outline", destructive: true) { [weak self] in
                    self?.confirmRemove(agent, from: node)
                }]
            }
            return row
        }
        if agents.isEmpty {
            var none = fact("compute-agents-empty", Text.noAgents)
            none.dimmed = true
            agents = [none]
        }
        agents[0].header = Text.agents(node.agents.count, of: node.concurrency)
        cards.append(agents)
        var concurrency = fact("compute-concurrency", Text.concurrency, "\(node.concurrency)")
        if saving.contains(node.id) {
            concurrency.valueView = Self.spinner()
            concurrency.dimmed = true
        } else if manageable {
            concurrency.accessory = .chevron
            concurrency.action = { [weak self] in self?.editConcurrency(node) }
        }
        concurrency.footer = Text.concurrencyNote(most: node.concurrencyRange.upperBound)
        cards.append([concurrency])
        let lastSeen = node.lastSeenAt.map { Date(timeIntervalSince1970: $0 / 1000).formatted(date: .abbreviated, time: .shortened) } ?? Text.unknown
        let system = [Text.platform(node.os), node.osVersion, node.arch].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        cards.append([
            fact("compute-os", Text.operatingSystem, system.isEmpty ? Text.unknown : system),
            fact("compute-shell", Text.shell, node.shell.flatMap { $0.isEmpty ? nil : $0 } ?? Text.unknown),
            fact("compute-version", Text.version, node.version ?? Text.unknown),
            fact("compute-last-seen", Text.lastSeen, lastSeen),
        ])
        // Host facts and the backend come only to managers.
        if node.host != nil || node.backend != nil {
            var disk = fact("compute-host-disk", Text.disk, Self.bytes(node.host?.totalDiskBytes))
            disk.footer = Text.hostNote
            cards.append([
                fact("compute-backend", Text.backend, node.backend ?? Text.unknown),
                fact("compute-host-cpu", Text.cpu, node.host?.cpuCores.map { $0.formatted() } ?? Text.unknown),
                fact("compute-host-memory", Text.memory, Self.bytes(node.host?.totalMemoryBytes)), disk,
            ])
        }
        return cards
    }

    private func open(_ page: ComputeMonitor.Page) {
        guard Self.offered(session), !invalidated, monitor.failure != .forbidden else { return }
        navigationController?.pushViewController(ComputeViewController(session: session, page: page), animated: true)
    }

    func confirmRemove(_ agent: Computer.Agent, from node: Computer) {
        typealias Text = Strings.Compute
        Task { @MainActor [weak self] in
            guard let self, await Alerts.confirm(Text.removeTitle(agent.title ?? Text.anAgent), Text.removeMessage,
                                                 confirmTitle: Text.remove, destructive: true, on: self) else { return }
            remove(agent, from: node)
        }
    }

    func remove(_ agent: Computer.Agent, from node: Computer) {
        let key = "\(node.id)/\(agent.id)"
        guard node.manageable(by: role, userId: viewer), removing.insert(key).inserted else { return }
        reload()
        let client = session.client
        Task { @MainActor [weak self] in
            do {
                try await client.removeComputerAgent(node.id, agent: agent.id)
                self?.removing.remove(key)
                self?.monitor.refresh()
            } catch {
                guard let self else { return }
                removing.remove(key)
                reload()
                Alerts.show(Strings.Compute.actionFailed, Self.words(error), on: self)
            }
        }
    }

    func editConcurrency(_ node: Computer) {
        typealias Text = Strings.Compute
        Task { @MainActor [weak self] in
            guard let self, let typed = await Alerts.prompt(Text.concurrencyPrompt, Text.concurrencyRange(node.concurrencyRange),
                                                            text: "\(node.concurrency)", keyboard: .numberPad, confirmTitle: Text.save, on: self) else { return }
            guard let value = Int(typed.trimmingCharacters(in: .whitespaces)), node.concurrencyRange.contains(value) else {
                return Alerts.show(Text.invalidConcurrency, Text.concurrencyRange(node.concurrencyRange), on: self)
            }
            setConcurrency(value, of: node)
        }
    }

    func setConcurrency(_ value: Int, of node: Computer) {
        guard value != node.concurrency, node.manageable(by: role, userId: viewer), saving.insert(node.id).inserted else { return }
        reload()
        let client = session.client
        Task { @MainActor [weak self] in
            do {
                let saved = try await client.setComputerConcurrency(node.id, value)
                guard let self else { return }
                saving.remove(node.id)
                monitor.settle(saved)
                monitor.refresh()
            } catch {
                guard let self else { return }
                saving.remove(node.id)
                reload()
                Alerts.show(Strings.Compute.actionFailed, Self.words(error), on: self)
            }
        }
    }

    func add() {
        guard let flow = ComputeAddFlow(role: role, client: session.client, added: { [weak self] in self?.monitor.refresh() }) else { return }
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
#endif
