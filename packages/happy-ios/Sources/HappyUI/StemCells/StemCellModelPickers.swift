#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// One paired computer's models and its accounts' usage, read for the
/// composer's pickers, and the pick the home dock holds for new work.
@MainActor
final class StemCellModelState {
    private let client: DirectAgentClient
    private(set) var catalog: StemCellModelCatalog?
    private(set) var usage: [String: StemCellAccountUsage] = [:]
    /// What new work is sent with: picked on the dock before the work exists.
    var dockMode: AgentWire.Mode? {
        didSet {
            guard dockMode != oldValue else { return }
            changed()
            let mode = dockMode
            if let offline { Task { await offline.update { $0.dockMode = mode } } }
        }
    }
    private let offline: StemCellsOfflineFile?
    private var watchers: [UUID: () -> Void] = [:]
    private var loading: Task<Void, Never>?
    private var refreshing: Task<Void, Never>?

    init(client: DirectAgentClient, offline: StemCellsOfflineFile? = nil) {
        self.client = client
        self.offline = offline
    }

    /// The dock's pick, or the computer's default until one is made.
    var newWorkMode: AgentWire.Mode? { dockMode ?? catalog?.defaultMode() }

    func watch(_ watch: @escaping () -> Void) -> StemCellsWatch {
        let id = UUID()
        watchers[id] = watch
        return StemCellsWatch { [weak self] in self?.watchers.removeValue(forKey: id) }
    }

    private func changed() {
        for watcher in watchers.values { watcher() }
    }

    /// Reads the catalog, once at a time: what was kept first, so the
    /// pickers are drawn offline too, then the computer's own.
    func load() {
        guard loading == nil else { return }
        let client = client
        let offline = offline
        loading = Task { [weak self] in
            if self?.catalog == nil, let kept = await offline?.read() {
                let catalog = kept.config.flatMap { StemCellModelCatalog(response: Data($0.utf8)) }
                guard let self else { return }
                if self.catalog == nil, let catalog { self.catalog = catalog; changed() }
                if dockMode == nil, let mode = kept.dockMode { dockMode = mode }
            }
            let read = try? await client.modelCatalogResponse()
            guard let self else { return }
            loading = nil
            guard let read else { return }
            if read.catalog != self.catalog {
                self.catalog = read.catalog
                changed()
            }
            let text = read.text
            if let offline { Task { await offline.update { $0.config = text } } }
        }
    }

    /// The accounts' readings now, then fresher ones for `accounts` once
    /// the computer has asked their services (desktop asks as its menu opens).
    func refreshUsage(_ accounts: [String]) {
        let client = client
        refreshing?.cancel()
        refreshing = Task { [weak self] in
            if let usage = try? await client.accountUsage() { self?.apply(usage) }
            try? await client.refreshAccountUsage(accounts)
            for _ in 0..<3 {
                guard (try? await Task.sleep(for: .seconds(2))) != nil else { return }
                if let usage = try? await client.accountUsage() { self?.apply(usage) }
            }
        }
    }

    private func apply(_ usage: [String: StemCellAccountUsage]) {
        guard usage != self.usage else { return }
        self.usage = usage
        changed()
    }
}

/// The composer's model control as native menus, as desktop's
/// ComposerModelControl: Model, then Effort, each opening its list over the
/// menu. In the model list each service's accounts are a submenu of their
/// own above its models, as desktop's account switch sits in the service's
/// heading. The "+" sheet's permission is a menu of the same kind.
@MainActor
enum StemCellModelPickers {
    enum Kind: String { case model, provider, effort, permission }

    /// The chips' labels for a mode: provider, model, effort.
    static func chips(_ menus: StemCellModelMenus?) -> (provider: String, model: String, effort: String?) {
        guard let menus, !menus.services.isEmpty || menus.current != nil else {
            return ("", Strings.StemCells.modelsNotConfigured, nil)
        }
        let service = menus.selectedService
        let provider = service.map { service in
            service.accounts.count > 1 ? Strings.StemCells.serviceAccount(service.label, menus.selectedAccount?.label ?? service.label) : service.label
        } ?? menus.selection.providerId
        let effort = menus.current.flatMap { $0.efforts.isEmpty ? nil : menus.effort.map(StemCellModelMenus.effortName) }
        return (provider, menus.current?.label ?? menus.selection.modelId, effort)
    }

    /// The card's model control, in its own bar beside send as desktop's
    /// composer has it: the model and its effort, each opening the same
    /// menu. With nothing to list a chip asks for the models again.
    static func configure(_ card: AgentInputCardView, menus: StemCellModelMenus?, usage: [String: StemCellAccountUsage], now: Date = Date()) {
        let labels = chips(menus)
        let menu = menus.map { Self.menu($0, usage: usage, now: now) }
        func chip(_ kind: String, _ value: String) -> AgentInputChipConfiguration {
            AgentInputChipConfiguration(content: .label(value), accessibilityLabel: Strings.StemCells.chipLabel(kind, value), menu: menu, opensPicker: menu == nil)
        }
        card.configuration.permission = nil
        card.configuration.model = chip(Strings.StemCells.model, labels.model)
        card.configuration.effort = labels.effort.map { chip(Strings.StemCells.effort, $0) }
    }

    /// A pick's key: what it changes, then which.
    static func key(_ kind: Kind, _ id: String) -> String { "\(kind.rawValue)\t\(id)" }

    /// Model, with what it is now under it, then Effort the same way.
    static func menu(_ menus: StemCellModelMenus, usage: [String: StemCellAccountUsage], now: Date = Date()) -> AgentInputMenu {
        let labels = chips(menus)
        var rows = [AgentInputMenu.Option(key: Kind.model.rawValue, label: Strings.StemCells.model, subtitle: labels.model, children: modelSections(menus, usage: usage, now: now))]
        if let effort = labels.effort, let efforts = menus.current?.efforts {
            rows.append(.init(key: Kind.effort.rawValue, label: Strings.StemCells.effort, subtitle: effort, children: [.init(options: efforts.map { level in
                .init(key: key(.effort, level), label: StemCellModelMenus.effortName(level), isChecked: level == menus.effort)
            })]))
        }
        return AgentInputMenu(sections: [.init(options: rows)], selectedKey: nil)
    }

    /// The modes a message may run with, from least to most it may do.
    static let permissionModes = ["read_only", "workspace_write", "auto", "full_access"]

    /// The permission the next message runs with, each with what it allows.
    static func permissionMenu(_ menus: StemCellModelMenus) -> AgentInputMenu {
        AgentInputMenu(sections: [.init(options: permissionModes.map { mode in
            .init(key: key(.permission, mode), label: Strings.StemCells.permissionName(mode), subtitle: Strings.StemCells.permissionDetail(mode), isChecked: mode == menus.selection.permissionMode)
        })], selectedKey: nil)
    }

    /// Each service under its name and the account it lists (desktop's
    /// "Claude (Current CLI)"): its accounts, when there is more than one,
    /// then that account's models, the selected one checked; then the
    /// benchmarks link. A notice about the account comes first.
    private static func modelSections(_ menus: StemCellModelMenus, usage: [String: StemCellAccountUsage], now: Date) -> [AgentInputMenu.Section] {
        var sections: [AgentInputMenu.Section] = []
        if let notice = notice(menus) {
            sections.append(.init(options: [.init(key: "notice", label: notice, isDisabled: true)]))
        }
        for service in menus.services {
            let account = service.shown?.id ?? service.account
            var options: [AgentInputMenu.Option] = []
            if service.accounts.count > 1 {
                options.append(.init(key: "\(Kind.provider.rawValue)-menu\t\(service.id)", label: Strings.StemCells.account, subtitle: service.shown?.label, children: [.init(options: service.accounts.map { choice in
                    .init(
                        key: key(.provider, choice.id), label: choice.label, isDisabled: menus.model(on: choice) == nil,
                        subtitle: usageLine(usage[choice.id], now: now), isChecked: choice.id == menus.selection.providerId
                    )
                })]))
            }
            options += (service.shown?.models ?? []).map { model in
                .init(
                    key: key(.model, "\(account)\n\(model.id)"), label: model.label, isDisabled: model.disabled,
                    isChecked: account == menus.selection.providerId && model.id == menus.selection.modelId
                )
            }
            sections.append(.init(title: Strings.StemCells.serviceHeader(service.label, service.shown?.label ?? service.account), options: options))
        }
        // A selection the lists don't offer still names its model, under
        // the notice that says why.
        if let current = menus.current, !sections.contains(where: { $0.options.contains(where: \.isChecked) }) {
            sections.insert(.init(title: chips(menus).provider, options: [
                .init(key: key(.model, "\(menus.selection.providerId)\n\(current.id)"), label: current.label, isDisabled: true, isChecked: true),
            ]), at: notice(menus) == nil ? 0 : 1)
        }
        sections.append(.init(options: [.init(key: "benchmarks", label: Strings.StemCells.latestBenchmarks)]))
        return sections
    }

    private static func notice(_ menus: StemCellModelMenus) -> String? {
        switch menus.notice {
        case .hidden: Strings.StemCells.hiddenAccount
        case .removed(let name): Strings.StemCells.accountRemoved(name)
        case .off(let name): Strings.StemCells.accountOff(name)
        case nil: nil
        }
    }

    /// An account's reading in a line: what is left of its week, or that it
    /// is out, and when it starts over.
    static func usageLine(_ usage: StemCellAccountUsage?, now: Date) -> String? {
        guard let usage else { return nil }
        if usage.limited {
            return usage.limitResets.map { Strings.StemCells.limitResets(Strings.StemCells.dayTime($0, now: now)) } ?? Strings.StemCells.limitReached
        }
        guard let window = usage.shown else { return Strings.StemCells.usageUnknown }
        return Strings.StemCells.usageWindow(Strings.StemCells.window(window.kind), left: window.left, resets: window.resetsAt.map { Strings.StemCells.dayTime($0, now: now) })
    }

    /// What a pick makes the mode; nil leaves it as it is (the benchmarks
    /// link, a key that isn't a pick).
    static func pick(_ key: String, menus: StemCellModelMenus, catalog: StemCellModelCatalog) -> AgentWire.Mode? {
        let parts = key.split(separator: "\t", maxSplits: 1).map(String.init)
        guard parts.count == 2, let kind = Kind(rawValue: parts[0]) else { return nil }
        let id = parts[1]
        let current = menus.selection
        switch kind {
        case .model:
            let parts = id.split(separator: "\n", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { return nil }
            return catalog.select(providerId: parts[0], modelId: parts[1], effort: parts[0] == current.providerId && parts[1] == current.modelId ? current.effort : nil, from: current)
        case .provider:
            guard let account = menus.services.flatMap(\.accounts).first(where: { $0.id == id }), let model = menus.model(on: account) else { return nil }
            return catalog.select(providerId: account.id, modelId: model.id, effort: current.effort, from: current)
        case .effort:
            var mode = current
            mode.effort = id
            return mode
        case .permission:
            guard permissionModes.contains(id) else { return nil }
            var mode = current
            mode.permissionMode = id
            return mode
        }
    }

    static let benchmarks = URL(string: "https://happy.engineering/model-benchmarks")!

    /// A pick from either menu: the benchmarks link opens, anything else
    /// that changes the mode comes back as the new one.
    static func choose(_ key: String, state: StemCellModelState, mode: AgentWire.Mode?, onPick: (AgentWire.Mode) -> Void) {
        if key == "benchmarks" { return UIApplication.shared.open(benchmarks) }
        guard let catalog = state.catalog, let mode else { return }
        let menus = StemCellModelMenus(catalog: catalog, selection: mode)
        if let next = pick(key, menus: menus, catalog: catalog), next != mode { onPick(next) }
    }

    /// A menu opened: the readings of the accounts it lists are asked for
    /// again, as desktop asks as its menu opens.
    static func opened(_ state: StemCellModelState, mode: AgentWire.Mode?) {
        guard let catalog = state.catalog, let mode else { return state.load() }
        state.refreshUsage(listedAccounts(StemCellModelMenus(catalog: catalog, selection: mode)))
    }

    /// The accounts with a reading in the menu: those of a service that has more than one.
    static func listedAccounts(_ menus: StemCellModelMenus) -> [String] {
        menus.services.filter { $0.accounts.count > 1 }.flatMap(\.accounts).map(\.id)
    }
}
#endif
