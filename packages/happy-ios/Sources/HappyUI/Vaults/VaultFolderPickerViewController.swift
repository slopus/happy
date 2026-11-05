#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit
import UltraView

/// Where an entry goes: a vault's folders only, one screen per folder in a
/// sheet of its own, as Files' Move. The bar's button picks the folder on
/// screen; a new folder can be made on the way. The entry being moved is
/// not among them, so a folder can't go inside itself.
final class VaultFolderPickerViewController: UIViewController {
    private let session: Session
    private let surfaceId: String
    private let vaultName: String
    private let folder: VaultEntry?
    private let path: [VaultEntry]
    private let moving: VaultEntry?
    private let action: String
    private let completion: (VaultParent) -> Void
    private let library: VaultLibrary
    private lazy var actions = VaultActions(session: session, surfaceId: surfaceId, vaultName: vaultName, host: self)
    let list = CardListView()
    private var pipeline: ApplyPipeline<VaultListInput, Applied, Output>?
    private var following: Task<Void, Never>?
    private var folders: [String: VaultEntry] = [:]

    struct Applied: Sendable {
        var items: [String: CardItem] = [:]
        var order: [String] = []
        var counter: UInt64 = 0
    }

    struct Output: Sendable {
        var items: [CardItem]
        var folders: [String: VaultEntry]
        var width: CGFloat
        var replan: @Sendable (CGFloat) -> [CardItem]
    }

    init(session: Session, surfaceId: String, vaultName: String, folder: VaultEntry?, path: [VaultEntry], moving: VaultEntry?, action: String,
         completion: @escaping (VaultParent) -> Void) {
        self.session = session
        self.surfaceId = surfaceId
        self.vaultName = vaultName
        self.folder = folder
        self.path = path
        self.moving = moving
        self.action = action
        self.completion = completion
        library = session.engine.vaults
        super.init(nibName: nil, bundle: nil)
        title = folder?.name ?? vaultName
        navigationItem.subtitle = moving.map { Strings.Vaults.moveTitle($0.shownName) }
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
        view.accessibilityIdentifier = "vault-folder-picker"
        list.accessibilityIdentifier = "vault-folder-picker-list"
        view.addSubview(list)
        HeaderBar.edge(list.edge, in: self)
        list.onSelect = { [weak self] id in self?.open(id) }
        if path.isEmpty, folder == nil {
            let cancel = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
            cancel.accessibilityIdentifier = "vault-picker-cancel"
            navigationItem.leftBarButtonItem = cancel
        }
        let here = UIBarButtonItem(title: action, primaryAction: UIAction { [weak self] _ in self?.choose() })
        here.style = .prominent
        here.accessibilityIdentifier = "vault-picker-choose"
        let newFolder = UIBarButtonItem(image: .icon(.ionicons("folder-outline"), size: 22), primaryAction: UIAction { [weak self] _ in
            guard let self else { return }
            actions.newFolder(in: folder?.id)
        })
        newFolder.accessibilityLabel = Strings.Vaults.newFolder
        newFolder.accessibilityIdentifier = "vault-picker-new-folder"
        toolbarItems = [newFolder, .flexibleSpace(), here]
        let pipeline = ApplyPipeline<VaultListInput, Applied, Output>(
            input: currentInput(),
            state: Applied(),
            derive: { [moving] input, applied in Self.derive(input, applied: applied, moving: moving?.id) },
            apply: { [weak self] output in self?.show(output) ?? false }
        )
        self.pipeline = pipeline
        let library = library, surfaceId = surfaceId, folderId = folder?.id
        following = Task { [weak pipeline] in
            let states = await library.states(surfaceId, folder: folderId)
            pipeline?.follow(ifChanged: states) { input, state in
                guard input.state != state else { return false }
                input.state = state
                return true
            }
        }
        registerForTraitChanges(UIView.textSizeTraits + [UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.updateInput()
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setToolbarHidden(false, animated: animated)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        list.maxWidth = ContentWidth.maxWidth
        list.frame = view.bounds
        let safe = view.safeAreaInsets
        list.setInsets(UIEdgeInsets(top: safe.top + CardListMetrics.contentTop, left: 0, bottom: safe.bottom + CardListMetrics.contentBottom, right: 0))
        updateInput()
    }

    private func currentInput() -> VaultListInput {
        var input = VaultListInput(words: .current)
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
            input.width = next.width
            input.maxWidth = next.maxWidth
            input.scale = next.scale
            input.displayScale = next.displayScale
            input.dark = next.dark
            input.words = next.words
        }
    }

    /// The folder's folders by name, but the one being moved.
    nonisolated static func derive(_ input: VaultListInput, applied: Applied, moving: String?) -> (output: Output, state: Applied)? {
        let folders = VaultSort.name.sorted(input.state.entries.filter { $0.isFolder && $0.id != moving })
        var counter = applied.counter
        let made = CardItems.revise(items(input, folders: folders), previous: applied.items, counter: &counter)
        let order = made.map(\.id)
        guard order != applied.order || made.contains(where: { applied.items[$0.id]?.revision != $0.revision }) else { return nil }
        let byID = Dictionary(folders.map { (VaultListItems.entryID($0.id), $0) }, uniquingKeysWith: { first, _ in first })
        let replan: @Sendable (CGFloat) -> [CardItem] = { width in
            var input = input
            input.width = width
            return items(input, folders: folders)
        }
        return (Output(items: made, folders: byID, width: input.width, replan: replan),
                Applied(items: Dictionary(made.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }), order: order, counter: counter))
    }

    nonisolated static func items(_ input: VaultListInput, folders: [VaultEntry]) -> [CardItem] {
        guard input.width > 0 else { return [] }
        func note(_ text: String) -> [CardItem] {
            [CardItems.note("vault:note", text, width: input.width, maxWidth: input.maxWidth, scale: input.scale, dark: input.dark, displayScale: input.displayScale)]
        }
        if input.state.status == .missing { return note(Strings.Vaults.missing) }
        if folders.isEmpty { return note(input.state.status == .loading ? Strings.Vaults.loading : Strings.Vaults.noFolders) }
        return zip(folders, CardPlace.run(folders.count)).map { folder, place in
            VaultListItems.row(id: VaultListItems.entryID(folder.id), entry: folder, title: folder.name, subtitle: VaultListItems.detail(folder, input: input),
                               place: place, waiting: input.state.waiting.contains(folder.id), input: input)
        }
    }

    private func show(_ output: Output) -> Bool {
        guard output.width == list.contentWidth else { return false }
        folders = output.folders
        list.apply(output.items, animated: true, replan: output.replan)
        return true
    }

    private func open(_ id: String) {
        guard let next = folders[id] else { return }
        let screen = VaultFolderPickerViewController(session: session, surfaceId: surfaceId, vaultName: vaultName, folder: next, path: path + (folder.map { [$0] } ?? []),
                                                     moving: moving, action: action, completion: completion)
        navigationController?.pushViewController(screen, animated: true)
    }

    private func choose() {
        let parent = VaultParent(folder?.id)
        let library = library, surfaceId = surfaceId, moving = moving
        Task { [weak self] in
            if let moving, moving.isFolder, await library.isInside(surfaceId, folder: parent.id, entryId: moving.id) {
                guard let self else { return }
                Alerts.show(Strings.Vaults.failedTitle, Strings.Vaults.cantMoveHere, on: self)
                return
            }
            guard let self else { return }
            let completion = completion
            navigationController?.dismiss(animated: true) { completion(parent) }
        }
    }
}
#endif
