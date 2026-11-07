#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import HappyWire
import QuickLook
import UIKit

/// One vault entry's version, previewed by what it holds
/// (`VaultPreviewKind`): an app as its live page, Markdown, pictures and
/// recordings in the artifact viewer (`ArtifactViewController.Vault`),
/// text and code as coloured lines, anything else read whole into Quick
/// Look, whose own view offers it to other apps. With no version given it
/// follows the latest: a new version shows when it lands, a rename
/// retitles it, and its removal says so. The bar shares it and holds what
/// else can be done to it.
final class VaultPreviewViewController: UIViewController, QLPreviewControllerDataSource {
    private let session: Session
    private let surfaceId: String
    private let vaultName: String
    /// Nil follows the latest.
    private let pinnedVersion: Int?
    private var entry: VaultEntry
    private lazy var actions = VaultActions(session: session, surfaceId: surfaceId, vaultName: vaultName, host: self)
    private var library: VaultLibrary { session.engine.vaults }
    private let scrollView = UIScrollView()
    private let message = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var child: UIViewController?
    private var lines: FileLinesView?
    private var linesText: (text: String, language: String?)?
    private var plannedWidth: CGFloat?
    private var quickLook: URL?
    /// What is shown: the version and the bytes it was, so an event that
    /// changes neither leaves it be.
    private var shown: (version: Int, sha256: String?)?
    private var loading: Task<Void, Never>?
    private var following: Task<Void, Never>?
    private var gone = false
    /// The folder the file is in, nil at the root; `.none` where that isn't
    /// known (opened from search). For the Policy vault's own documents.
    private let folder: VaultEntry??
    private var accessWatch: Watch?
    private var access: VaultAccess { session.vaultAccess(surfaceId) }
    private var writable: Bool { access.canWrite(session.gate) }

    init(session: Session, surfaceId: String, vaultName: String, entry: VaultEntry, version: Int? = nil, parent: VaultEntry?? = .none) {
        folder = parent
        self.session = session
        self.surfaceId = surfaceId
        self.vaultName = vaultName
        self.entry = entry
        pinnedVersion = version
        super.init(nibName: nil, bundle: nil)
        navigationItem.largeTitleDisplayMode = .never
        showTitle()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    deinit {
        loading?.cancel()
        following?.cancel()
        if let quickLook { try? FileManager.default.removeItem(at: quickLook.deletingLastPathComponent()) }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.surface)
        view.accessibilityIdentifier = "vault-preview"
        scrollView.alwaysBounceVertical = true
        view.addSubview(scrollView)
        message.font = Fonts.ui(.regular, size: 15)
        message.textColor = UIColor(Palette.rowText)
        message.textAlignment = .center
        message.numberOfLines = 0
        message.accessibilityIdentifier = "vault-preview-message"
        scrollView.addSubview(message)
        spinner.hidesWhenStopped = true
        view.addSubview(spinner)
        setUpBar()
        accessWatch = session.watchAccess { [weak self] in self?.setUpBar() }
        let library = library, surfaceId = surfaceId, entryId = entry.id, known = entry
        following = Task { [weak self] in
            let events = await library.entryEvents(surfaceId, entryId, known: known)
            for await event in events {
                guard let self else { return }
                self.receive(event)
            }
        }
        load()
    }

    private func showTitle() {
        title = entry.shownName
        navigationItem.subtitle = pinnedVersion.map(Strings.Vaults.version)
    }

    private func receive(_ event: VaultEntryEvent) {
        switch event {
        case .entry(let next):
            let renewed = next.latestVersion != entry.latestVersion || next.sha256 != entry.sha256
            entry = next
            showTitle()
            setUpBar()
            if pinnedVersion == nil, renewed, !gone { load() }
        case .removed:
            gone = true
            loading?.cancel()
            removeContent()
            show(message: Strings.Vaults.gone)
            navigationItem.rightBarButtonItems = []
        case .pinned:
            break
        }
    }

    // MARK: Bar

    private func setUpBar() {
        guard !gone else { return }
        let share = UIBarButtonItem(image: .icon(.ionicons("share-outline"), size: 22), primaryAction: nil)
        share.primaryAction = UIAction { [weak self, weak share] _ in
            guard let self else { return }
            actions.share(entry, version: pinnedVersion, from: share)
        }
        share.accessibilityLabel = Strings.Vaults.share
        share.accessibilityIdentifier = "vault-preview-share"
        let more = UIBarButtonItem(image: UIImage(systemName: "ellipsis"), menu: UIMenu(children: menuItems()))
        more.accessibilityLabel = Strings.Vaults.more
        more.accessibilityIdentifier = "vault-preview-more"
        navigationItem.rightBarButtonItems = [more, share]
    }

    private func menuItems() -> [UIMenuElement] {
        let entry = entry
        let history = UIAction(title: Strings.Vaults.history, image: Glyphs.image("time-outline", size: 20)) { [weak self] _ in self?.openHistory() }
        if let number = pinnedVersion {
            guard number != entry.latestVersion, entry.deletedAt == nil, writable else { return [history] }
            return [
                UIAction(title: Strings.Vaults.restoreVersion, image: Glyphs.image("return-up-back-outline", size: 20)) { [weak self] _ in self?.restoreVersion(number) },
                history,
            ]
        }
        guard entry.deletedAt == nil, writable else { return [history] }
        let fixed = access.isProtected(entry, in: folder ?? nil, parentKnown: folder != nil)
        var items: [UIMenuElement] = [history]
        var edits: [UIMenuElement] = fixed ? [] : [
            UIAction(title: Strings.Vaults.rename, image: Glyphs.image("create-outline", size: 20)) { [weak self] _ in self?.actions.rename(entry) },
            UIAction(title: Strings.Vaults.move, image: Glyphs.image("folder-outline", size: 20)) { [weak self] _ in self?.actions.move(entry) },
        ]
        if !entry.isFolder {
            edits.append(UIAction(title: Strings.Vaults.uploadNewVersion, image: Glyphs.image("arrow-up-outline", size: 20)) { [weak self] _ in self?.actions.chooseNewVersion(of: entry) })
        }
        items.append(UIMenu(options: .displayInline, children: edits))
        guard !fixed else { return items }
        items.append(UIMenu(options: .displayInline, children: [
            UIAction(title: Strings.Vaults.delete, image: Glyphs.image("trash-outline", size: 20), attributes: .destructive) { [weak self] _ in
                guard let self else { return }
                actions.delete(entry)
                navigationController?.popViewController(animated: true)
            },
        ]))
        return items
    }

    private func openHistory() {
        navigationController?.pushViewController(VaultHistoryViewController(session: session, surfaceId: surfaceId, vaultName: vaultName, entry: entry), animated: true)
    }

    private func restoreVersion(_ number: Int) {
        let alert = UIAlertController(title: Strings.Vaults.restoreVersion, message: Strings.Vaults.restoreConfirm(number), preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Vaults.cancel, style: .cancel))
        alert.addAction(UIAlertAction(title: Strings.Vaults.restore, style: .default) { [weak self] _ in
            guard let self else { return }
            let (surfaceId, entryId) = (surfaceId, entry.id)
            actions.perform { _ = try await $0.restoreVersion(surfaceId, entryId, number: number) }
            navigationController?.popViewController(animated: true)
        })
        present(alert, animated: true)
    }

    // MARK: Content

    private func load() {
        loading?.cancel()
        let number = pinnedVersion ?? entry.latestVersion ?? 1
        if let shown, shown.version == number, pinnedVersion != nil || shown.sha256 == entry.sha256 { return }
        shown = (number, entry.sha256)
        removeContent()
        spinner.startAnimating()
        loading = Task { [weak self] in await self?.load(number) }
    }

    private func load(_ number: Int) async {
        let client = session.client
        let (surfaceId, entry) = (surfaceId, entry)
        do {
            switch VaultPreviewKind(entry) {
            case .app:
                let version = try await library.version(surfaceId, entry.id, number: number)
                try Task.checkCancellation()
                guard let artifact = version.artifact else { return show(message: Strings.artifactUnavailable) }
                let files = (artifact.files ?? []).map { AgentWire.ArtifactVersion.File(path: $0.path, mimeType: $0.mimeType, size: Double($0.size)) }
                let first = files.first { $0.path == artifact.entry } ?? AgentWire.ArtifactVersion.File(path: artifact.entry, mimeType: artifact.type == "markdown" ? "text/markdown" : "text/html", size: 0)
                let shown = AgentWire.ArtifactVersion(artifactId: entry.id, number: number, title: entry.shownName, entry: first, files: files)
                let read: ArtifactMedia.Files = .init(resource: "vault/\(surfaceId)/\(entry.id)/\(number)") { path, range in
                    try await client.vaultArtifactFile(surfaceId, entry.id, version: number, path: path, range: range)
                }
                embed(ArtifactViewController(session: session, vault: .init(surfaceId: surfaceId, entryId: entry.id, version: shown, files: read, app: true)))
            case .markdown, .image, .video:
                // An earlier version's own size, which its ranges are read by.
                var size = entry.size ?? 0
                if number != entry.latestVersion { size = try await library.version(surfaceId, entry.id, number: number).size }
                try Task.checkCancellation()
                embed(ArtifactViewController(session: session, vault: Self.file(entry, number: number, size: size, client: client)))
            case .text(let language):
                let response = try await client.vaultContent(surfaceId, entry.id, version: number)
                try Task.checkCancellation()
                let text = await Task.detached(priority: .userInitiated) { String(decoding: response.body, as: UTF8.self) }.value
                showLines(text, language: language)
            case .audio, .pdf, .other:
                try await showQuickLook(number)
            }
        } catch is CancellationError {
        } catch {
            show(message: VaultActions.message(error))
        }
    }

    /// A file as the one file of a version, read through its content route.
    static func file(_ entry: VaultEntry, number: Int, size: Int, client: AgentClient) -> ArtifactViewController.Vault {
        let file = AgentWire.ArtifactVersion.File(path: entry.name, mimeType: entry.mediaType ?? "application/octet-stream", size: Double(size))
        let (surfaceId, entryId) = (entry.surfaceId, entry.id)
        let files = ArtifactMedia.Files(resource: "vault/\(surfaceId)/\(entryId)/\(number)") { _, range in
            try await client.vaultContent(surfaceId, entryId, version: number, range: range)
        }
        return .init(surfaceId: surfaceId, entryId: entryId, version: AgentWire.ArtifactVersion(artifactId: entryId, number: number, title: entry.name, entry: file, files: [file]),
                     files: files, app: false)
    }

    private func removeContent() {
        if let child {
            child.willMove(toParent: nil)
            child.view.removeFromSuperview()
            child.removeFromParent()
        }
        child = nil
        lines?.removeFromSuperview()
        lines = nil
        linesText = nil
        plannedWidth = nil
        message.text = nil
        if let quickLook { try? FileManager.default.removeItem(at: quickLook.deletingLastPathComponent()) }
        quickLook = nil
        view.setNeedsLayout()
    }

    private func embed(_ controller: UIViewController) {
        spinner.stopAnimating()
        addChild(controller)
        view.insertSubview(controller.view, belowSubview: spinner)
        controller.didMove(toParent: self)
        child = controller
        view.setNeedsLayout()
    }

    private func show(message text: String) {
        spinner.stopAnimating()
        message.text = text
        view.setNeedsLayout()
    }

    // MARK: Text

    private func showLines(_ text: String, language: String?) {
        spinner.stopAnimating()
        let lines = FileLinesView()
        lines.accessibilityIdentifier = "vault-preview-text"
        view.insertSubview(lines, belowSubview: spinner)
        self.lines = lines
        linesText = (text, language)
        if text.isEmpty { lines.show(message: Strings.FilesDetail.fileEmpty, maxWidth: ContentWidth.maxWidth) }
        view.setNeedsLayout()
    }

    /// The lines measured off the main thread at the view's width.
    private func planLines() {
        guard let lines, let linesText, !linesText.text.isEmpty else { return }
        let width = lines.bounds.width
        guard width > 0, plannedWidth != width else { return }
        plannedWidth = width
        let syntax = session.syntax
        let text = lines.traitCollection.textEnvironment
        let source = FileLinesPlan.Source.code(linesText.text, language: linesText.language)
        let maxWidth = ContentWidth.maxWidth
        Task { [weak self, weak lines] in
            let plan = await Task.detached(priority: .userInitiated) { FileLinesPlan(source: source, width: width, maxWidth: maxWidth, syntax: syntax, text: text) }.value
            guard let self, let lines, self.lines === lines, self.plannedWidth == width else { return }
            lines.copyText = linesText.text
            lines.show(plan)
        }
    }

    // MARK: Quick Look

    /// Reads the version whole into a folder of its own, then shows it.
    private func showQuickLook(_ number: Int) async throws {
        let folder = FilePreview.root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let target = folder.appendingPathComponent(entry.name.isEmpty ? "file" : entry.name)
        let path = AgentClient.vaultContentPath(surfaceId, entry.id, version: number)
        let client = session.client
        let name = entry.name
        show(message: Strings.Vaults.downloading)
        spinner.startAnimating()
        do {
            try await Task.detached(priority: .userInitiated) { [weak self] in
                try await client.download(path, to: target) { written, total in
                    let text = total.map { "\(VaultListItems.size(written)) / \(VaultListItems.size($0))" } ?? VaultListItems.size(written)
                    Task { @MainActor in
                        guard let self, self.child == nil else { return }
                        self.message.text = "\(Strings.Vaults.downloading)\n\(name)\n\(text)"
                        self.view.setNeedsLayout()
                    }
                }
            }.value
        } catch {
            try? FileManager.default.removeItem(at: folder)
            throw error
        }
        guard !Task.isCancelled else {
            try? FileManager.default.removeItem(at: folder)
            throw CancellationError()
        }
        message.text = nil
        quickLook = target
        let preview = QLPreviewController()
        preview.dataSource = self
        embed(preview)
    }

    nonisolated func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

    nonisolated func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem {
        MainActor.assumeIsolated { (quickLook ?? URL(fileURLWithPath: "/dev/null")) as NSURL }
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        scrollView.frame = view.bounds
        child?.view.frame = view.bounds
        if let lines {
            lines.frame = view.bounds
            let safe = view.safeAreaInsets
            lines.contentInset = UIEdgeInsets(top: safe.top, left: 0, bottom: safe.bottom, right: 0)
            lines.verticalScrollIndicatorInsets = lines.contentInset
            planLines()
        }
        spinner.setLayoutFrame(ArtifactMediaLayout.spinner(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets)))
        let showsMessage = message.text != nil && child == nil && lines == nil
        scrollView.isHidden = !showsMessage
        let layout = SurfaceBodyLayout(width: view.bounds.width, body: message.measurable, inset: 16)
        message.frame = showsMessage ? layout.body : .zero
        scrollView.contentSize = CGSize(width: view.bounds.width, height: layout.contentHeight)
    }
}
#endif
