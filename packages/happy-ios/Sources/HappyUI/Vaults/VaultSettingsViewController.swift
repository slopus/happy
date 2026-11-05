#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit
import UltraView

/// What a vault's settings slots derive from.
struct VaultSettingsInput: Sendable {
    var settings: VaultSettings?
    /// Custom picked over a stored preset: its rules show to be edited.
    var customShown = false
    var width: CGFloat = 0
    var maxWidth: CGFloat = .greatestFiniteMagnitude
    var scale: CGFloat = 1
    var displayScale: CGFloat = 2
    var dark = false
    var words: Strings.Artifacts.DateWords
}

/// A vault's retention, the same on every client: the presets, Time
/// Machine the default, the stored policy shown as the preset it matches
/// or as Custom with its four rules to edit; pinned versions always kept;
/// then how long the Trash keeps items, which a preset leaves as it is.
/// A choice is sent at once and shows before the computer answers; one it
/// refuses goes back, with why.
final class VaultSettingsViewController: UIViewController {
    private let session: Session
    private let surfaceId: String
    private let library: VaultLibrary
    let list = CardListView()
    private var pipeline: ApplyPipeline<VaultSettingsInput, Applied, Output>?
    private var following: Task<Void, Never>?
    private(set) var settings: VaultSettings?
    private var customShown = false

    /// The Trash times offered; a stored one not among them shows too.
    nonisolated static let trashChoices: [Int?] = [7, 30, 90, 365, nil]

    struct Applied: Sendable {
        var items: [String: CardItem] = [:]
        var order: [String] = []
        var counter: UInt64 = 0
    }

    struct Output: Sendable {
        var items: [CardItem]
        var settings: VaultSettings?
        var width: CGFloat
        var replan: @Sendable (CGFloat) -> [CardItem]
    }

    init(session: Session, surfaceId: String) {
        self.session = session
        self.surfaceId = surfaceId
        library = session.engine.vaults
        super.init(nibName: nil, bundle: nil)
        title = Strings.Vaults.settingsTitle
        navigationItem.largeTitleDisplayMode = .never
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    deinit {
        following?.cancel()
        pipeline?.cancel()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        followsTextSize()
        view.backgroundColor = UIColor(Palette.groupedGround)
        view.accessibilityIdentifier = "vault-settings"
        list.accessibilityIdentifier = "vault-settings-list"
        view.addSubview(list)
        HeaderBar.edge(list.edge, in: self)
        list.onSelect = { [weak self] id in self?.select(id) }
        let pipeline = ApplyPipeline<VaultSettingsInput, Applied, Output>(
            input: currentInput(),
            state: Applied(),
            derive: { input, applied in Self.derive(input, applied: applied) },
            apply: { [weak self] output in self?.show(output) ?? false }
        )
        self.pipeline = pipeline
        let library = library, surfaceId = surfaceId
        following = Task { [weak pipeline] in
            let states = await library.settingsStates(surfaceId)
            pipeline?.follow(ifChanged: states) { input, settings in
                guard input.settings != settings else { return false }
                input.settings = settings
                return true
            }
        }
        registerForTraitChanges(UIView.textSizeTraits + [UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.updateInput()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        list.maxWidth = ContentWidth.maxWidth
        list.frame = view.bounds
        let safe = view.safeAreaInsets
        list.setInsets(UIEdgeInsets(top: safe.top + CardListMetrics.contentTop, left: 0, bottom: safe.bottom + CardListMetrics.contentBottom, right: 0))
        updateInput()
    }

    private func currentInput() -> VaultSettingsInput {
        var input = VaultSettingsInput(words: .current)
        input.customShown = customShown
        input.width = list.contentWidth
        input.maxWidth = list.maxWidth
        input.scale = traitCollection.textEnvironment?.scale.multiplier ?? 1
        input.displayScale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 2
        input.dark = traitCollection.userInterfaceStyle == .dark
        return input
    }

    private func updateInput() {
        let next = currentInput()
        pipeline?.update { input in
            input.customShown = next.customShown
            input.width = next.width
            input.maxWidth = next.maxWidth
            input.scale = next.scale
            input.displayScale = next.displayScale
            input.dark = next.dark
            input.words = next.words
        }
    }

    // MARK: Derivation

    nonisolated static func derive(_ input: VaultSettingsInput, applied: Applied) -> (output: Output, state: Applied)? {
        var counter = applied.counter
        let made = CardItems.revise(items(input), previous: applied.items, counter: &counter)
        let order = made.map(\.id)
        guard order != applied.order || made.contains(where: { applied.items[$0.id]?.revision != $0.revision }) else { return nil }
        let replan: @Sendable (CGFloat) -> [CardItem] = { width in
            var input = input
            input.width = width
            return items(input)
        }
        return (Output(items: made, settings: input.settings, width: input.width, replan: replan),
                Applied(items: Dictionary(made.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }), order: order, counter: counter))
    }

    nonisolated static func presetTitle(_ preset: VaultRetentionPreset) -> String {
        switch preset {
        case .timeMachine: "\(Strings.Vaults.presetTimeMachine) · \(Strings.Vaults.presetDefault)"
        case .keepEverything: Strings.Vaults.presetKeepEverything
        case .lastTen: Strings.Vaults.presetLastTen
        case .custom: Strings.Vaults.presetCustom
        }
    }

    nonisolated static func presetDetail(_ preset: VaultRetentionPreset) -> String {
        switch preset {
        case .timeMachine: Strings.Vaults.presetTimeMachineDetail
        case .keepEverything: Strings.Vaults.presetKeepEverythingDetail
        case .lastTen: Strings.Vaults.presetLastTenDetail
        case .custom: Strings.Vaults.presetCustomDetail
        }
    }

    nonisolated static func items(_ input: VaultSettingsInput) -> [CardItem] {
        guard input.width > 0 else { return [] }
        func note(_ id: String, _ text: String) -> CardItem {
            CardItems.note(id, text, width: input.width, maxWidth: input.maxWidth, scale: input.scale, dark: input.dark, displayScale: input.displayScale)
        }
        func heading(_ id: String, _ text: String, afterCard: Bool) -> CardItem {
            CardItems.heading(id, text, width: input.width, maxWidth: input.maxWidth, afterCard: afterCard, dark: input.dark, displayScale: input.displayScale)
        }
        guard let settings = input.settings else { return [note("settings:note", Strings.Vaults.settingsLoading)] }
        var list = VaultListInput(words: input.words)
        list.width = input.width
        list.maxWidth = input.maxWidth
        list.scale = input.scale
        list.displayScale = input.displayScale
        list.dark = input.dark
        // Rows draw a tile of their own; this one names nothing.
        let blank = VaultEntry(id: "", surfaceId: settings.surfaceId, parentId: nil, name: "", kind: .folder)
        func choice(_ id: String, _ title: String, _ detail: String?, chosen: Bool, place: CardPlace) -> CardItem {
            let look: (icon: Icon, ink: ColorToken, fill: ColorToken) = chosen
                ? (.ionicons("checkmark-circle"), Palette.textLink, Palette.tileBlueFill)
                : (.ionicons("ellipse-outline"), Palette.settingsSecondary, Palette.groupedSeparator)
            var item = VaultListItems.row(id: id, entry: blank, title: title, subtitle: detail ?? "", place: place, waiting: false, input: list, subtitleLines: 2, look: look)
            item.accessibilityValue = [detail, chosen ? Strings.Vaults.selected : nil].compactMap { $0 }.joined(separator: ", ")
            return item
        }
        func value(_ id: String, _ title: String, _ value: String, place: CardPlace, icon: String = "create-outline") -> CardItem {
            VaultListItems.row(id: id, entry: blank, title: title, subtitle: value, place: place, waiting: false, input: list,
                               look: (.ionicons(icon), Palette.tileBlue, Palette.tileBlueFill))
        }
        let retention = settings.retention
        let stored = retention.preset
        let shown: VaultRetentionPreset = input.customShown ? .custom : stored
        var items: [CardItem] = [heading("settings:versions", Strings.Vaults.keepVersions, afterCard: false)]
        let presets = VaultRetentionPreset.allCases
        for (preset, place) in zip(presets, CardPlace.run(presets.count)) {
            items.append(choice("p:\(preset.rawValue)", presetTitle(preset), presetDetail(preset), chosen: preset == shown, place: place))
        }
        items.append(note("settings:pinned", Strings.Vaults.pinnedNote))
        if shown == .custom {
            items.append(heading("settings:rules", Strings.Vaults.rules, afterCard: true))
            var rows: [(String, String, String, String)] = [("r:keepAll", Strings.Vaults.keepAllFor, Strings.Vaults.days(retention.keepAllDays), "create-outline")]
            for (index, tier) in retention.thinning.enumerated() {
                rows.append(("r:tier:\(index)", Strings.Vaults.thinAfter, Strings.Vaults.tier(tier.afterDays, tier.everyDays), "create-outline"))
            }
            if retention.thinning.count < VaultRetention.Limits.tiers { rows.append(("r:add", Strings.Vaults.addTier, "", "add-circle-outline")) }
            rows.append(("r:max", Strings.Vaults.maxVersions, retention.maxVersions.map(Strings.Vaults.versionsCount) ?? Strings.Vaults.noLimit, "create-outline"))
            rows.append(("r:age", Strings.Vaults.maxAge, retention.maxAgeDays.map(Strings.Vaults.days) ?? Strings.Vaults.noLimit, "create-outline"))
            for (row, place) in zip(rows, CardPlace.run(rows.count)) { items.append(value(row.0, row.1, row.2, place: place, icon: row.3)) }
        }
        items.append(heading("settings:trash", Strings.Vaults.trashDuration, afterCard: true))
        var choices = trashChoices
        if !choices.contains(retention.trashDays) { choices.insert(retention.trashDays, at: choices.count - 1) }
        for (days, place) in zip(choices, CardPlace.run(choices.count)) {
            items.append(choice("t:\(days.map(String.init) ?? "none")", days.map(Strings.Vaults.days) ?? Strings.Vaults.forever, nil, chosen: days == retention.trashDays, place: place))
        }
        items.append(note("settings:trashNote", Strings.Vaults.trashKept(retention.trashDays)))
        return items
    }

    private func show(_ output: Output) -> Bool {
        guard output.width == list.contentWidth else { return false }
        settings = output.settings
        list.apply(output.items, animated: true, replan: output.replan)
        return true
    }

    // MARK: Choices

    private func select(_ id: String) {
        guard let retention = settings?.retention else { return }
        if id.hasPrefix("p:"), let preset = VaultRetentionPreset(rawValue: String(id.dropFirst(2))) {
            customShown = preset == .custom
            updateInput()
            if preset != .custom, preset != retention.preset { save(retention.applying(preset)) }
            return
        }
        if id.hasPrefix("t:") {
            var next = retention
            next.trashDays = Int(id.dropFirst(2))
            save(next)
            return
        }
        switch id {
        case "r:keepAll":
            askNumber(Strings.Vaults.keepAllFor, current: retention.keepAllDays, range: VaultRetention.Limits.days, allowsNone: false) { [weak self] value in
                var next = retention
                next.keepAllDays = value ?? 0
                self?.saveCustom(next)
            }
        case "r:add":
            let after = (retention.thinning.last?.afterDays ?? retention.keepAllDays) + 30
            askTier(VaultRetention.Tier(afterDays: after, everyDays: 7), removable: false) { [weak self] tier in
                var next = retention
                if let tier { next.thinning.append(tier) }
                self?.saveCustom(next)
            }
        case "r:max":
            askNumber(Strings.Vaults.maxVersions, current: retention.maxVersions, range: VaultRetention.Limits.maxVersions, allowsNone: true) { [weak self] value in
                var next = retention
                next.maxVersions = value
                self?.saveCustom(next)
            }
        case "r:age":
            askNumber(Strings.Vaults.maxAge, current: retention.maxAgeDays, range: VaultRetention.Limits.maxAgeDays, allowsNone: true) { [weak self] value in
                var next = retention
                next.maxAgeDays = value
                self?.saveCustom(next)
            }
        default:
            guard id.hasPrefix("r:tier:"), let index = Int(id.dropFirst(7)), retention.thinning.indices.contains(index) else { return }
            askTier(retention.thinning[index], removable: true) { [weak self] tier in
                var next = retention
                if let tier { next.thinning[index] = tier } else { next.thinning.remove(at: index) }
                self?.saveCustom(next)
            }
        }
    }

    /// A custom edit stays in Custom, even when it matches a preset.
    private func saveCustom(_ retention: VaultRetention) {
        customShown = true
        updateInput()
        save(retention)
    }

    private func save(_ retention: VaultRetention) {
        let library = library, surfaceId = surfaceId
        let next = retention.normalized()
        Task { [weak self] in
            do {
                try await library.setRetention(surfaceId, next)
            } catch {
                guard let self else { return }
                Alerts.show(Strings.Vaults.saveFailed, VaultActions.message(error), on: self)
            }
        }
    }

    /// Asks for a number in `range`; with `allowsNone`, "No limit" too.
    private func askNumber(_ title: String, current: Int?, range: ClosedRange<Int>, allowsNone: Bool, done: @escaping (Int?) -> Void) {
        let alert = UIAlertController(title: title, message: "\(range.lowerBound)–\(range.upperBound)", preferredStyle: .alert)
        alert.addTextField { field in
            field.keyboardType = .numberPad
            field.placeholder = Strings.Vaults.numberPlaceholder
            field.text = current.map(String.init)
            field.accessibilityIdentifier = "vault-number-field"
        }
        alert.addAction(UIAlertAction(title: Strings.Vaults.cancel, style: .cancel))
        if allowsNone { alert.addAction(UIAlertAction(title: Strings.Vaults.noLimit, style: .default) { _ in done(nil) }) }
        alert.addAction(UIAlertAction(title: Strings.Vaults.save, style: .default) { [weak alert] _ in
            guard let value = Int(alert?.textFields?.first?.text ?? "") else { return }
            done(min(max(value, range.lowerBound), range.upperBound))
        })
        present(alert, animated: true)
    }

    /// Asks for a thinning rule's two numbers; nil removes it.
    private func askTier(_ tier: VaultRetention.Tier, removable: Bool, done: @escaping (VaultRetention.Tier?) -> Void) {
        let alert = UIAlertController(title: Strings.Vaults.thinAfter, message: nil, preferredStyle: .alert)
        alert.addTextField { field in
            field.keyboardType = .numberPad
            field.placeholder = Strings.Vaults.afterDaysTitle
            field.text = String(tier.afterDays)
            field.accessibilityIdentifier = "vault-tier-after"
        }
        alert.addTextField { field in
            field.keyboardType = .numberPad
            field.placeholder = Strings.Vaults.everyDaysTitle
            field.text = String(tier.everyDays)
            field.accessibilityIdentifier = "vault-tier-every"
        }
        alert.message = "\(Strings.Vaults.afterDaysTitle)\n\(Strings.Vaults.everyDaysTitle)"
        alert.addAction(UIAlertAction(title: Strings.Vaults.cancel, style: .cancel))
        if removable { alert.addAction(UIAlertAction(title: Strings.Vaults.removeTier, style: .destructive) { _ in done(nil) }) }
        alert.addAction(UIAlertAction(title: Strings.Vaults.save, style: .default) { [weak alert] _ in
            guard let fields = alert?.textFields, let after = Int(fields[0].text ?? ""), let every = Int(fields[1].text ?? "") else { return }
            done(VaultRetention.Tier(afterDays: after, everyDays: every))
        })
        present(alert, animated: true)
    }
}
#endif
