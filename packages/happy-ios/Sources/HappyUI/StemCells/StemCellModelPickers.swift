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

    /// The sheet closed: no more readings.
    func stopRefreshing() {
        refreshing?.cancel()
        refreshing = nil
    }

    private func apply(_ usage: [String: StemCellAccountUsage]) {
        guard usage != self.usage else { return }
        self.usage = usage
        changed()
    }
}

/// The composer's three pickers on a phone. Desktop's ComposerModelControl
/// is one pill whose menu nests the accounts in the model list and the
/// effort as its second row; here Model, Provider and Effort are each a
/// chip of their own that opens a sheet.
@MainActor
enum StemCellModelPickers {
    enum Kind: String { case model, provider, effort }

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

    /// The settings desktop's model control lists (ComposerModelControl.tsx's
    /// Model and Effort rows), with the provider after them: each a name, its
    /// current value and the sheet it opens. Nil where there is nothing to pick.
    static func settings(_ menus: StemCellModelMenus?) -> [(kind: Kind, name: String, value: String)] {
        guard menus != nil else { return [] }
        let labels = chips(menus)
        var rows: [(kind: Kind, name: String, value: String)] = [(.model, Strings.StemCells.model, labels.model)]
        if let effort = labels.effort { rows.append((.effort, Strings.StemCells.effort, effort)) }
        if !labels.provider.isEmpty { rows.append((.provider, Strings.StemCells.provider, labels.provider)) }
        return rows
    }

    /// The card's model control, in its own bar beside send as desktop's
    /// composer has it: the model and its effort, each opening the same
    /// short list of settings. No provider chip by the add button.
    static func configure(_ card: AgentInputCardView, menus: StemCellModelMenus?) {
        let labels = chips(menus)
        let rows = settings(menus)
        let menu = rows.isEmpty ? nil : AgentInputMenu(sections: rows.map { row in
            AgentInputMenu.Section(title: row.name, options: [AgentInputMenu.Option(key: row.kind.rawValue, label: row.value)])
        }, selectedKey: nil)
        // With nothing to list a chip opens the model sheet, which asks again.
        func chip(_ kind: String, _ value: String) -> AgentInputChipConfiguration {
            AgentInputChipConfiguration(content: .label(value), accessibilityLabel: Strings.StemCells.chipLabel(kind, value), menu: menu, opensPicker: menu == nil)
        }
        card.configuration.permission = nil
        card.configuration.model = chip(Strings.StemCells.model, labels.model)
        card.configuration.effort = labels.effort.map { chip(Strings.StemCells.effort, $0) }
    }

    static func content(_ kind: Kind, menus: StemCellModelMenus, usage: [String: StemCellAccountUsage], now: Date = Date()) -> StemCellPickerContent {
        switch kind {
        case .model: modelContent(menus)
        case .provider: providerContent(menus, usage: usage, now: now)
        case .effort: effortContent(menus)
        }
    }

    /// Each service's models on the account it lists, under the service and
    /// that account (desktop's "Claude (Current CLI)"), the selected one
    /// checked; then the benchmarks link.
    private static func modelContent(_ menus: StemCellModelMenus) -> StemCellPickerContent {
        var sections = menus.services.map { service in
            StemCellPickerContent.Section(
                header: Strings.StemCells.serviceHeader(service.label, service.shown?.label ?? service.account),
                rows: (service.shown?.models ?? []).map { model in
                    let account = service.shown?.id ?? service.account
                    return .init(
                        id: "\(account)\n\(model.id)", title: model.label,
                        checked: account == menus.selection.providerId && model.id == menus.selection.modelId,
                        disabled: model.disabled
                    )
                }
            )
        }
        // A selection the lists don't offer still names its model.
        if let current = menus.current, !sections.contains(where: { $0.rows.contains(where: \.checked) }) {
            sections.insert(.init(header: menus.selection.providerId, rows: [
                .init(id: "\(menus.selection.providerId)\n\(current.id)", title: current.label, checked: true, disabled: true),
            ]), at: 0)
        }
        return StemCellPickerContent(
            title: Strings.StemCells.model, notice: notice(menus), sections: sections,
            footer: .init(id: "benchmarks", title: Strings.StemCells.latestBenchmarks)
        )
    }

    /// Every account under its service, with what is left of its week and
    /// its readings under its name.
    private static func providerContent(_ menus: StemCellModelMenus, usage: [String: StemCellAccountUsage], now: Date) -> StemCellPickerContent {
        StemCellPickerContent(
            title: Strings.StemCells.provider, notice: notice(menus),
            sections: menus.services.map { service in
                .init(header: service.label, rows: service.accounts.map { account in
                    let reading = usage[account.id]
                    return .init(
                        id: account.id, title: account.label, subtitle: usageLines(reading, now: now),
                        checked: account.id == menus.selection.providerId,
                        disabled: menus.model(on: account) == nil,
                        gauge: reading.flatMap { reading in
                            reading.shown.map { window in
                                .init(text: Strings.StemCells.usageLeft(window.left), left: window.left, tone: StemCellAccountUsage.tone(left: window.left, blocked: reading.limited))
                            }
                        }
                    )
                })
            }
        )
    }

    /// The model's efforts, least to most.
    private static func effortContent(_ menus: StemCellModelMenus) -> StemCellPickerContent {
        let current = menus.effort
        return StemCellPickerContent(
            title: Strings.StemCells.effort, notice: nil,
            sections: [.init(rows: (menus.current?.efforts ?? []).map { level in
                .init(id: level, title: StemCellModelMenus.effortName(level), checked: level == current)
            })]
        )
    }

    private static func notice(_ menus: StemCellModelMenus) -> StemCellPickerContent.Notice? {
        switch menus.notice {
        case .hidden: .quiet(Strings.StemCells.hiddenAccount)
        case .removed(let name): .warning(Strings.StemCells.accountRemoved(name))
        case .off(let name): .warning(Strings.StemCells.accountOff(name))
        case nil: nil
        }
    }

    /// `ComposerModelAccountUsageDetails` as lines: each window with when it
    /// starts over, then how current the numbers are.
    static func usageLines(_ usage: StemCellAccountUsage?, now: Date) -> String? {
        guard let usage else { return nil }
        var lines: [String] = []
        for window in [usage.week, usage.session].compactMap({ $0 }) {
            lines.append(Strings.StemCells.usageWindow(Strings.StemCells.window(window.kind), left: window.left, resets: window.resetsAt.map { Strings.StemCells.dayTime($0, now: now) }))
        }
        if lines.isEmpty { lines.append(Strings.StemCells.usageUnknown) }
        if usage.limited {
            lines.append(usage.limitResets.map { Strings.StemCells.limitResets(Strings.StemCells.dayTime($0, now: now)) } ?? Strings.StemCells.limitReached)
        }
        if usage.refreshing {
            lines.append(Strings.StemCells.updating)
        } else if usage.refreshError != nil {
            lines.append(usage.updatedAt.map { Strings.StemCells.updatedFailed(Strings.StemCells.clock($0, now: now)) } ?? Strings.StemCells.couldntRefresh)
        } else if let updated = usage.updatedAt {
            lines.append(Strings.StemCells.updated(Strings.StemCells.age(updated, now: now)))
        }
        // A window measured well before the rest says when it is from.
        let windows = [usage.week, usage.session].compactMap { $0 }
        let newest = max(usage.updatedAt ?? .distantPast, windows.compactMap(\.capturedAt).max() ?? .distantPast)
        for window in windows {
            if let captured = window.capturedAt, newest.timeIntervalSince(captured) > 600 {
                lines.append(Strings.StemCells.windowAsOf(Strings.StemCells.window(window.kind), Strings.StemCells.clock(captured, now: now)))
            }
        }
        return lines.joined(separator: "\n")
    }

    /// What a pick in `kind` makes the mode; nil leaves it as it is (the
    /// benchmarks link).
    static func pick(_ id: String, kind: Kind, menus: StemCellModelMenus, catalog: StemCellModelCatalog) -> AgentWire.Mode? {
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
        }
    }

    static let benchmarks = URL(string: "https://happy.engineering/model-benchmarks")!

    /// Opens `kind`'s sheet over `host`; a pick comes back as the new mode.
    static func present(_ kind: Kind, from host: UIViewController, state: StemCellModelState, mode: AgentWire.Mode, onPick: @escaping (AgentWire.Mode) -> Void) {
        guard let catalog = state.catalog else {
            state.load()
            return
        }
        let menus = StemCellModelMenus(catalog: catalog, selection: mode)
        if kind == .provider { state.refreshUsage(menus.services.flatMap(\.accounts).map(\.id)) }
        var watch: StemCellsWatch?
        let sheet = StemCellPickerViewController(content: content(kind, menus: menus, usage: state.usage)) { id in
            if id == "benchmarks" {
                UIApplication.shared.open(benchmarks)
                return
            }
            if let next = pick(id, kind: kind, menus: menus, catalog: catalog), next != mode { onPick(next) }
        }
        // Usage read while it is open lands in it.
        watch = state.watch { [weak sheet] in
            sheet?.update(content(kind, menus: menus, usage: state.usage))
        }
        sheet.onClose = {
            watch?.invalidate()
            state.stopRefreshing()
        }
        host.present(sheet, animated: true)
    }
}
#endif
