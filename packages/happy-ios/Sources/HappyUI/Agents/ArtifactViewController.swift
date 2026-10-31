#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// One artifact, or one file of it a link opened. Markdown uses the
/// conversation renderer, its pictures and recordings resolved against the
/// version's files (`ArtifactMarkdown`) and read through the file route,
/// linked ones through the computer's network. Images, image series and
/// videos show natively (`ArtifactGalleryView`), opening in the viewer.
/// Other entries use the shared browser with an artifact-scoped file/API
/// origin over the agent connection.
final class ArtifactViewController: UIViewController, ChatMediaProviding {
    private let session: Session
    private let artifact: Artifact
    /// Opened from a link in another of its files: that version, that file.
    private let opened: (version: AgentWire.ArtifactVersion, path: String)?
    private var version: AgentWire.ArtifactVersion?
    private var media: ArtifactMedia?
    private let scrollView = UIScrollView()
    private let message = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var document: ChatPlanView?
    private var documentPlan: ChatRowPlan?
    /// The prepared Markdown, the file it is, and its pictures by address.
    private var documentText: String?
    private var documentPath = ""
    private var pictures: [String: MarkdownDocument.Picture] = [:]
    /// The width the document was last planned at, or is being, and with
    /// which of its pictures' sizes.
    private var plannedWidth: CGFloat?
    private var plannedSizes = 0
    private var gallery: ArtifactGalleryView?
    private var browser: BrowserViewController?
    private var loading: Task<Void, Never>?
    /// How long the first drawing waits for the pictures' sizes, so it
    /// doesn't jump as they arrive.
    static let sizeWait: Duration = .seconds(1)

    var chatMedia: ChatMediaSource? { media }

    init(session: Session, artifact: Artifact) {
        self.session = session
        self.artifact = artifact
        opened = nil
        super.init(nibName: nil, bundle: nil)
        title = artifact.title.isEmpty ? Strings.untitledArtifact : artifact.title
        navigationItem.largeTitleDisplayMode = .never
    }

    /// A file of `version` a link in another of its files named.
    init(session: Session, artifact: Artifact, version: AgentWire.ArtifactVersion, path: String) {
        self.session = session
        self.artifact = artifact
        opened = (version, path)
        super.init(nibName: nil, bundle: nil)
        title = (path as NSString).lastPathComponent
        navigationItem.largeTitleDisplayMode = .never
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.surface)
        view.accessibilityIdentifier = "artifact"
        scrollView.alwaysBounceVertical = true
        view.addSubview(scrollView)
        message.font = Fonts.ui(.regular, size: 15)
        message.textColor = UIColor(Palette.rowText)
        message.textAlignment = .center
        message.numberOfLines = 0
        message.accessibilityIdentifier = "artifact-message"
        scrollView.addSubview(message)
        spinner.hidesWhenStopped = true
        view.addSubview(spinner)
        spinner.startAnimating()
        scrollView.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped(_:))))
        loading = Task { [weak self] in await self?.load() }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isMovingFromParent || isBeingDismissed || navigationController?.isBeingDismissed == true { loading?.cancel() }
    }

    private func load() async {
        let client = session.client
        let artifact = artifact
        do {
            let version: AgentWire.ArtifactVersion
            if let opened {
                version = opened.version
            } else {
                version = try await client.artifactVersion(artifact.id, version: artifact.opensLatest ? nil : artifact.version)
                if !version.title.isEmpty { title = version.title }
            }
            self.version = version
            if let live = version.live, let url = URL(string: live.url) {
                showBrowser(BrowserViewController(url: url, session: session, artifactID: artifact.id))
                return
            }
            guard let entry = version.entry else { return show(message: Strings.artifactUnavailable) }
            let path = opened?.path ?? entry.path
            guard let file = version.files.first(where: { $0.path == path }) ?? (path == entry.path ? entry : nil) else {
                return show(message: Strings.artifactUnavailable)
            }
            let media = ArtifactMedia(client: client, artifactId: artifact.id, version: version.number)
            self.media = media
            if Self.isMarkdown(file) {
                try await showDocument(file, version: version, media: media)
            } else if ArtifactMedia.isVisual(file) {
                // An image series is all of its pictures, in path order.
                let shown = file == entry ? version.files.filter(ArtifactMedia.isVisual) : [file]
                await showGallery(shown.isEmpty ? [file] : shown, media: media)
            } else {
                try await showWeb(version: version.number, entry: file.path)
            }
        } catch is CancellationError {
        } catch AgentClientError.status(404, _, _) {
            show(message: Strings.artifactDeleted)
        } catch {
            show(message: Strings.artifactUnavailable)
        }
    }

    static func isMarkdown(_ file: AgentWire.ArtifactVersion.File) -> Bool {
        let ext = (file.path as NSString).pathExtension.lowercased()
        return file.mimeType.hasPrefix("text/markdown") || ext == "md" || ext == "markdown"
    }

    private func show(message text: String) {
        spinner.stopAnimating()
        message.text = text
        view.setNeedsLayout()
    }

    // MARK: Markdown

    /// The Markdown with each picture it shows registered with the media
    /// source, drawn once their sizes are in (or a second has gone by), and
    /// drawn again as the rest arrive.
    private func showDocument(_ file: AgentWire.ArtifactVersion.File, version: AgentWire.ArtifactVersion, media: ArtifactMedia) async throws {
        let key = ArtifactMedia.key(file.path)
        _ = media.media(file)
        guard let body = await media.data(key) else { throw AgentClientError.invalidResponse }
        try Task.checkCancellation()
        let prepared = await Task.detached(priority: .userInitiated) {
            let text = ArtifactMarkdown.prepare(String(decoding: body, as: UTF8.self))
            return (text, ArtifactMarkdown.pictures(text))
        }.value
        documentPath = file.path
        let files = Dictionary(version.files.map { ($0.path, $0) }, uniquingKeysWith: { first, _ in first })
        for raw in prepared.1 where pictures[raw] == nil {
            let label = Strings.picture
            let shown: ChatMedia?
            switch ArtifactMarkdown.resolve(raw, from: file.path) {
            case .file(let path, _):
                shown = files[path].flatMap { ArtifactMedia.isVisual($0) ? media.media($0) : nil }
            case .web(let url): shown = media.media(web: url, label: label)
            case .data(let url): shown = media.media(data: url, label: label)
            case .fragment, .external, .refused: shown = nil
            }
            if let shown { pictures[raw] = MarkdownDocument.Picture(media: shown, size: nil) }
        }
        documentText = prepared.0
        let keys = Array(Set(pictures.values.map(\.media.key)))
        let sizes = Task { [weak self] in
            await withTaskGroup(of: Void.self) { group in
                for key in keys { group.addTask { _ = await media.pixelSize(key) } }
                for await _ in group { self?.sizeArrived() }
            }
        }
        await firstOf(sizes, within: Self.sizeWait)
        try Task.checkCancellation()
        await plan()
    }

    /// Waits for `task`, no longer than `limit`.
    private func firstOf(_ task: Task<Void, Never>, within limit: Duration) async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await task.value }
            group.addTask { try? await Task.sleep(for: limit) }
            await group.next()
            group.cancelAll()
        }
    }

    private var replanning = false
    private var planning = 0

    /// A picture's size is in: the document is planned again, once for
    /// all that arrive together.
    private func sizeArrived() {
        guard documentPlan != nil, !replanning else { return }
        replanning = true
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(100))
            guard let self else { return }
            self.replanning = false
            await self.plan()
        }
    }

    /// The Markdown planned off the main thread, as a conversation's agent
    /// text, at the view's width with the pictures' sizes known so far;
    /// layout plans again when the width changes.
    private func plan() async {
        guard let text = documentText, let media else { return }
        let width = view.bounds.width
        guard width > 0 else { view.setNeedsLayout(); return }
        var shown = pictures
        for (raw, picture) in shown { shown[raw]?.size = media.knownSize(picture.media.key) }
        let known = shown.values.filter { $0.size != nil }.count
        guard plannedWidth != width || plannedSizes != known || documentPlan == nil else { return }
        plannedWidth = width
        plannedSizes = known
        planning += 1
        let generation = planning
        let key = ChatPlanner.Key(width: width, maxContentWidth: ContentWidth.maxWidth, environment: traitCollection.textEnvironment)
        let syntax = session.syntax
        let id = "artifact:\(artifact.id):\(documentPath)"
        let plan = await Task.detached(priority: .userInitiated) {
            Self.plan(text, id: id, key: key, syntax: syntax, document: MarkdownDocument(pictures: shown))
        }.value
        // Only the newest plan is drawn.
        guard generation == planning else { return }
        spinner.stopAnimating()
        documentPlan = plan
        let planView = document ?? {
            let planView = ChatPlanView()
            planView.drawsStaticContent = true
            planView.isAccessibilityElement = true
            planView.accessibilityIdentifier = "artifact-document"
            scrollView.addSubview(planView)
            document = planView
            return planView
        }()
        planView.apply(plan)
        planView.accessibilityLabel = plan.accessibilityLabel
        view.setNeedsLayout()
    }

    /// The agent text's look (desktop's Figtree 16/24 markdown) in the
    /// reading column, its pictures in their own shapes.
    nonisolated static func plan(_ text: String, id: String, key: ChatPlanner.Key, syntax: CodeSyntaxService, document: MarkdownDocument) -> ChatRowPlan {
        let markdown = MarkdownPiece(
            text, color: Palette.text, diagrams: ChatMermaidHeights(row: id), syntax: syntax, in: key.environment,
            body: ChatTextStyles.text, header: ChatTextStyles.header, document: document
        )
        let layout = MessageLayout.agent(width: key.width, maxContentWidth: key.maxContentWidth, parts: [.markdown(markdown.blocks)])
        guard case .markdown(let placed, let origin)? = layout.parts.first else { return ChatRowPlan(id: id, size: layout.size, items: []) }
        let drawn = markdown.draw(placed, origin: origin)
        return ChatRowPlan(id: id, size: layout.size, items: drawn.items, hits: drawn.hits, accessibilityLabel: text)
    }

    /// Every picture and recording the document shows, in its order, once each.
    private var documentPictures: [Picture] {
        guard let text = documentText else { return [] }
        var seen = Set<String>()
        return ArtifactMarkdown.pictures(text).compactMap { raw in
            guard let picture = pictures[raw], seen.insert(picture.media.key).inserted else { return nil }
            return Picture(key: picture.media.key, thumbhash: nil, label: picture.media.label, size: media?.knownSize(picture.media.key), isVideo: picture.media.isVideo)
        }
    }

    @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
        guard let document else { return }
        let point = recognizer.location(in: document)
        if let link = document.link(at: point) {
            open(link: link)
        } else if case .openMedia(let key)? = document.action(at: point) {
            openDocumentPicture(key)
        }
    }

    /// The viewer on one of the document's pictures, swiped through the rest in its order.
    func openDocumentPicture(_ key: String) {
        let all = documentPictures
        openViewer(all, index: all.firstIndex { $0.key == key } ?? 0)
    }

    /// A link in the document: another of the artifact's files opens here,
    /// pushed; an address on the web in the browser, through the computer.
    func open(link: String) {
        switch ArtifactMarkdown.resolve(link, from: documentPath) {
        case .file(let path, _):
            guard let version, let media, let file = version.files.first(where: { $0.path == path }) else { return show(alert: Strings.ArtifactMedia.fileUnavailable) }
            if ArtifactMedia.isVisual(file), !Self.isMarkdown(file) {
                let shown = media.media(file)
                openViewer([Picture(key: shown.key, thumbhash: nil, label: shown.label, size: media.knownSize(shown.key), isVideo: shown.isVideo)], index: 0)
            } else {
                navigationController?.pushViewController(ArtifactViewController(session: session, artifact: artifact, version: version, path: path), animated: true)
            }
        case .web(let url):
            openBrowser(url, session: session)
        case .external(let url):
            UIApplication.shared.open(url)
        case .fragment, .data, .refused:
            break
        }
    }

    private func show(alert text: String) {
        let alert = UIAlertController(title: nil, message: text, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Common.ok, style: .default))
        present(alert, animated: true)
    }

    private func openViewer(_ pictures: [Picture], index: Int) {
        guard let media, !pictures.isEmpty else { return }
        present(PictureViewController(source: media, pictures: pictures, index: index), animated: true)
    }

    // MARK: Pictures and recordings

    /// The files in a grid, or one large; drawn once their sizes are in
    /// (or a second has gone by), and laid out again as the rest arrive.
    private func showGallery(_ files: [AgentWire.ArtifactVersion.File], media: ArtifactMedia) async {
        let shown = files.map { media.media($0) }
        let gallery = ArtifactGalleryView()
        gallery.onOpen = { [weak self] index in self?.openGallery(at: index) }
        self.gallery = gallery
        let sizes = Task { [weak self] in
            await withTaskGroup(of: Void.self) { group in
                for item in shown {
                    group.addTask {
                        _ = await media.pixelSize(item.key)
                        if item.isVideo { _ = await media.duration(item.key) }
                    }
                }
                for await _ in group { self?.updateGallery() }
            }
        }
        gallery.apply(shown.map { ArtifactGalleryView.Item(media: $0) })
        await firstOf(sizes, within: Self.sizeWait)
        guard !Task.isCancelled else { return }
        spinner.stopAnimating()
        scrollView.isHidden = true
        view.insertSubview(gallery, belowSubview: spinner)
        updateGallery()
        view.setNeedsLayout()
    }

    private func updateGallery() {
        guard let gallery, let media else { return }
        gallery.apply(gallery.items.map { item in
            var item = item
            item.size = media.knownSize(item.media.key)
            if item.media.isVideo, item.duration == nil { item.duration = media.cachedDuration(item.media.key) }
            return item
        })
    }

    private func openGallery(at index: Int) {
        guard let gallery, let media else { return }
        let pictures = gallery.items.map { Picture(key: $0.media.key, thumbhash: nil, label: $0.media.label, size: media.knownSize($0.media.key), isVideo: $0.media.isVideo) }
        openViewer(pictures, index: index)
    }

    // MARK: Pages

    private func showWeb(version: Int, entry: String) async throws {
        let page = try await BrowserPage.artifact(client: session.client, id: artifact.id, version: version, entry: entry)
        try Task.checkCancellation()
        showBrowser(BrowserViewController(url: page.url, session: session, artifactID: artifact.id, page: page))
    }

    private func showBrowser(_ browser: BrowserViewController) {
        spinner.stopAnimating()
        addChild(browser)
        view.addSubview(browser.view)
        browser.didMove(toParent: self)
        self.browser = browser
        view.setNeedsLayout()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        scrollView.frame = view.bounds
        gallery?.frame = view.bounds
        browser?.view.frame = view.bounds
        spinner.setLayoutFrame(ArtifactMediaLayout.spinner(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets)))
        let width = view.bounds.width
        if documentText != nil, width > 0, plannedWidth != width {
            Task { await plan() }
        }
        let showsMessage = message.text != nil
        let body = showsMessage ? message.measurable : Measurable.fixed(width: width, height: documentPlan?.size.height ?? 0)
        let layout = SurfaceBodyLayout(width: width, body: body, inset: showsMessage ? 16 : 0)
        document?.setLayoutFrame(showsMessage ? .zero : layout.body)
        message.isHidden = !showsMessage
        message.frame = showsMessage ? layout.body : .zero
        scrollView.contentSize = CGSize(width: width, height: layout.contentHeight)
    }
}
#endif
