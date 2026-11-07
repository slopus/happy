#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit
import UltraView

/// A vault Surface, as Finder: one screen per folder, pushed as the person
/// goes in, its name in the bar over the path it is at (whose ancestors
/// the title's menu goes back to). Uploads under way sit over the folder's
/// entries, folders first in the order the bar's menu picks. A tap opens a folder or previews a file; a hold offers what can be done to an
/// entry, a swipe moves it to the Trash. The "+" makes folders and uploads
/// from Files and Photos; the "…" holds the order, the Trash, the vault's
/// settings and its zip. What the library hears from the computer shows
/// as it happens; there is nothing to refresh.
final class VaultViewController: UIViewController {
    private let session: Session
    let surfaceId: String
    private let vaultName: String
    /// Nil: the vault's root.
    private var folder: VaultEntry?
    private let library: VaultLibrary
    private lazy var actions = VaultActions(session: session, surfaceId: surfaceId, vaultName: vaultName, host: self)
    let list = CardListView()
    private var pipeline: ApplyPipeline<VaultListInput, Applied, Output>?
    private var following: Task<Void, Never>?
    private var followingFolder: Task<Void, Never>?
    private var locating: Task<Void, Never>?
    /// The folders over this one, outermost first.
    private var ancestors: [VaultLocation.Ancestor] = []
    /// What the rows on screen are, by row ID.
    private(set) var rows: [String: Row] = [:]
    private(set) var state = VaultFolderState()
    private var sort: VaultSort

    enum Row: Equatable, Sendable {
        case entry(VaultEntry)
        case upload(VaultUploadState)
    }

    struct Applied: Sendable {
        var items: [String: CardItem] = [:]
        var order: [String] = []
        var counter: UInt64 = 0
        var state: VaultFolderState?
    }

    struct Output: Sendable {
        var items: [CardItem]
        var rows: [String: Row]
        var state: VaultFolderState
        var width: CGFloat
        var replan: @Sendable (CGFloat) -> [CardItem]
    }

    init(session: Session, surfaceId: String, vaultName: String, folder: VaultEntry? = nil, ancestors: [VaultLocation.Ancestor] = []) {
        self.session = session
        self.surfaceId = surfaceId
        self.vaultName = vaultName
        self.folder = folder
        self.ancestors = ancestors
        library = session.engine.vaults
        sort = Self.keptSort(surfaceId)
        super.init(nibName: nil, bundle: nil)
        navigationItem.largeTitleDisplayMode = .never
        showTitle()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    // Not `isolated deinit` (see `Watch`).
    deinit {
        following?.cancel()
        followingFolder?.cancel()
        locating?.cancel()
        pipeline?.cancel()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        followsTextSize()
        view.backgroundColor = UIColor(Palette.groupedGround)
        view.accessibilityIdentifier = "vault"
        list.accessibilityIdentifier = "vault-list"
        view.addSubview(list)
        list.onSelect = { [weak self] id in self?.open(id) }
        list.menu = { [weak self] id in self?.menu(id) }
        list.swipeActions = { [weak self] id in self?.swipeActions(id) ?? [] }
        list.accessibilityActions = { [weak self] id in self?.accessibilityActions(id) ?? [] }
        setUpBar()
        accessWatch = session.watchAccess { [weak self] in self?.updateBarItems(); self?.updateInput() }

        let pipeline = ApplyPipeline<VaultListInput, Applied, Output>(
            input: currentInput(),
            state: Applied(),
            derive: { input, applied in Self.derive(input, applied: applied) },
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
        if let folder {
            followingFolder = Task { [weak self] in
                let events = await library.entryEvents(surfaceId, folder.id, known: folder)
                for await event in events {
                    guard let self else { return }
                    if case .entry(let next) = event {
                        let moved = next.parentId != self.folder?.parentId
                        self.folder = next
                        self.showTitle()
                        if moved { self.locate() }
                    }
                }
            }
            if ancestors.isEmpty, folder.parentId != nil { locate() }
        }
        registerForTraitChanges(UIView.textSizeTraits + [UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.updateInput()
        }
        NotificationCenter.default.addObserver(self, selector: #selector(dayChanged), name: .NSCalendarDayChanged, object: nil)
    }

    /// The folder's name over the path it is at.
    private func showTitle() {
        title = folder?.name ?? vaultName
        navigationItem.subtitle = folder == nil ? nil : ([vaultName] + ancestors.map(\.name)).joined(separator: " › ")
    }

    /// Reads where the folder is, for the path under its name.
    private func locate() {
        guard let folder else { return }
        locating?.cancel()
        let library = library, surfaceId = surfaceId
        locating = Task { [weak self] in
            guard let location = try? await library.location(surfaceId, folder.id, folder: true), !Task.isCancelled, let self else { return }
            self.ancestors = location.ancestors
            self.showTitle()
        }
    }

    private var accessWatch: Watch?
    /// What the person's role may do here (`VaultAccess`, `RoleGate`): on a
    /// cloud server, read-only until both are read.
    private var access: VaultAccess { session.vaultAccess(surfaceId) }
    private var writable: Bool { access.canWrite(session.gate) }
    /// The Policy vault's own folders and documents, never moved, renamed
    /// or deleted.
    private func isProtected(_ entry: VaultEntry) -> Bool { access.isProtected(entry, in: folder) }

    private func setUpBar() {
        HeaderBar.edge(list.edge, in: self)
        updateBarItems()
        navigationItem.titleMenuProvider = { [weak self] _ in self?.pathMenu() }
    }

    /// "+" while the folder can change, and "…".
    private func updateBarItems() {
        let more = UIBarButtonItem(image: UIImage(systemName: "ellipsis"), menu: UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] done in done(self?.moreItems() ?? []) }]))
        more.accessibilityLabel = Strings.Vaults.more
        more.accessibilityIdentifier = "vault-more"
        guard !state.inTrash, state.status != .missing, writable else {
            navigationItem.rightBarButtonItems = [more]
            return
        }
        let add = UIBarButtonItem(image: .icon(.ionicons("add"), size: 26), menu: addMenu())
        add.accessibilityLabel = Strings.Vaults.add
        add.accessibilityIdentifier = "vault-add"
        navigationItem.rightBarButtonItems = [more, add]
    }

    private func addMenu() -> UIMenu {
        let parent = folder?.id
        return UIMenu(children: [
            UIAction(title: Strings.Vaults.newFolder, image: Glyphs.image("folder-outline", size: 20)) { [weak self] _ in self?.actions.newFolder(in: parent) },
            UIMenu(options: .displayInline, children: [
                UIAction(title: Strings.Vaults.uploadFiles, image: Glyphs.image("document-outline", size: 20)) { [weak self] _ in self?.actions.chooseFiles(into: parent) },
                UIAction(title: Strings.Vaults.uploadPhotos, image: Glyphs.image("images", size: 20)) { [weak self] _ in self?.actions.choosePhotos(into: parent) },
            ]),
        ])
    }

    private func moreItems() -> [UIMenuElement] {
        let keys: [(VaultSort.Key, String)] = [(.name, Strings.Vaults.sortName), (.updatedAt, Strings.Vaults.sortDate), (.size, Strings.Vaults.sortSize)]
        let byKey = keys.map { key, title in
            UIAction(title: title, state: sort.key == key ? .on : .off) { [weak self] _ in self?.setSort(VaultSort(key: key)) }
        }
        let order = [(true, Strings.Vaults.ascending), (false, Strings.Vaults.descending)].map { ascending, title in
            UIAction(title: title, state: sort.ascending == ascending ? .on : .off) { [weak self] _ in
                guard let self else { return }
                setSort(VaultSort(key: sort.key, ascending: ascending))
            }
        }
        let sortMenu = UIMenu(title: Strings.Vaults.sortBy, image: UIImage(systemName: "arrow.up.arrow.down"), children: [
            UIMenu(options: .displayInline, children: byKey), UIMenu(options: .displayInline, children: order),
        ])
        let zipTitle = folder == nil ? Strings.Vaults.downloadVault : Strings.Vaults.downloadFolder
        let folder = folder
        return [
            sortMenu,
            UIMenu(options: .displayInline, children: [
                UIAction(title: zipTitle, image: Glyphs.image("download-outline", size: 20)) { [weak self] _ in self?.actions.share(folder, from: self?.navigationItem.rightBarButtonItems?.first) },
            ]),
            UIMenu(options: .displayInline, children: [
                UIAction(title: Strings.Vaults.trash, image: Glyphs.image("trash-outline", size: 20)) { [weak self] _ in self?.openTrash() },
            ] + (access.canEditSettings(session.gate) ? [
                UIAction(title: Strings.Vaults.settings, image: Glyphs.image("settings-outline", size: 20)) { [weak self] _ in self?.openSettings() },
            ] : [])),
        ]
    }

    /// The folders over this one, the nearest first, as the title's menu.
    private func pathMenu() -> UIMenu? {
        guard folder != nil else { return nil }
        let places: [(id: String?, name: String)] = [(nil, vaultName)] + ancestors.map { ($0.id, $0.name) }
        return UIMenu(children: places.reversed().map { place in
            UIAction(title: place.name, image: Glyphs.image(place.id == nil ? "vault" : "folder-outline", size: 20)) { [weak self] _ in self?.go(to: place.id) }
        })
    }

    /// Back to an ancestor's screen if it is in the stack, else to a new one.
    private func go(to folderId: String?) {
        guard let navigation = navigationController else { return }
        if let screen = navigation.viewControllers.last(where: { ($0 as? VaultViewController)?.surfaceId == surfaceId && ($0 as? VaultViewController)?.folder?.id == folderId }) {
            navigation.popToViewController(screen, animated: true)
            return
        }
        guard let folderId else {
            navigation.pushViewController(VaultViewController(session: session, surfaceId: surfaceId, vaultName: vaultName), animated: true)
            return
        }
        guard let index = ancestors.firstIndex(where: { $0.id == folderId }) else { return }
        let path = Array(ancestors.prefix(index))
        Task { [weak self, library, surfaceId] in
            var entry = await library.entry(surfaceId, folderId)
            if entry == nil { entry = try? await library.location(surfaceId, folderId, folder: true).entry }
            guard let self, let entry else { return }
            self.push(entry, ancestors: path)
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        updateInput()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        list.maxWidth = ContentWidth.maxWidth
        list.frame = view.bounds
        let safe = view.safeAreaInsets
        list.setInsets(UIEdgeInsets(top: safe.top + CardListMetrics.contentTop, left: 0, bottom: safe.bottom + CardListMetrics.contentBottom, right: 0))
        updateInput()
    }

    // MARK: Sort

    private static func sortKey(_ surfaceId: String) -> String { "vault.sort.\(surfaceId)" }

    /// The order last picked in this vault, on this phone.
    private static func keptSort(_ surfaceId: String) -> VaultSort {
        guard let data = UserDefaults.standard.data(forKey: sortKey(surfaceId)), let sort = try? JSONDecoder().decode(VaultSort.self, from: data) else { return .name }
        return sort
    }

    func setSort(_ next: VaultSort) {
        sort = next
        if let data = try? JSONEncoder().encode(next) { UserDefaults.standard.set(data, forKey: Self.sortKey(surfaceId)) }
        updateInput()
    }

    // MARK: Derivation

    private func currentInput() -> VaultListInput {
        var input = VaultListInput(words: .current)
        input.sort = sort
        input.width = list.contentWidth
        input.maxWidth = list.maxWidth
        input.scale = traitCollection.textEnvironment?.scale.multiplier ?? 1
        input.displayScale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 2
        input.dark = traitCollection.userInterfaceStyle == .dark
        input.now = Date()
        input.writable = writable
        return input
    }

    private func updateInput() {
        let next = currentInput()
        pipeline?.update { input in
            input.sort = next.sort
            input.width = next.width
            input.maxWidth = next.maxWidth
            input.scale = next.scale
            input.displayScale = next.displayScale
            input.dark = next.dark
            input.now = next.now
            input.words = next.words
            input.writable = next.writable
        }
    }

    @objc private func dayChanged() { updateInput() }

    nonisolated static func derive(_ input: VaultListInput, applied: Applied) -> (output: Output, state: Applied)? {
        let made = VaultListItems.items(input)
        var counter = applied.counter
        let items = CardItems.revise(made, previous: applied.items, counter: &counter)
        let order = items.map(\.id)
        let moved = order != applied.order || items.contains { applied.items[$0.id]?.revision != $0.revision }
        guard moved || applied.state != input.state else { return nil }
        var rows: [String: Row] = [:]
        for entry in input.state.entries { rows[VaultListItems.entryID(entry.id)] = .entry(entry) }
        for upload in input.state.uploads { rows[VaultListItems.uploadID(upload.id)] = .upload(upload) }
        let next = Applied(items: Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }), order: order, counter: counter, state: input.state)
        let replan: @Sendable (CGFloat) -> [CardItem] = { width in
            var input = input
            input.width = width
            return VaultListItems.items(input)
        }
        return (Output(items: items, rows: rows, state: input.state, width: input.width, replan: replan), next)
    }

    private func show(_ output: Output) -> Bool {
        guard output.width == list.contentWidth else { return false }
        rows = output.rows
        let barChanged = output.state.inTrash != state.inTrash || (output.state.status == .missing) != (state.status == .missing)
        state = output.state
        if barChanged { updateBarItems() }
        list.apply(output.items, animated: true, replan: output.replan)
        return true
    }

    // MARK: Acts

    private func entry(_ id: String) -> VaultEntry? {
        switch rows[id] {
        case .entry(let entry): entry
        default: nil
        }
    }

    private func open(_ id: String) {
        switch rows[id] {
        case .upload(let upload): uploadFailed(upload, from: id)
        case .entry(let entry):
            if entry.isFolder { push(entry, ancestors: (folder.map { ancestors + [.init(id: $0.id, name: $0.name)] }) ?? []) } else { preview(entry) }
        case nil: break
        }
    }

    /// Into `entry`, under the folders over it.
    private func push(_ entry: VaultEntry, ancestors: [VaultLocation.Ancestor]) {
        let screen = VaultViewController(session: session, surfaceId: surfaceId, vaultName: vaultName, folder: entry, ancestors: ancestors)
        navigationController?.pushViewController(screen, animated: true)
    }

    private func preview(_ entry: VaultEntry, version: Int? = nil) {
        navigationController?.pushViewController(VaultPreviewViewController(session: session, surfaceId: surfaceId, vaultName: vaultName, entry: entry, version: version, parent: .some(folder)), animated: true)
    }

    private func uploadFailed(_ upload: VaultUploadState, from id: String) {
        guard case .failed(let reason) = upload.phase else { return }
        let sheet = UIAlertController(title: VaultEntry.shownName(upload.name), message: reason.isEmpty ? Strings.Vaults.offline : reason, preferredStyle: .actionSheet)
        let library = library, surfaceId = surfaceId
        sheet.addAction(UIAlertAction(title: Strings.Vaults.retry, style: .default) { _ in Task { await library.retryUpload(surfaceId, upload.id) } })
        sheet.addAction(UIAlertAction(title: Strings.Vaults.cancelUpload, style: .destructive) { _ in Task { await library.cancelUpload(surfaceId, upload.id) } })
        sheet.addAction(UIAlertAction(title: Strings.Vaults.cancel, style: .cancel))
        if let popover = sheet.popoverPresentationController {
            let view: UIView = list.rowView(id) ?? list
            popover.sourceView = view
            popover.sourceRect = view.bounds
        }
        present(sheet, animated: true)
    }

    private func openHistory(_ entry: VaultEntry) {
        navigationController?.pushViewController(VaultHistoryViewController(session: session, surfaceId: surfaceId, vaultName: vaultName, entry: entry), animated: true)
    }

    private func openTrash() {
        navigationController?.pushViewController(VaultTrashViewController(session: session, surfaceId: surfaceId, vaultName: vaultName), animated: true)
    }

    private func openSettings() {
        navigationController?.pushViewController(VaultSettingsViewController(session: session, surfaceId: surfaceId), animated: true)
    }

    /// An entry can change while neither it nor its folder is in the Trash.
    private func changeable(_ entry: VaultEntry) -> Bool { entry.deletedAt == nil && !state.inTrash }

    private func menu(_ id: String) -> UIMenu? {
        if case .upload(let upload) = rows[id] {
            let library = library, surfaceId = surfaceId
            var items: [UIMenuElement] = []
            if case .failed = upload.phase {
                items.append(UIAction(title: Strings.Vaults.retry, image: Glyphs.image("refresh-outline", size: 20)) { _ in Task { await library.retryUpload(surfaceId, upload.id) } })
            }
            items.append(UIAction(title: Strings.Vaults.cancelUpload, image: Glyphs.image("close-outline", size: 20), attributes: .destructive) { _ in Task { await library.cancelUpload(surfaceId, upload.id) } })
            return UIMenu(children: items)
        }
        guard let entry = entry(id) else { return nil }
        let view = list.rowView(id)
        var open: [UIMenuElement] = [UIAction(title: Strings.Vaults.open, image: Glyphs.image("chevron-forward", size: 20)) { [weak self] _ in self?.open(id) }]
        open.append(UIAction(title: entry.kind == .file ? Strings.Vaults.share : Strings.Vaults.downloadZip, image: Glyphs.image("share-outline", size: 20)) { [weak self] _ in
            self?.actions.share(entry, view: view)
        })
        if !entry.isFolder {
            open.append(UIAction(title: Strings.Vaults.history, image: Glyphs.image("time-outline", size: 20)) { [weak self] _ in self?.openHistory(entry) })
        }
        guard changeable(entry), writable else { return UIMenu(children: open) }
        let fixed = isProtected(entry)
        var edits: [UIMenuElement] = fixed ? [] : [
            UIAction(title: Strings.Vaults.rename, image: Glyphs.image("create-outline", size: 20)) { [weak self] _ in self?.actions.rename(entry) },
            UIAction(title: Strings.Vaults.move, image: Glyphs.image("folder-outline", size: 20)) { [weak self] _ in self?.actions.move(entry) },
        ]
        if !entry.isFolder {
            edits.append(UIAction(title: Strings.Vaults.uploadNewVersion, image: Glyphs.image("arrow-up-outline", size: 20)) { [weak self] _ in self?.actions.chooseNewVersion(of: entry) })
        }
        return UIMenu(children: [
            UIMenu(options: .displayInline, children: open),
            UIMenu(options: .displayInline, children: edits),
        ] + (fixed ? [] : [
            UIMenu(options: .displayInline, children: [
                UIAction(title: Strings.Vaults.delete, image: Glyphs.image("trash-outline", size: 20), attributes: .destructive) { [weak self] _ in self?.actions.delete(entry) },
            ]),
        ]))
    }

    private func swipeActions(_ id: String) -> [ListSwipeAction] {
        guard let entry = entry(id), changeable(entry), writable, !isProtected(entry) else { return [] }
        return [
            ListSwipeAction(title: Strings.Vaults.delete, image: .icon(.ionicons("trash-outline"), size: 20), color: UIColor(Palette.statusError), isDestructive: true) { [weak self] in
                self?.actions.delete(entry)
            },
            ListSwipeAction(title: Strings.Vaults.move, image: .icon(.ionicons("folder-outline"), size: 20), color: UIColor(Palette.settingsSecondary)) { [weak self] in
                self?.actions.move(entry)
            },
        ]
    }

    private func accessibilityActions(_ id: String) -> [UIAccessibilityCustomAction] {
        guard let entry = entry(id) else { return [] }
        var items: [UIAccessibilityCustomAction] = [
            UIAccessibilityCustomAction(name: Strings.Vaults.share) { [weak self] _ in self?.actions.share(entry, view: self?.list.rowView(id)); return true },
        ]
        if !entry.isFolder {
            items.append(UIAccessibilityCustomAction(name: Strings.Vaults.history) { [weak self] _ in self?.openHistory(entry); return true })
        }
        guard changeable(entry), writable, !isProtected(entry) else { return items }
        items.append(UIAccessibilityCustomAction(name: Strings.Vaults.rename) { [weak self] _ in self?.actions.rename(entry); return true })
        items.append(UIAccessibilityCustomAction(name: Strings.Vaults.move) { [weak self] _ in self?.actions.move(entry); return true })
        items.append(UIAccessibilityCustomAction(name: Strings.Vaults.delete) { [weak self] _ in self?.actions.delete(entry); return true })
        return items
    }
}
#endif
