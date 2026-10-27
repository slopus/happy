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

/// The composer's model control as desktop's `ComposerModelControl`, with
/// the phone's one difference: each chip opens its own list (the model chip
/// the models, the effort chip the efforts) rather than a menu of both. A
/// service's heading opens its accounts, stacked over the models in place.
/// The "+" sheet's permission stays a native menu.
@MainActor
enum StemCellModelPickers {
    enum Kind: String { case model, provider, effort, permission }
    typealias Line = StemCellPickerContent.Line

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
    /// composer has it: the model and its effort, each opening its own
    /// list. With nothing to list a press asks for the models again.
    static func configure(_ card: AgentInputCardView, menus: StemCellModelMenus?) {
        let labels = chips(menus)
        func chip(_ kind: String, _ value: String) -> AgentInputChipConfiguration {
            AgentInputChipConfiguration(content: .label(value), accessibilityLabel: Strings.StemCells.chipLabel(kind, value), menu: nil, opensPicker: true)
        }
        card.configuration.permission = nil
        card.configuration.model = chip(Strings.StemCells.model, labels.model)
        card.configuration.effort = labels.effort.map { chip(Strings.StemCells.effort, $0) }
    }

    /// A pick's key: what it changes, then which.
    static func key(_ kind: Kind, _ id: String) -> String { "\(kind.rawValue)\t\(id)" }

    /// The modes a message may run with, from least to most it may do.
    static let permissionModes = ["read_only", "workspace_write", "auto", "full_access"]

    /// The permission the next message runs with, each with what it allows.
    static func permissionMenu(_ menus: StemCellModelMenus) -> AgentInputMenu {
        AgentInputMenu(sections: [.init(options: permissionModes.map { mode in
            .init(key: key(.permission, mode), label: Strings.StemCells.permissionName(mode), subtitle: Strings.StemCells.permissionDetail(mode), isChecked: mode == menus.selection.permissionMode)
        })], selectedKey: nil)
    }

    // MARK: Lists

    /// The model list: a notice about the account first, then each service
    /// under its heading (its name, the account it lists, that account's
    /// windows, and a chevron to its accounts), a hairline between them,
    /// the selected model checked; under them, the benchmarks link.
    static func modelContent(_ menus: StemCellModelMenus, usage: [String: StemCellAccountUsage]) -> StemCellPickerContent {
        var lines: [Line] = []
        func block() { if !lines.isEmpty { lines.append(.separator) } }
        if let notice = notice(menus) { lines.append(.notice(notice, warning: menus.notice != .hidden)) }
        // A selection the lists don't offer still names its model, under
        // the notice that says why.
        let listed = menus.services.contains { service in
            service.shown?.id == menus.selection.providerId && service.shown?.models.contains { $0.id == menus.selection.modelId } == true
        }
        if let current = menus.current, !listed {
            block()
            let provider = chips(menus).provider
            lines.append(.heading(service: provider, account: nil, gauges: [], opens: nil, label: provider))
            lines.append(.option(key: key(.model, "\(menus.selection.providerId)\n\(current.id)"), label: current.label, checked: true, disabled: true, gauge: nil))
        }
        for service in menus.services {
            block()
            let account = service.shown
            let windows = account.flatMap { usage[$0.id] }.map(Self.windows) ?? []
            let gauges = windows.map { gauge($0, blocked: $0.blocking) }
            let label = Strings.StemCells.headingLabel(service.label, account?.label ?? service.account, windows.map { Strings.StemCells.windowLeft(Strings.StemCells.window($0.kind), $0.left) })
            lines.append(.heading(service: service.label, account: account?.label, gauges: gauges, opens: service.accounts.isEmpty ? nil : service.id, label: label))
            for model in account?.models ?? [] {
                lines.append(.option(
                    key: key(.model, "\(account?.id ?? service.account)\n\(model.id)"), label: model.label,
                    checked: account?.id == menus.selection.providerId && model.id == menus.selection.modelId,
                    disabled: model.disabled, gauge: nil
                ))
            }
        }
        return StemCellPickerContent(
            id: "stem-picker-models", label: Strings.StemCells.selectModel, lines: lines,
            footer: [.separator, .link(key: "benchmarks", label: Strings.StemCells.latestBenchmarks)],
            minWidth: StemCellPickerMetrics.modelsMinWidth, maxWidth: StemCellPickerMetrics.modelsMaxWidth
        )
    }

    /// The selected model's efforts, least to most, the current one checked.
    static func effortContent(_ menus: StemCellModelMenus) -> StemCellPickerContent {
        let current = menus.effort
        return StemCellPickerContent(
            id: "stem-picker-efforts", label: Strings.StemCells.selectEffort,
            lines: (menus.current?.efforts ?? []).map { level in
                .option(key: key(.effort, level), label: StemCellModelMenus.effortName(level), checked: level == current, disabled: false, gauge: nil)
            },
            minWidth: StemCellPickerMetrics.effortsMinWidth, maxWidth: StemCellPickerMetrics.modelsMaxWidth
        )
    }

    /// A service's accounts, the one it lists checked, each with what is
    /// left of its week; under them, that account's windows.
    static func accountsContent(_ service: StemCellModelMenus.Service, menus: StemCellModelMenus, usage: [String: StemCellAccountUsage], now: Date = Date()) -> StemCellPickerContent {
        var lines: [Line] = service.accounts.map { account in
            let reading = usage[account.id]
            return .option(
                key: key(.provider, account.id), label: account.label,
                checked: account.id == service.shown?.id, disabled: menus.model(on: account) == nil,
                gauge: reading.flatMap { reading in reading.shown.map { gauge($0, blocked: reading.limited) } }
            )
        }
        if let shown = service.shown {
            lines += [.separator, .windows(details(usage[shown.id], now: now))]
        }
        return StemCellPickerContent(
            id: "stem-picker-accounts", label: Strings.StemCells.accountsOf(service.label), lines: lines,
            minWidth: StemCellPickerMetrics.accountsMinWidth, maxWidth: StemCellPickerMetrics.accountsMaxWidth
        )
    }

    private static func windows(_ usage: StemCellAccountUsage) -> [StemCellAccountUsage.Window] {
        [usage.week, usage.session].compactMap { $0 }
    }

    private static func gauge(_ window: StemCellAccountUsage.Window, blocked: Bool) -> StemCellPickerContent.Gauge {
        .init(text: Strings.StemCells.usageLeft(window.left), left: window.left, tone: StemCellAccountUsage.tone(left: window.left, blocked: blocked))
    }

    /// `ComposerModelAccountUsageDetails`: the week (leading), then the
    /// session, each with when it starts over and what is left; then how
    /// current the numbers are.
    static func details(_ usage: StemCellAccountUsage?, now: Date) -> [StemCellPickerContent.Window] {
        var lines: [StemCellPickerContent.Window] = []
        let windows = usage.map(Self.windows) ?? []
        for window in windows {
            var line = StemCellPickerContent.Window(
                label: Strings.StemCells.window(window.kind),
                resets: window.resetsAt.map { Strings.StemCells.resets(Strings.StemCells.dayTime($0, now: now)) },
                gauge: gauge(window, blocked: window.blocking), primary: window.kind == .week
            )
            lines.append(line)
        }
        if windows.isEmpty { lines.append(.init(label: Strings.StemCells.usageUnknown)) }
        guard let usage else { return lines }
        if usage.limited {
            lines.append(.init(label: usage.limitResets.map { Strings.StemCells.limitResets(Strings.StemCells.dayTime($0, now: now)) } ?? Strings.StemCells.limitReached, critical: true))
        }
        if usage.refreshing {
            lines.append(.init(label: Strings.StemCells.updating))
        } else if usage.refreshError != nil {
            lines.append(.init(label: usage.updatedAt.map { Strings.StemCells.updatedFailed(Strings.StemCells.clock($0, now: now)) } ?? Strings.StemCells.couldntRefresh))
        } else if let updated = usage.updatedAt {
            lines.append(.init(label: Strings.StemCells.updated(Strings.StemCells.age(updated, now: now))))
        }
        // A window measured well before the rest says when it is from.
        let newest = max(usage.updatedAt ?? .distantPast, windows.compactMap(\.capturedAt).max() ?? .distantPast)
        for window in windows {
            if let captured = window.capturedAt, newest.timeIntervalSince(captured) > 600 {
                lines.append(.init(label: Strings.StemCells.windowAsOf(Strings.StemCells.window(window.kind), Strings.StemCells.clock(captured, now: now))))
            }
        }
        return lines
    }

    private static func notice(_ menus: StemCellModelMenus) -> String? {
        switch menus.notice {
        case .hidden: Strings.StemCells.hiddenAccount
        case .removed(let name): Strings.StemCells.accountRemoved(name)
        case .off(let name): Strings.StemCells.accountOff(name)
        case nil: nil
        }
    }

    // MARK: Picks

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

    /// A pick from a list or the "+" sheet's menu: the benchmarks link
    /// opens, anything else that changes the mode comes back as the new one.
    static func choose(_ key: String, state: StemCellModelState, mode: AgentWire.Mode?, onPick: (AgentWire.Mode) -> Void) {
        if key == "benchmarks" { return UIApplication.shared.open(benchmarks) }
        guard let catalog = state.catalog, let mode else { return }
        let menus = StemCellModelMenus(catalog: catalog, selection: mode)
        if let next = pick(key, menus: menus, catalog: catalog), next != mode { onPick(next) }
    }

    /// A list opened: the readings of the accounts it lists are asked for
    /// again, as desktop asks as its menu opens.
    static func opened(_ state: StemCellModelState, mode: AgentWire.Mode?) {
        guard let catalog = state.catalog, let mode else { return state.load() }
        state.refreshUsage(listedAccounts(StemCellModelMenus(catalog: catalog, selection: mode)))
    }

    /// `composerModelListedAccounts`: every account the lists name.
    static func listedAccounts(_ menus: StemCellModelMenus) -> [String] {
        var listed = menus.services.flatMap(\.accounts).map(\.id)
        if !listed.contains(menus.selection.providerId) { listed.append(menus.selection.providerId) }
        return listed
    }
}

/// One chip's list open over the screen, and a service's accounts stacked
/// over it: placed over the chip, opened on the picked line, redrawn as the
/// selection and the readings change, closed by a pick or a touch outside.
@MainActor
final class StemCellPickerPresenter {
    enum List { case model, effort }

    let list: List
    private weak var card: AgentInputCardView?
    private let overlay = StemCellPickerOverlay()
    private var menus: StemCellModelMenus
    private var usage: [String: StemCellAccountUsage]
    /// The service whose accounts are stacked over the models.
    private var accounts: String?
    /// An account was switched: the models open again on the one picked.
    private var reopens = false
    private let onChoose: (String) -> Void
    var onClose: (() -> Void)?
    /// Where the screen's chrome ends, in the host's space: a panel stays
    /// under it. The safe area's top when nil.
    var top: (() -> CGFloat)?

    init(list: List, card: AgentInputCardView, menus: StemCellModelMenus, usage: [String: StemCellAccountUsage], onChoose: @escaping (String) -> Void) {
        self.list = list
        self.card = card
        self.menus = menus
        self.usage = usage
        self.onChoose = onChoose
        overlay.onOutside = { [weak self] in self?.outside() }
        overlay.onLayout = { [weak self] in self?.place(opening: false) }
    }

    var isOpen: Bool { overlay.superview != nil }

    /// Over everything in `host`, the list's first frame on its picked line.
    func show(in host: UIView) {
        overlay.frame = host.bounds
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        host.addSubview(overlay)
        let panel = makePanel(level: 0)
        overlay.push(panel)
        place(opening: true)
        overlay.grow(panel)
        UIAccessibility.post(notification: .screenChanged, argument: panel)
    }

    func update(menus: StemCellModelMenus?, usage: [String: StemCellAccountUsage]) {
        guard let menus else { return close(animated: true) }
        guard menus != self.menus || usage != self.usage else { return }
        self.menus = menus
        self.usage = usage
        if list == .effort, menus.current?.efforts.isEmpty != false { return close(animated: true) }
        place(opening: false)
    }

    /// The chip moved (the keyboard, the card growing): the panels follow.
    func follow() {
        guard isOpen else { return }
        place(opening: false)
    }

    func close(animated: Bool) {
        guard isOpen else { return }
        let overlay = overlay
        overlay.isUserInteractionEnabled = false
        while overlay.panels.count > 1 { overlay.pop(animated: animated) }
        overlay.pop(animated: animated)
        if animated {
            // Once the panels' glass has dissolved.
            DispatchQueue.main.asyncAfter(deadline: .now() + StemCellPickerOverlay.popDuration) { overlay.removeFromSuperview(); overlay.isUserInteractionEnabled = true }
        } else {
            overlay.removeFromSuperview()
            overlay.isUserInteractionEnabled = true
        }
        onClose?()
    }

    private func makePanel(level: Int) -> StemCellPickerPanelView {
        let panel = StemCellPickerPanelView()
        panel.onTap = { [weak self] line in self?.tapped(line, level: level) }
        panel.accessibilityViewIsModal = true
        return panel
    }

    private func baseContent() -> StemCellPickerContent {
        switch list {
        case .model: StemCellModelPickers.modelContent(menus, usage: usage)
        case .effort: StemCellModelPickers.effortContent(menus)
        }
    }

    /// The panels where they stand now: the list over its chip, the
    /// accounts over the list. `opening` the list, it stands on its picked
    /// line; `stacking` the accounts, they stand on theirs.
    private func place(opening: Bool, stacking: Bool = false) {
        guard let card, let base = overlay.panels.first else { return }
        let top = max(overlay.safeAreaInsets.top, top?() ?? 0)
        let bounds = CGRect(x: 0, y: top, width: overlay.bounds.width, height: overlay.bounds.height - top)
        let anchor = card.chipFrame(list == .model ? .model : .effort, in: overlay) ?? card.convert(card.bounds, to: overlay)
        let content = baseContent()
        let layout = Self.layout(content, in: bounds) { items, footer, width in
            StemCellPickerPanelLayout(items: items, footer: footer, width: width, over: anchor, in: bounds, selected: content.selected)
        }
        base.apply(content, layout: layout, opening: opening || reopens)
        reopens = false
        guard overlay.panels.count > 1 else { return }
        guard let id = accounts, let service = menus.services.first(where: { $0.id == id }) else { return closeAccounts() }
        let stacked = StemCellModelPickers.accountsContent(service, menus: menus, usage: usage)
        let stackedLayout = Self.layout(stacked, in: bounds) { items, footer, width in
            StemCellPickerPanelLayout(items: items, footer: footer, width: width, stackedOver: layout.frame, in: bounds, selected: stacked.selected)
        }
        overlay.panels[1].apply(stacked, layout: stackedLayout, opening: stacking)
    }

    private static func layout(_ content: StemCellPickerContent, in bounds: CGRect, _ make: ([StemCellPickerPanelLayout.Item], [StemCellPickerPanelLayout.Item], CGFloat) -> StemCellPickerPanelLayout) -> StemCellPickerPanelLayout {
        let width = min(StemCellPickerType.panelWidth(content), bounds.width - 2 * StemCellPickerMetrics.margin)
        return make(content.lines.map { StemCellPickerType.item($0, width: width) }, content.footer.map { StemCellPickerType.item($0, width: width) }, width)
    }

    private func tapped(_ line: StemCellPickerContent.Line, level: Int) {
        switch line {
        case .heading(_, _, _, let opens?, _):
            openAccounts(opens)
        case .option(let key, _, _, _, _):
            StemCellsHaptics.play(.pick)
            if level > 0 {
                // An account is not the last choice: the models stay, on
                // that account's, open on the one it switched to.
                reopens = true
                closeAccounts()
                onChoose(key)
            } else {
                onChoose(key)
                close(animated: true)
            }
        case .link(let key, _):
            onChoose(key)
            close(animated: true)
        default:
            break
        }
    }

    private func openAccounts(_ service: String) {
        if accounts == service { return closeAccounts() }
        if overlay.panels.count > 1 { overlay.pop(animated: false) }
        accounts = service
        let panel = makePanel(level: 1)
        overlay.push(panel)
        // The list stays where it was scrolled.
        place(opening: false, stacking: true)
        overlay.grow(panel)
        overlay.panels.first?.accessibilityElementsHidden = true
        UIAccessibility.post(notification: .screenChanged, argument: panel)
    }

    private func closeAccounts() {
        accounts = nil
        guard overlay.panels.count > 1 else { return }
        overlay.pop(animated: true)
        overlay.panels.first?.accessibilityElementsHidden = false
        UIAccessibility.post(notification: .screenChanged, argument: overlay.panels.first)
    }

    private func outside() {
        if overlay.panels.count > 1 { closeAccounts() } else { close(animated: true) }
    }
}
#endif
