#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit
import UltraView

/// What an entry's history slots derive from.
struct VaultHistoryInput: Sendable {
    enum Status: Equatable, Sendable { case loading, ready, failed, gone }

    var status = Status.loading
    var entry: VaultEntry
    var versions: [VaultVersion] = []
    var activity: [VaultActivity] = []
    /// People's names by user ID, as they are read.
    var names: [String: String] = [:]
    var waiting: Set<Int> = []
    var width: CGFloat = 0
    var maxWidth: CGFloat = .greatestFiniteMagnitude
    var scale: CGFloat = 1
    var displayScale: CGFloat = 2
    var dark = false
    var words: Strings.Artifacts.DateWords
    var now = Date()
    var calendar = Calendar.current
}

/// One file's or site's versions, newest first, each with who made it,
/// when and how big, the current and the pinned marked; then what was done
/// to it. A version opens a preview of itself, and offers to become the
/// newest again, to be pinned (kept whatever the retention) or unpinned,
/// or to be shared. A new version, a pin and a removal show as they happen.
final class VaultHistoryViewController: UIViewController {
    private let session: Session
    private let surfaceId: String
    private let vaultName: String
    private let library: VaultLibrary
    private lazy var actions = VaultActions(session: session, surfaceId: surfaceId, vaultName: vaultName, host: self)
    let list = CardListView()
    private var pipeline: ApplyPipeline<VaultHistoryInput, Applied, Output>?
    private var following: Task<Void, Never>?
    private var reading: Task<Void, Never>?
    private var entry: VaultEntry
    private(set) var versions: [String: VaultVersion] = [:]

    struct Applied: Sendable {
        var items: [String: CardItem] = [:]
        var order: [String] = []
        var counter: UInt64 = 0
    }

    struct Output: Sendable {
        var items: [CardItem]
        var versions: [String: VaultVersion]
        var width: CGFloat
        var replan: @Sendable (CGFloat) -> [CardItem]
    }

    init(session: Session, surfaceId: String, vaultName: String, entry: VaultEntry) {
        self.session = session
        self.surfaceId = surfaceId
        self.vaultName = vaultName
        self.entry = entry
        library = session.engine.vaults
        super.init(nibName: nil, bundle: nil)
        title = Strings.Vaults.historyTitle
        navigationItem.subtitle = entry.name
        navigationItem.largeTitleDisplayMode = .never
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    deinit {
        following?.cancel()
        reading?.cancel()
        pipeline?.cancel()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        followsTextSize()
        view.backgroundColor = UIColor(Palette.groupedGround)
        view.accessibilityIdentifier = "vault-history"
        list.accessibilityIdentifier = "vault-history-list"
        view.addSubview(list)
        HeaderBar.edge(list.edge, in: self)
        list.onSelect = { [weak self] id in self?.open(id) }
        list.menu = { [weak self] id in self?.menu(id) }
        list.swipeActions = { [weak self] id in self?.swipeActions(id) ?? [] }
        list.accessibilityActions = { [weak self] id in self?.accessibilityActions(id) ?? [] }
        let pipeline = ApplyPipeline<VaultHistoryInput, Applied, Output>(
            input: currentInput(),
            state: Applied(),
            derive: { input, applied in Self.derive(input, applied: applied) },
            apply: { [weak self] output in self?.show(output) ?? false }
        )
        self.pipeline = pipeline
        let library = library, surfaceId = surfaceId, entryId = entry.id, known = entry
        following = Task { [weak self] in
            let events = await library.entryEvents(surfaceId, entryId, known: known)
            for await event in events {
                guard let self else { return }
                self.receive(event)
            }
        }
        read()
        registerForTraitChanges(UIView.textSizeTraits + [UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.updateInput()
        }
    }

    private func receive(_ event: VaultEntryEvent) {
        switch event {
        case .entry(let next):
            let renewed = next.latestVersion != entry.latestVersion
            entry = next
            navigationItem.subtitle = next.name
            pipeline?.update { $0.entry = next }
            // A new version, and what made it: read again.
            if renewed { read() }
        case .pinned(let number, let pinned):
            pipeline?.update { input in
                if let index = input.versions.firstIndex(where: { $0.number == number }) { input.versions[index].pinned = pinned }
            }
            read()
        case .removed:
            pipeline?.update { $0.status = .gone }
        }
    }

    /// The versions and the activity, then the names of who made them.
    private func read() {
        reading?.cancel()
        let library = library, surfaceId = surfaceId, entryId = entry.id
        reading = Task { [weak self] in
            do {
                let history = try await library.history(surfaceId, entryId)
                guard !Task.isCancelled, let self else { return }
                self.pipeline?.update { input in
                    input.versions = history.versions
                    input.activity = history.activity
                    if input.status != .gone { input.status = .ready }
                }
                let ids = Set((history.versions.map(\.actor) + history.activity.map(\.actor)).compactMap(\.userId))
                let names = await library.names(ids)
                guard !Task.isCancelled else { return }
                self.pipeline?.update { $0.names.merge(names) { _, new in new } }
            } catch is CancellationError {
            } catch AgentClientError.status(404, _, _) {
                self?.pipeline?.update { $0.status = .gone }
            } catch {
                self?.pipeline?.update { if $0.versions.isEmpty { $0.status = .failed } }
            }
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

    private func currentInput() -> VaultHistoryInput {
        var input = VaultHistoryInput(entry: entry, words: .current)
        input.width = list.contentWidth
        input.maxWidth = list.maxWidth
        input.scale = traitCollection.textEnvironment?.scale.multiplier ?? 1
        input.displayScale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 2
        input.dark = traitCollection.userInterfaceStyle == .dark
        input.now = Date()
        return input
    }

    private func updateInput() {
        let next = currentInput()
        pipeline?.update { input in
            input.width = next.width
            input.maxWidth = next.maxWidth
            input.scale = next.scale
            input.displayScale = next.displayScale
            input.dark = next.dark
            input.words = next.words
            input.now = next.now
        }
    }

    // MARK: Derivation

    nonisolated static func derive(_ input: VaultHistoryInput, applied: Applied) -> (output: Output, state: Applied)? {
        var counter = applied.counter
        let made = CardItems.revise(items(input), previous: applied.items, counter: &counter)
        let order = made.map(\.id)
        guard order != applied.order || made.contains(where: { applied.items[$0.id]?.revision != $0.revision }) else { return nil }
        let versions = Dictionary(input.versions.map { ("v:\($0.number)", $0) }, uniquingKeysWith: { first, _ in first })
        let replan: @Sendable (CGFloat) -> [CardItem] = { width in
            var input = input
            input.width = width
            return items(input)
        }
        return (Output(items: made, versions: versions, width: input.width, replan: replan),
                Applied(items: Dictionary(made.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }), order: order, counter: counter))
    }

    /// Who a change was by: the person's name, an agent, or someone.
    nonisolated static func who(_ actor: VaultActor, names: [String: String]) -> String {
        if let user = actor.userId, let name = names[user] { return name }
        if actor.agentId != nil { return Strings.Vaults.agent }
        return Strings.Vaults.someone
    }

    nonisolated static func describe(_ kind: VaultActivity.Kind) -> String {
        switch kind {
        case .created(_, let name, _): Strings.Vaults.created(name)
        case .moved(_, _, let from, let to): from != to ? Strings.Vaults.renamed(from, to) : Strings.Vaults.moved
        case .deleted: Strings.Vaults.deleted
        case .restored: Strings.Vaults.restored
        case .versionCreated(let number, let from?): Strings.Vaults.versionRestored(number, from)
        case .versionCreated(let number, nil): Strings.Vaults.versionMade(number)
        case .pinned(let number): Strings.Vaults.pinnedVersion(number)
        case .unpinned(let number): Strings.Vaults.unpinnedVersion(number)
        case .other: Strings.Vaults.changed
        }
    }

    nonisolated static func items(_ input: VaultHistoryInput) -> [CardItem] {
        guard input.width > 0 else { return [] }
        func note(_ id: String, _ text: String) -> CardItem {
            CardItems.note(id, text, width: input.width, maxWidth: input.maxWidth, scale: input.scale, dark: input.dark, displayScale: input.displayScale)
        }
        func heading(_ id: String, _ text: String, afterCard: Bool) -> CardItem {
            CardItems.heading(id, text, width: input.width, maxWidth: input.maxWidth, afterCard: afterCard, dark: input.dark, displayScale: input.displayScale)
        }
        var items: [CardItem] = []
        if input.status == .gone { items.append(note("history:gone", Strings.Vaults.gone)) }
        switch (input.status, input.versions.isEmpty) {
        case (.loading, true): return items + [note("history:note", Strings.Vaults.historyLoading)]
        case (.failed, true): return items + [note("history:note", Strings.Vaults.historyUnavailable)]
        default: break
        }
        var list = VaultListInput(words: input.words)
        list.width = input.width
        list.maxWidth = input.maxWidth
        list.scale = input.scale
        list.displayScale = input.displayScale
        list.dark = input.dark
        func when(_ at: Double) -> String { input.words.time(Date(timeIntervalSince1970: at / 1000), now: input.now, calendar: input.calendar) }
        let versions = input.versions.sorted { $0.number > $1.number }
        if !versions.isEmpty {
            items.append(heading("history:versions", Strings.Vaults.versions, afterCard: false))
            for (version, place) in zip(versions, CardPlace.run(versions.count)) {
                var marks: [String] = []
                if version.number == input.entry.latestVersion { marks.append(Strings.Vaults.current) }
                if version.pinned { marks.append(Strings.Vaults.pinned) }
                let title = ([Strings.Vaults.version(version.number)] + marks).joined(separator: " · ")
                var subtitle = [who(version.actor, names: input.names), when(version.createdAt), VaultListItems.size(version.size)].joined(separator: " · ")
                if let from = version.restoredFrom { subtitle += " · " + Strings.Vaults.restoredFrom(from) }
                let look: (icon: Icon, ink: ColorToken, fill: ColorToken)? = version.pinned ? (.ionicons("bookmark-outline"), Palette.tileOrange, Palette.tileOrangeFill) : nil
                items.append(VaultListItems.row(id: "v:\(version.number)", entry: input.entry, title: title, subtitle: subtitle, place: place,
                                                waiting: input.waiting.contains(version.number), input: list, subtitleLines: 2, look: look))
            }
            items.append(note("history:pinned", Strings.Vaults.pinnedNote))
        }
        let activity = input.activity.sorted { ($0.at, $0.id) > ($1.at, $1.id) }
        if !activity.isEmpty {
            items.append(heading("history:activity", Strings.Vaults.activity, afterCard: versions.isEmpty))
            for (record, place) in zip(activity, CardPlace.run(activity.count)) {
                let look: (icon: Icon, ink: ColorToken, fill: ColorToken) = (.ionicons("time-outline"), Palette.settingsSecondary, Palette.groupedSeparator)
                items.append(VaultListItems.row(id: "a:\(record.id)", entry: input.entry, title: describe(record.kind),
                                                subtitle: "\(who(record.actor, names: input.names)) · \(when(record.at))", place: place, waiting: false,
                                                input: list, look: look, opens: false))
            }
        }
        return items
    }

    private func show(_ output: Output) -> Bool {
        guard output.width == list.contentWidth else { return false }
        versions = output.versions
        list.apply(output.items, animated: true, replan: output.replan)
        return true
    }

    // MARK: Acts

    private var changeable: Bool { entry.deletedAt == nil }

    private func open(_ id: String) {
        guard let version = versions[id] else { return }
        navigationController?.pushViewController(VaultPreviewViewController(session: session, surfaceId: surfaceId, vaultName: vaultName, entry: entry, version: version.number), animated: true)
    }

    private func menu(_ id: String) -> UIMenu? {
        guard let version = versions[id] else { return nil }
        let view = list.rowView(id)
        var children: [UIMenuElement] = [
            UIAction(title: Strings.Vaults.preview, image: Glyphs.image("eye-outline", size: 20)) { [weak self] _ in self?.open(id) },
            UIAction(title: Strings.Vaults.share, image: Glyphs.image("share-outline", size: 20)) { [weak self] _ in
                guard let self else { return }
                actions.share(entry, version: version.number, view: view)
            },
        ]
        if changeable {
            if restorable(version) {
                children.append(UIAction(title: Strings.Vaults.restoreVersion, image: Glyphs.image("return-up-back-outline", size: 20)) { [weak self] _ in self?.restore(version) })
            }
            children.append(pinAction(version))
        }
        return UIMenu(children: children)
    }

    /// Restoring content the current version already has makes no version, so it isn't offered.
    private func restorable(_ version: VaultVersion) -> Bool {
        guard version.number != entry.latestVersion else { return false }
        guard let sha = version.sha256, let current = versions.values.first(where: { $0.number == entry.latestVersion }) else { return true }
        return sha != current.sha256
    }

    private func pinAction(_ version: VaultVersion) -> UIAction {
        UIAction(title: version.pinned ? Strings.Vaults.unpin : Strings.Vaults.pin, image: Glyphs.image("bookmark-outline", size: 20)) { [weak self] _ in
            self?.pin(version)
        }
    }

    private func swipeActions(_ id: String) -> [ListSwipeAction] {
        guard let version = versions[id], changeable else { return [] }
        return [ListSwipeAction(title: version.pinned ? Strings.Vaults.unpin : Strings.Vaults.pin, image: .icon(.ionicons("bookmark-outline"), size: 20),
                                color: UIColor(Palette.tileOrange)) { [weak self] in self?.pin(version) }]
    }

    private func accessibilityActions(_ id: String) -> [UIAccessibilityCustomAction] {
        guard let version = versions[id], changeable else { return [] }
        var items = [UIAccessibilityCustomAction(name: version.pinned ? Strings.Vaults.unpin : Strings.Vaults.pin) { [weak self] _ in self?.pin(version); return true }]
        if restorable(version) {
            items.append(UIAccessibilityCustomAction(name: Strings.Vaults.restoreVersion) { [weak self] _ in self?.restore(version); return true })
        }
        return items
    }

    private func pin(_ version: VaultVersion) {
        let (surfaceId, entryId, number, pinned) = (surfaceId, entry.id, version.number, !version.pinned)
        pipeline?.update { input in
            input.waiting.insert(number)
            if let index = input.versions.firstIndex(where: { $0.number == number }) { input.versions[index].pinned = pinned }
        }
        let library = library
        Task { [weak self] in
            do {
                let answer = try await library.pin(surfaceId, entryId, number: number, pinned: pinned)
                self?.pipeline?.update { input in
                    input.waiting.remove(number)
                    if let index = input.versions.firstIndex(where: { $0.number == number }) { input.versions[index] = answer }
                }
            } catch {
                guard let self else { return }
                pipeline?.update { input in
                    input.waiting.remove(number)
                    if let index = input.versions.firstIndex(where: { $0.number == number }) { input.versions[index].pinned = !pinned }
                }
                actions.show(error)
            }
        }
    }

    private func restore(_ version: VaultVersion) {
        let alert = UIAlertController(title: Strings.Vaults.restoreVersion, message: Strings.Vaults.restoreConfirm(version.number), preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Vaults.cancel, style: .cancel))
        alert.addAction(UIAlertAction(title: Strings.Vaults.restore, style: .default) { [weak self] _ in
            guard let self else { return }
            let (surfaceId, entryId, number) = (surfaceId, entry.id, version.number)
            actions.perform { _ = try await $0.restoreVersion(surfaceId, entryId, number: number) }
        })
        present(alert, animated: true)
    }
}
#endif
