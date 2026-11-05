#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit
import UltraView

/// What a vault's Trash slots derive from.
struct VaultTrashInput: Sendable {
    var trash = VaultTrashState()
    /// The vault's Trash time once its settings are read: nil keeps items
    /// until they are restored.
    var trashDays: Int??
    var width: CGFloat = 0
    var maxWidth: CGFloat = .greatestFiniteMagnitude
    var scale: CGFloat = 1
    var displayScale: CGFloat = 2
    var dark = false
    var words: Strings.Artifacts.DateWords
    var now = Date()
    var calendar = Calendar.current
}

/// A vault's Trash: what went there, newest first, each with when and
/// where from, under how long the vault keeps it. A tap offers to restore
/// an item where it was or elsewhere, or to look at it first; a swipe
/// restores it. Live, as the library hears of changes.
final class VaultTrashViewController: UIViewController {
    private let session: Session
    private let surfaceId: String
    private let vaultName: String
    private let library: VaultLibrary
    private lazy var actions = VaultActions(session: session, surfaceId: surfaceId, vaultName: vaultName, host: self)
    let list = CardListView()
    private var pipeline: ApplyPipeline<VaultTrashInput, Applied, Output>?
    private var following: [Task<Void, Never>] = []
    private(set) var items: [String: VaultTrashItem] = [:]

    struct Applied: Sendable {
        var items: [String: CardItem] = [:]
        var order: [String] = []
        var counter: UInt64 = 0
    }

    struct Output: Sendable {
        var items: [CardItem]
        var trash: [String: VaultTrashItem]
        var width: CGFloat
        var replan: @Sendable (CGFloat) -> [CardItem]
    }

    init(session: Session, surfaceId: String, vaultName: String) {
        self.session = session
        self.surfaceId = surfaceId
        self.vaultName = vaultName
        library = session.engine.vaults
        super.init(nibName: nil, bundle: nil)
        title = Strings.Vaults.trashTitle
        navigationItem.subtitle = vaultName
        navigationItem.largeTitleDisplayMode = .never
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    deinit {
        for task in following { task.cancel() }
        pipeline?.cancel()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        followsTextSize()
        view.backgroundColor = UIColor(Palette.groupedGround)
        view.accessibilityIdentifier = "vault-trash"
        list.accessibilityIdentifier = "vault-trash-list"
        view.addSubview(list)
        HeaderBar.edge(list.edge, in: self)
        list.onSelect = { [weak self] id in self?.open(id) }
        list.menu = { [weak self] id in self?.menu(id) }
        list.swipeActions = { [weak self] id in self?.swipeActions(id) ?? [] }
        list.accessibilityActions = { [weak self] id in self?.accessibilityActions(id) ?? [] }
        let pipeline = ApplyPipeline<VaultTrashInput, Applied, Output>(
            input: currentInput(),
            state: Applied(),
            derive: { input, applied in Self.derive(input, applied: applied) },
            apply: { [weak self] output in self?.show(output) ?? false }
        )
        self.pipeline = pipeline
        let library = library, surfaceId = surfaceId
        following.append(Task { [weak pipeline] in
            let states = await library.trashStates(surfaceId)
            pipeline?.follow(ifChanged: states) { input, state in
                guard input.trash != state else { return false }
                input.trash = state
                return true
            }
        })
        following.append(Task { [weak pipeline] in
            let states = await library.settingsStates(surfaceId)
            pipeline?.follow(ifChanged: states) { input, settings in
                guard let settings, input.trashDays != .some(settings.retention.trashDays) else { return false }
                input.trashDays = .some(settings.retention.trashDays)
                return true
            }
        })
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

    private func currentInput() -> VaultTrashInput {
        var input = VaultTrashInput(words: .current)
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

    nonisolated static func derive(_ input: VaultTrashInput, applied: Applied) -> (output: Output, state: Applied)? {
        var counter = applied.counter
        let made = CardItems.revise(items(input), previous: applied.items, counter: &counter)
        let order = made.map(\.id)
        guard order != applied.order || made.contains(where: { applied.items[$0.id]?.revision != $0.revision }) else { return nil }
        let trash = Dictionary(input.trash.items.map { (VaultListItems.entryID($0.entry.id), $0) }, uniquingKeysWith: { first, _ in first })
        let replan: @Sendable (CGFloat) -> [CardItem] = { width in
            var input = input
            input.width = width
            return items(input)
        }
        return (Output(items: made, trash: trash, width: input.width, replan: replan),
                Applied(items: Dictionary(made.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }), order: order, counter: counter))
    }

    /// The Trash time, then the items, the latest to go first.
    nonisolated static func items(_ input: VaultTrashInput) -> [CardItem] {
        guard input.width > 0 else { return [] }
        func note(_ id: String, _ text: String) -> CardItem {
            CardItems.note(id, text, width: input.width, maxWidth: input.maxWidth, scale: input.scale, dark: input.dark, displayScale: input.displayScale)
        }
        var items: [CardItem] = []
        if case .some(let days) = input.trashDays { items.append(note("trash:kept", Strings.Vaults.trashKept(days))) }
        guard input.trash.loaded else { return items + [note("trash:note", Strings.Vaults.trashLoading)] }
        let shown = input.trash.items.sorted { ($0.entry.deletedAt ?? 0, $0.entry.id) > ($1.entry.deletedAt ?? 0, $1.entry.id) }
        guard !shown.isEmpty else { return items + [note("trash:note", Strings.Vaults.trashEmpty)] }
        var list = VaultListInput(words: input.words)
        list.width = input.width
        list.maxWidth = input.maxWidth
        list.scale = input.scale
        list.displayScale = input.displayScale
        list.dark = input.dark
        for (item, place) in zip(shown, CardPlace.run(shown.count)) {
            let when = input.words.time(Date(timeIntervalSince1970: (item.entry.deletedAt ?? item.entry.updatedAt) / 1000), now: input.now, calendar: input.calendar)
            let folder = (item.path as NSString).deletingLastPathComponent
            let from = folder.isEmpty || folder == "/" ? Strings.Vaults.title : String(folder.dropFirst())
            items.append(VaultListItems.row(id: VaultListItems.entryID(item.entry.id), entry: item.entry, title: item.entry.name,
                                            subtitle: Strings.Vaults.deletedFrom(from, when), place: place, waiting: false, input: list))
        }
        return items
    }

    private func show(_ output: Output) -> Bool {
        guard output.width == list.contentWidth else { return false }
        items = output.trash
        list.apply(output.items, animated: true, replan: output.replan)
        return true
    }

    // MARK: Acts

    private func open(_ id: String) {
        guard let item = items[id] else { return }
        let sheet = UIAlertController(title: item.entry.name, message: nil, preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: Strings.Vaults.restore, style: .default) { [weak self] _ in self?.restore(item) })
        sheet.addAction(UIAlertAction(title: Strings.Vaults.restoreTo, style: .default) { [weak self] _ in self?.restoreTo(item) })
        if !item.entry.isFolder {
            sheet.addAction(UIAlertAction(title: Strings.Vaults.preview, style: .default) { [weak self] _ in self?.preview(item) })
        }
        sheet.addAction(UIAlertAction(title: Strings.Vaults.cancel, style: .cancel))
        if let popover = sheet.popoverPresentationController {
            let view: UIView = list.rowView(id) ?? list
            popover.sourceView = view
            popover.sourceRect = view.bounds
        }
        present(sheet, animated: true)
    }

    private func menu(_ id: String) -> UIMenu? {
        guard let item = items[id] else { return nil }
        var children: [UIMenuElement] = [
            UIAction(title: Strings.Vaults.restore, image: Glyphs.image("return-up-back-outline", size: 20)) { [weak self] _ in self?.restore(item) },
            UIAction(title: Strings.Vaults.restoreTo, image: Glyphs.image("folder-outline", size: 20)) { [weak self] _ in self?.restoreTo(item) },
        ]
        if !item.entry.isFolder {
            children.append(UIAction(title: Strings.Vaults.preview, image: Glyphs.image("eye-outline", size: 20)) { [weak self] _ in self?.preview(item) })
        }
        return UIMenu(children: children)
    }

    private func swipeActions(_ id: String) -> [ListSwipeAction] {
        guard let item = items[id] else { return [] }
        return [ListSwipeAction(title: Strings.Vaults.restore, image: .icon(.ionicons("return-up-back-outline"), size: 20), color: UIColor(Palette.todoCheck)) { [weak self] in self?.restore(item) }]
    }

    private func accessibilityActions(_ id: String) -> [UIAccessibilityCustomAction] {
        guard let item = items[id] else { return [] }
        return [
            UIAccessibilityCustomAction(name: Strings.Vaults.restore) { [weak self] _ in self?.restore(item); return true },
            UIAccessibilityCustomAction(name: Strings.Vaults.restoreTo) { [weak self] _ in self?.restoreTo(item); return true },
        ]
    }

    private func preview(_ item: VaultTrashItem) {
        navigationController?.pushViewController(VaultPreviewViewController(session: session, surfaceId: surfaceId, vaultName: vaultName, entry: item.entry), animated: true)
    }

    private func restoreTo(_ item: VaultTrashItem) {
        let picker = VaultFolderPickerViewController(session: session, surfaceId: surfaceId, vaultName: vaultName, folder: nil, path: [],
                                                     moving: item.entry, action: Strings.Vaults.restoreHere) { [weak self] parent in
            self?.restore(item, to: parent)
        }
        present(UINavigationController(rootViewController: picker), animated: true)
    }

    /// Restores `item`; a name taken where it goes asks for another.
    private func restore(_ item: VaultTrashItem, to parent: VaultParent? = nil, name: String? = nil) {
        let library = library, surfaceId = surfaceId
        Task { [weak self] in
            do {
                try await library.restore(surfaceId, item, to: parent, name: name)
            } catch AgentClientError.status(409, "name_taken", _) {
                guard let self else { return }
                let free = await library.freeName(surfaceId, parentId: parent?.id ?? item.entry.parentId, for: name ?? item.entry.name)
                self.actions.askName(title: Strings.Vaults.nameTaken(name ?? item.entry.name), current: free, action: Strings.Vaults.restore) { [weak self] next in
                    self?.restore(item, to: parent, name: next)
                }
            } catch {
                self?.actions.show(error, name: name ?? item.entry.name)
            }
        }
    }
}
#endif
