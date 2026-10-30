#if canImport(UIKit)
import AVKit
import HappyCore
import HappyLayout
import UIKit

/// A conversation's detail, pushed from its header's capsule: the legacy
/// app's session screen made over in Settings' glass style. Its mark and
/// name (the pencil after it renames it where it stands, as Settings' name
/// is); where it sits in the sidebar's tree, drawn by the sidebar's own
/// rows; its model, effort and when it started as tiles; what it shared,
/// Telegram's shared media in our style (its pictures, recordings and files
/// in a grid, then the links written in it); and desktop's Activity: the
/// children at work and the terminals running, then the settled children
/// under a fold. Every row opens its conversation. Nothing is drawn over
/// its top but the back button's glass. Frames are
/// `SessionDetailLayout`'s; what it shows is read off the main
/// thread (`LegacySessionDetailFeed`, `SharedFeed`) and again
/// as the conversation's events come.
final class SessionDetailViewController: UIViewController, UIGestureRecognizerDelegate, UIScrollViewDelegate {
    private let session: Session
    private let agentId: String
    private let spaceId: String?
    /// Renamed here: the conversation under it keeps new work it would
    /// otherwise put away.
    var onRenamed: (() -> Void)?

    private let feed: SessionDetailFeed
    /// The conversation as its screen holds it: what it shared, at once.
    private let warm: (chat: WarmChats.Chat, token: UUID)
    /// What it shared further back, a page of history at a time.
    private let sharedFeed: SharedFeed
    private var sharedState = SharedFeed.State()
    /// The transcript's and the history's, newest first.
    private var shared = Shared()
    private var mediaLimit = SessionDetailViewController.mediaPage
    private var linksLimit = SessionDetailViewController.linksPage
    private var asking: Task<Void, Never>?
    /// What a "Show more" asked while history was being read: asked once it's in.
    private var pendingAsk = (media: false, links: false)
    private var reader = Shared.Reader()
    private var previewing: Task<Void, Never>?
    private lazy var loader = MediaLoader(client: session.client, agentId: agentId)
    private var preview: FilePreview?
    /// Four rows of media, five links; each "Show more" as many again.
    private static let mediaPage = 12
    private static let linksPage = 5
    private var detail: SessionDetail?
    private var chat = ChatSnapshot()
    private var row: Row?
    private var family: [Row] = []
    private var completedOpen = false
    private var heldName: String?

    private let scroll = DetailScrollView()
    private let mark = DetailMarkView()
    private let name = UILabel()
    private let pencil = UIButton(type: .system)
    private var nameField: RenameField?
    private let subtitle = UILabel()
    private let tiles = (0..<3).map { _ in DetailTileView() }
    private let mediaHeading = DetailTileView.heading()
    private let mediaCard = DetailMediaCardView()
    private let linksHeading = DetailTileView.heading()
    private let linksCard = DetailActivityCardView()
    private let familyHeading = DetailTileView.heading()
    private let familyCard = DetailCardView()
    private let tree = SidebarView()
    private let activityHeading = DetailTileView.heading()
    private let running = DetailActivityCardView()
    private let completed = DetailActivityCardView()
    private var watch: Watch?
    private var following: Task<Void, Never>?

    private static let treePadding: CGFloat = 8

    /// `title` is what its screen called it, for one the sidebar doesn't hold.
    init(session: Session, agentId: String, title: String, spaceId: String?) {
        self.session = session
        self.agentId = agentId
        self.spaceId = spaceId
        fallbackTitle = title.isEmpty ? nil : title
        feed = SessionDetailFeed(client: session.client, store: session.store, agentId: agentId)
        sharedFeed = SharedFeed(client: session.client, agentId: agentId)
        warm = session.warm.hold(agentId)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.settingsGround)
        view.accessibilityIdentifier = "detail"
        scroll.alwaysBounceVertical = true
        scroll.delegate = self
        scroll.keyboardDismissMode = .interactive
        view.addSubview(scroll)
        mark.images = session.images
        scroll.addSubview(mark)
        name.font = Fonts.ui(.medium, size: 28)
        name.textColor = UIColor(Palette.settingsText)
        name.textAlignment = .center
        name.lineBreakMode = .byTruncatingTail
        name.accessibilityIdentifier = "detail-name"
        name.accessibilityTraits = .header
        name.isUserInteractionEnabled = true
        name.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(nameTapped)))
        scroll.addSubview(name)
        pencil.setImage(Glyphs.image("pencil", size: 16), for: .normal)
        pencil.tintColor = UIColor(Palette.settingsSecondary)
        pencil.accessibilityLabel = Strings.rename
        pencil.accessibilityIdentifier = "detail-rename-button"
        pencil.isHidden = true
        pencil.addAction(UIAction { [weak self] _ in self?.beginRename() }, for: .touchUpInside)
        scroll.addSubview(pencil)
        subtitle.font = Fonts.ui(.regular, size: 17)
        subtitle.textColor = UIColor(Palette.settingsSecondary)
        subtitle.textAlignment = .center
        subtitle.accessibilityIdentifier = "detail-subtitle"
        scroll.addSubview(subtitle)
        for (tile, id) in zip(tiles, ["model", "effort", "started"]) {
            tile.accessibilityIdentifier = "detail-tile:\(id)"
            scroll.addSubview(tile)
        }
        mediaHeading.text = Strings.media.uppercased()
        scroll.addSubview(mediaHeading)
        mediaCard.source = loader
        mediaCard.accessibilityIdentifier = "detail-media"
        mediaCard.onSelect = { [weak self] index in self?.openMedia(index) }
        mediaCard.onMore = { [weak self] in self?.showMore(media: true) }
        scroll.addSubview(mediaCard)
        linksHeading.text = Strings.links.uppercased()
        scroll.addSubview(linksHeading)
        linksCard.accessibilityIdentifier = "detail-links"
        linksCard.onSelect = { [weak self] index in self?.openLink(index) }
        scroll.addSubview(linksCard)
        familyHeading.text = Strings.family.uppercased()
        scroll.addSubview(familyHeading)
        tree.scrolls = false
        tree.padding = (Self.treePadding, Self.treePadding)
        tree.images = session.images
        tree.onSelect = { [weak self] row in self?.open(row) }
        tree.accessibilityIdentifier = "detail-family"
        familyCard.addSubview(tree)
        scroll.addSubview(familyCard)
        activityHeading.text = Strings.activity.uppercased()
        scroll.addSubview(activityHeading)
        running.onSelect = { [weak self] index in self?.openChild(self?.detail?.running, index) }
        running.accessibilityIdentifier = "detail-running"
        scroll.addSubview(running)
        completed.onSelect = { [weak self] index in self?.openChild(self?.detail?.completed, index) }
        completed.accessibilityIdentifier = "detail-completed"
        scroll.addSubview(completed)
        scroll.addGestureRecognizer({
            let tap = UITapGestureRecognizer(target: self, action: #selector(tappedAway))
            tap.cancelsTouchesInView = false
            tap.delegate = self
            return tap
        }())

        navigationItem.largeTitleDisplayMode = .never

        watch = session.watch { [weak self] snapshot in self?.follow(snapshot) }
        session.warm.watch(warm.chat, token: warm.token) { [weak self] snapshot in
            guard let self else { return }
            let items = chat.items
            chat = snapshot
            applyNumbers()
            if snapshot.items != items { applyShared() }
        }
        chat = warm.chat.snapshot
        let updates = feed.updates
        following = Task { [weak self] in
            for await state in updates {
                guard let self else { return }
                if let detail = state.detail { self.detail = detail }
                self.applyName()
                self.applyNumbers()
                self.applyActivity()
            }
        }
        let feed = feed
        Task { await feed.start() }
        applyNumbers()
        applyActivity()
        applyShared()
        askShared(media: true, links: true)
        #if DEBUG
        if let mode = ProcessInfo.processInfo.environment["HAPPY_DETAIL_PROBE"] { startProbe(relayout: mode == "relayout") }
        #endif
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        guard isMovingFromParent || navigationController == nil else { return }
        finish()
    }

    private var finished = false

    /// Done with what it read and held, once.
    private func finish() {
        guard !finished else { return }
        finished = true
        following?.cancel()
        asking?.cancel()
        previewing?.cancel()
        #if DEBUG
        probe?.link.invalidate()
        #endif
        watch?.invalidate()
        let feed = feed
        Task { await feed.stop() }
        session.warm.release(warm.chat, token: warm.token, opened: false)
    }

    /// Taken off a stack while covered (popped to the root, a stack
    /// replaced): no disappearance tells it.
    override func didMove(toParent parent: UIViewController?) {
        super.didMove(toParent: parent)
        if parent == nil { finish() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        endEditingName(keep: true)
    }

    // MARK: What it shows

    /// Its row as the sidebar has it now: name, mark, kind, and its family.
    private func follow(_ snapshot: Snapshot) {
        let rows = snapshot.allRows
        let found = spaceId.flatMap { id in rows.first { $0.spaceId == id && $0.kind == .space } } ?? rows.first { $0.agentId == agentId && ($0.kind == .space || $0.kind == .session) }
        row = found
        if let heldName, found?.label == heldName { self.heldName = nil }
        applyName()
        let next = found.map { Family.of($0.id, in: rows) } ?? []
        // Alone, it has no family worth a card.
        family = next.count > 1 ? next : []
        _ = tree.apply(family)
        tree.selectedRowId = found?.id
        view.setNeedsLayout()
    }

    private let fallbackTitle: String?

    /// Its row's name, mark and kind; else, for a subagent the sidebar
    /// doesn't hold, what its screen and the daemon call it.
    private func applyName() {
        name.text = heldName ?? row?.label ?? detail?.title ?? fallbackTitle ?? Strings.untitledSession
        mark.mark = row?.mark ?? .glyph("agents")
        subtitle.text = row.map { Self.subtitle($0) } ?? Self.subtitle(subtask: detail?.subtask == true, working: detail?.working == true)
        // The name is as wide as its text, its pencil just after it.
        view.setNeedsLayout()
    }

    /// A task or a bot is renamed; Happy never.
    private var canRename: Bool {
        guard let row, spaceId != nil else { return false }
        return !row.isHappy && (row.targetKind == "task" || row.targetKind == "bot")
    }

    private static func subtitle(subtask: Bool, working: Bool) -> String {
        [subtask ? Strings.subtask : Strings.subagent, working ? Strings.phaseWorking : nil].compactMap { $0 }.joined(separator: " · ")
    }

    private static func subtitle(_ row: Row) -> String {
        let kind = row.kind == .session ? Strings.subtask
            : row.targetKind == "bot" ? Strings.bot
            : row.targetKind == "task" ? Strings.task
            : Strings.conversation
        let status: String? = switch row.status {
        case .working, .waiting: Strings.phaseWorking
        case .awaitingInput: Strings.phaseAwaitingAnswer
        case .none: nil
        }
        return [kind, status].compactMap { $0 }.joined(separator: " · ")
    }

    /// The tiles: model, effort, and when it started.
    private func applyNumbers() {
        let none = Strings.none
        let mode = detail?.mode ?? chat.mode
        let menus = session.models.catalog.flatMap { catalog in mode.map { ModelMenus(catalog: catalog, selection: $0) } }
        let values: [(String, String)] = [
            (menus?.current?.label ?? mode?.modelId ?? none, Strings.model),
            ((menus?.effort ?? mode?.effort).map(ModelMenus.effortName) ?? none, Strings.effort),
            (detail?.createdAt.map { Strings.started(DetailFormat.started(since: $0, now: Date())) } ?? none, Strings.started),
        ]
        for (tile, (value, label)) in zip(tiles, values) { tile.show(value: value, label: label) }
    }

    // MARK: Shared

    /// What the transcript in hand shows, then what history adds behind it.
    private func applyShared(force: Bool = false) {
        let next = reader.read(chat.items).merged(older: sharedState.shared)
        guard force || next != shared else { return }
        shared = next
        let media = shownMedia
        // Every picture, for the viewer to page through; the bytes are
        // the ones `shared` holds, not copied.
        loader.register([ChatItem(id: "shared", role: .agent, pieces: shared.media.map { one in
            switch one {
            case .picture(let id, let mimeType, let data): .picture(id: id, mimeType: mimeType, data: data)
            case .tool(let media): media.isVisual ? .gallery([media], columns: 0) : .file(media)
            }
        }, delivery: .sent)])
        mediaCard.show(media)
        linksCard.show(shownLinks.map { link in
            .init(glyph: "link-outline", tile: .blue, title: link.title ?? link.host, meta: Self.address(link.url), opens: true, id: "detail-link:\(link.url)")
        }, disclosure: nil, more: SettingsRow(id: "links-more", title: Strings.showMore, accessory: .none, action: { [weak self] in self?.showMore(media: false) }))
        view.setNeedsLayout()
    }

    private var shownMedia: [Shared.Media] { Array(shared.media.prefix(mediaLimit)) }
    private var shownLinks: [Shared.Link] { Array(shared.links.prefix(linksLimit)) }

    /// More than is shown, or history still unread that may hold more.
    private func hasMore(_ count: Int, limit: Int) -> Bool {
        count > limit || sharedState.hasMore
    }

    /// History back far enough for one more than the asked sections show,
    /// so each knows whether there is more. Asked while reading, it asks
    /// again once that is in.
    private func askShared(media: Bool, links: Bool) {
        guard asking == nil else {
            pendingAsk = (pendingAsk.media || media, pendingAsk.links || links)
            return
        }
        let feed = sharedFeed
        let targets = (media: media ? mediaLimit + 1 : nil, links: links ? linksLimit + 1 : nil)
        asking = Task { [weak self] in
            let state = await feed.load(media: targets.media, links: targets.links)
            guard let self, !Task.isCancelled else { return }
            asking = nil
            sharedState = state
            applyShared(force: true)
            let next = pendingAsk
            pendingAsk = (false, false)
            if next.media || next.links { askShared(media: next.media, links: next.links) }
        }
    }

    private func showMore(media: Bool) {
        Haptics.play(.fold)
        if media { mediaLimit += Self.mediaPage } else { linksLimit += 2 * Self.linksPage }
        applyShared(force: true)
        askShared(media: media, links: !media)
    }

    /// A link as it reads under its title: no scheme, no `www.`, no slash at its end.
    static func address(_ url: String) -> String {
        var text = url
        for prefix in ["https://", "http://"] where text.hasPrefix(prefix) { text.removeFirst(prefix.count) }
        if text.hasPrefix("www.") { text.removeFirst(4) }
        if text.hasSuffix("/") { text.removeLast() }
        return text
    }

    private func applyActivity() {
        guard let detail else { return }
        running.show(
            detail.running.map { child in
                .init(glyph: "agents", tile: .purple, title: child.title ?? Strings.subagent, meta: Self.meta(child), opens: true)
            } + detail.terminals.map { terminal in
                let age = terminal.startedAt.map { Strings.age(DetailFormat.age(since: $0, now: Date().timeIntervalSince1970 * 1000)) }
                return .init(glyph: "terminal", tile: .gray, title: terminal.command, meta: [Strings.terminalRunning, age].compactMap { $0 }.joined(separator: " · "), opens: false)
            },
            disclosure: nil
        )
        completed.show(
            detail.completed.map { child in
                .init(glyph: "agents", tile: .gray, title: child.title ?? Strings.subagent, meta: Self.meta(child), opens: true)
            },
            disclosure: SettingsRow(id: "completed", title: Strings.completed, icon: ("checkbox-outline", .green), value: "\(detail.completed.count)", accessory: .chevron, action: { [weak self] in self?.toggleCompleted() })
        )
        completed.open = completedOpen
        view.setNeedsLayout()
    }

    private static func meta(_ child: SessionDetail.Child) -> String {
        [Strings.activityStatus(child.status, archived: child.archived), child.tokens.map(Strings.tokenCount)].compactMap { $0 }.joined(separator: " · ")
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width
        // Set again only when it changed: a scroll view given its frame,
        // even the same one, while pulled past an end snaps its offset
        // back, and the stretch jags under the finger as a working
        // conversation lays this screen out again and again.
        if scroll.frame != view.bounds { scroll.frame = view.bounds }
        let side = SessionDetailLayout.Metrics.side
        let cardWidth = max(0, width - 2 * side)
        let familyHeight: CGFloat? = family.isEmpty ? nil : SidebarLayout.layout(
            SidebarView.layoutRows(family), width: cardWidth, top: Self.treePadding, bottom: Self.treePadding, scale: traitCollection.displayScale
        ).contentHeight
        let workCount = (detail?.running.count ?? 0) + (detail?.terminals.count ?? 0)
        let settled = detail?.completed.count ?? 0
        let layout = SessionDetailLayout(
            width: width, nameHeight: ceil(name.font.lineHeight),
            nameWidth: name.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: name.font.lineHeight)).width,
            renames: canRename, subtitleHeight: ceil(subtitle.font.lineHeight), tiles: tiles.count,
            media: .init(count: shownMedia.count, more: hasMore(shared.media.count, limit: mediaLimit)),
            links: .init(count: shownLinks.count, more: hasMore(shared.links.count, limit: linksLimit)),
            family: familyHeight, running: workCount, completed: settled,
            countWidth: SettingsCardView.valueWidth("\(settled)") ?? 0, open: completedOpen
        )
        mark.frame = layout.mark
        name.frame = layout.name
        nameField?.frame = layout.field
        pencil.isHidden = layout.pencilTouch == nil || nameField != nil
        if let frame = layout.pencilTouch { pencil.frame = frame }
        subtitle.frame = layout.subtitle
        for (tile, frame) in zip(tiles, layout.tiles) { tile.place(frame) }
        mediaHeading.isHidden = layout.media == nil
        mediaCard.isHidden = layout.media == nil
        if let frame = layout.mediaHeading { mediaHeading.frame = frame }
        if let card = layout.media { mediaCard.place(card) }
        linksHeading.isHidden = layout.links == nil
        linksCard.isHidden = layout.links == nil
        if let frame = layout.linksHeading { linksHeading.frame = frame }
        if let card = layout.links { linksCard.place(frame: card.frame, disclosure: nil, rows: card.rows, more: card.more) }
        familyHeading.isHidden = layout.family == nil
        familyCard.isHidden = layout.family == nil
        if let frame = layout.familyHeading { familyHeading.frame = frame }
        if let frame = layout.family {
            familyCard.frame = frame
            if tree.frame != familyCard.bounds { tree.frame = familyCard.bounds }
        }
        activityHeading.isHidden = layout.activityHeading == nil
        if let frame = layout.activityHeading { activityHeading.frame = frame }
        running.isHidden = layout.running == nil
        if let card = layout.running { running.place(card) }
        completed.isHidden = layout.completed == nil
        if let card = layout.completed { completed.place(card) }
        let size = CGSize(width: width, height: layout.contentHeight)
        // Grown or shrunk while pulled past an end, it takes its new size
        // once it is back (it bounces to its old end first) or at rest.
        if let size = heldSize.laidOut(size, current: scroll.contentSize, holding: holding) { scroll.contentSize = size }
    }

    private var heldSize = SessionDetailLayout.HeldSize()

    private var stretched: Bool {
        SessionDetailLayout.stretched(
            offset: scroll.contentOffset.y, top: scroll.adjustedContentInset.top, bottom: scroll.adjustedContentInset.bottom,
            contentHeight: scroll.contentSize.height, viewport: scroll.bounds.height
        )
    }

    /// A finger pulls it, or it bounces, past an end.
    private var holding: Bool { (scroll.isTracking || scroll.isDecelerating) && stretched }

    private func applyHeldSize() {
        if let size = heldSize.release(current: scroll.contentSize, holding: holding) { scroll.contentSize = size }
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        if heldSize.held != nil { applyHeldSize() }
        #if DEBUG
        probe?.watch()
        #endif
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { applyHeldSize() }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { applyHeldSize() }

    #if DEBUG
    /// For the UI tests: while a finger pulls the screen past an end, how
    /// often the content stepped back against the pull, as the scroll
    /// view's value; with `relayout`, the screen laid out again on every
    /// frame meanwhile, as a working conversation lays it out.
    private final class Probe: NSObject {
        weak var screen: SessionDetailViewController?
        var link: CADisplayLink!
        private let relayout: Bool
        private var last: CGFloat?
        private var lastStretched = false
        private var stretchedFrames = 0
        private var backwards = 0

        @MainActor init(_ screen: SessionDetailViewController, relayout: Bool) {
            self.screen = screen
            self.relayout = relayout
            super.init()
            link = CADisplayLink(target: self, selector: #selector(tick))
            link.add(to: .main, forMode: .common)
        }

        @MainActor @objc private func tick() {
            guard let screen else { return link.invalidate() }
            if relayout {
                screen.view.setNeedsLayout()
                screen.view.layoutIfNeeded()
            }
            watch()
        }

        @MainActor func watch() {
            guard let screen else { return }
            let scroll = screen.scroll
            let y = scroll.contentOffset.y
            let stretched = screen.stretched
            defer { (last, lastStretched) = (y, stretched) }
            // A step from a stretch back inside counts too: a snap back
            // is the jag.
            guard scroll.isTracking, stretched || lastStretched, let last else { return }
            if stretched { stretchedFrames += 1 }
            // Pulled past the top the offset falls, past the bottom it
            // rises; which end is the nearer one.
            let first = -scroll.adjustedContentInset.top
            let end = max(first, scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height)
            let atTop = y < (first + end) / 2
            if atTop ? y > last + 0.5 : y < last - 0.5 { backwards += 1 }
            scroll.accessibilityValue = "stretched=\(stretchedFrames) backwards=\(backwards)"
        }
    }

    private var probe: Probe?

    private func startProbe(relayout: Bool) {
        scroll.accessibilityIdentifier = "detail-scroll"
        scroll.accessibilityValue = "stretched=0 backwards=0"
        probe = Probe(self, relayout: relayout)
    }
    #endif

    // MARK: Acts

    /// Another conversation of the family, over this one; this one's own
    /// row goes back to it.
    private func open(_ row: Row) {
        guard let agentId = row.agentId, row.kind == .space || row.kind == .session, row.targetKind != "surface" else { return }
        if agentId == self.agentId { navigationController?.popViewController(animated: true); return }
        let intro: ChatViewController.Intro? = switch row.mark {
        case .seedling(let seed): .seedling(seed: seed)
        case .clay(let slug): .clay(slug)
        default: nil
        }
        navigationController?.pushViewController(ChatViewController(session: session, agentId: agentId, title: row.label, spaceId: row.spaceId, seedling: intro), animated: true)
    }

    private func openChild(_ children: [SessionDetail.Child]?, _ index: Int) {
        guard let children, children.indices.contains(index) else { return }
        let child = children[index]
        let title = child.title ?? Strings.subagent
        navigationController?.pushViewController(ChatViewController(session: session, agentId: child.id, title: title, spaceId: nil, seedling: nil), animated: true)
    }

    /// A picture in the viewer, paging through every picture shared; a
    /// recording in the system's player; a file in Quick Look.
    private func openMedia(_ index: Int) {
        let media = shownMedia
        guard media.indices.contains(index) else { return }
        let one = media[index]
        if case .tool(let file) = one, !file.isVisual {
            // The last file asked for, while this screen still shows.
            previewing?.cancel()
            let preview = FilePreview(loader: loader, media: file)
            self.preview = preview
            previewing = Task { [weak self] in
                guard let controller = await preview.controller(), !Task.isCancelled,
                      let self, self.preview === preview, self.viewIfLoaded?.window != nil, self.presentedViewController == nil else { return }
                self.present(controller, animated: true)
            }
            return
        }
        if let player = loader.player(one.key) {
            let playback = AVPlayerViewController()
            playback.player = player
            present(playback, animated: true) { player.play() }
            return
        }
        let pictures = shared.media.filter(\.isPicture).map { picture -> Picture in
            switch picture {
            case .picture: Picture(key: picture.key, thumbhash: nil, label: Strings.picture)
            case .tool(let media): Picture(key: media.key, thumbhash: media.item.thumbhash, label: media.item.name)
            }
        }
        guard let at = pictures.firstIndex(where: { $0.key == one.key }) else { return }
        present(PictureViewController(source: loader, pictures: pictures, index: at), animated: true)
    }

    private func openLink(_ index: Int) {
        let links = shownLinks
        guard links.indices.contains(index), let url = URL(string: links[index].url) else { return }
        UIApplication.shared.open(url)
    }

    private func toggleCompleted() {
        Haptics.play(.fold)
        completedOpen.toggle()
        completed.open = completedOpen
        if completedOpen, let detail {
            // Placed where they open before the card grows over them.
            UIView.performWithoutAnimation {
                completed.placeRows(SessionDetailLayout(
                    width: view.bounds.width, nameHeight: 0, subtitleHeight: 0, tiles: 0, family: nil,
                    running: 0, completed: detail.completed.count, open: true
                ).completed)
            }
        }
        UIView.animate(withDuration: 0.25, delay: 0, options: [.beginFromCurrentState, .curveEaseInOut]) {
            self.view.setNeedsLayout()
            self.view.layoutIfNeeded()
        }
    }

    // MARK: Rename

    @objc private func nameTapped() { beginRename() }

    /// The name, in place, as a field, as Settings' is; Return or a tap away keeps it.
    private func beginRename() {
        guard nameField == nil, canRename, let row else { return }
        let field = RenameField()
        field.font = name.font
        field.textColor = name.textColor
        field.tintColor = UIColor(Palette.settingsPrimary)
        field.textAlignment = .center
        field.text = row.label == Strings.untitled ? "" : (heldName ?? row.label)
        field.returnKeyType = .done
        field.autocapitalizationType = .sentences
        field.accessibilityIdentifier = "detail-rename"
        field.accessibilityLabel = Strings.rename
        let initial = field.text ?? ""
        field.onFinish = { [weak self] kept in self?.finishRename(kept, initial: initial) }
        scroll.addSubview(field)
        nameField = field
        name.isHidden = true
        // The field takes the name's row, the pencil gone.
        view.setNeedsLayout()
        view.layoutIfNeeded()
        field.becomeFirstResponder()
        field.selectAll(nil)
    }

    private func endEditingName(keep: Bool) {
        guard let field = nameField else { return }
        if field.isFirstResponder { field.resignFirstResponder() } else { field.onFinish?(keep ? field.text : nil) }
    }

    private func finishRename(_ kept: String?, initial: String) {
        guard let field = nameField else { return }
        nameField = nil
        field.onFinish = nil
        field.removeFromSuperview()
        name.isHidden = false
        view.setNeedsLayout()
        guard let spaceId, let title = kept?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty, title != initial else { return }
        // Shown at once and kept until the computer says the same.
        heldName = title
        applyName()
        Haptics.play(.renamed)
        onRenamed?()
        let store = session.store
        Task { await store.rename(spaceId, title: title) }
    }

    @objc private func tappedAway() { endEditingName(keep: true) }

    /// Beside the rows' own taps, never instead of them; not on the name
    /// or its pencil, whose tap starts the rename.
    func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard let view = touch.view else { return true }
        if view === name || view.isDescendant(of: pencil) { return false }
        return nameField.map { !view.isDescendant(of: $0) } ?? true
    }

    func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}

/// The detail's scroll: a drag begun on a media cell, or any control,
/// still scrolls, however slowly it starts.
final class DetailScrollView: UIScrollView {
    override func touchesShouldCancel(in view: UIView) -> Bool { true }
}

/// A white card, Settings' rounding.
final class DetailCardView: UIView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.settingsCard)
        layer.cornerRadius = SessionDetailLayout.Metrics.radius
        layer.cornerCurve = .continuous
        clipsToBounds = true
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
}

/// One number: large, over what it counts.
final class DetailTileView: UIView {
    private let value = UILabel()
    private let label = UILabel()
    private var frames: SessionDetailLayout.Tile?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.settingsCard)
        layer.cornerRadius = SessionDetailLayout.Metrics.tileRadius
        layer.cornerCurve = .continuous
        value.font = Fonts.ui(.semiBold, size: 24)
        value.textColor = UIColor(Palette.settingsText)
        value.adjustsFontSizeToFitWidth = true
        value.minimumScaleFactor = 0.6
        label.font = Fonts.ui(.regular, size: 13)
        label.textColor = UIColor(Palette.settingsSecondary)
        label.lineBreakMode = .byTruncatingTail
        addSubview(value)
        addSubview(label)
        isAccessibilityElement = true
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func show(value text: String, label name: String) {
        value.text = text
        label.text = name
        accessibilityLabel = name
        accessibilityValue = text
    }

    func place(_ tile: SessionDetailLayout.Tile) {
        frame = tile.frame
        value.frame = tile.value
        label.frame = tile.label
    }

    /// A section's heading over its card: Settings' footnote caps.
    static func heading() -> UILabel {
        let label = UILabel()
        label.font = Fonts.ui(.regular, size: 13)
        label.textColor = UIColor(Palette.settingsSecondary)
        label.accessibilityTraits = .header
        return label
    }
}

/// Activity's cards: a row per child or terminal, what it is over its
/// facts; the settled card opens and closes under its first row.
final class DetailActivityCardView: UIView {
    struct Item {
        var glyph: String
        var tile: SettingsRow.Tile
        var title: String
        var meta: String
        var opens: Bool
        /// Its accessibility identifier; else `v2-detail-activity:<title>`.
        var id: String?
    }

    var onSelect: ((Int) -> Void)?
    var open = false {
        didSet {
            disclosureView.chevronTurned = open
            disclosureView.accessibilityValue = open ? Strings.expanded : Strings.collapsed
        }
    }
    private var items: [Item] = []
    private var disclosure: SettingsRow?
    private var rows: [RowView] = []
    /// The settled card's first row: Settings' row, its chevron turned down while open.
    private let disclosureView = SettingsCardView.RowView()
    /// "Show more" under the rows.
    private let moreView = SettingsCardView.RowView()
    private var more: SettingsRow?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.settingsCard)
        layer.cornerRadius = SessionDetailLayout.Metrics.radius
        layer.cornerCurve = .continuous
        clipsToBounds = true
        disclosureView.isHidden = true
        addSubview(disclosureView)
        moreView.isHidden = true
        addSubview(moreView)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func show(_ items: [Item], disclosure: SettingsRow?, more: SettingsRow? = nil) {
        self.items = items
        self.disclosure = disclosure
        self.more = more
        while rows.count < items.count {
            let row = RowView()
            let index = rows.count
            row.onTap = { [weak self] in self?.onSelect?(index) }
            addSubview(row)
            rows.append(row)
        }
        while rows.count > items.count { rows.removeLast().removeFromSuperview() }
        for (row, item) in zip(rows, items) { row.show(item) }
        setNeedsLayout()
    }

    /// Only the rows, where the card puts them.
    func placeRows(_ card: SessionDetailLayout.ActivityCard?) {
        guard let card else { return }
        for (row, frames) in zip(rows, card.rows) { row.place(frames) }
    }

    func place(_ card: SessionDetailLayout.ActivityCard) {
        place(frame: card.frame, disclosure: card.disclosure, rows: card.rows, more: nil)
    }

    func place(frame: CGRect, disclosure frames: SettingsLayout.Row?, rows: [SessionDetailLayout.ActivityRow], more moreFrames: SettingsLayout.Row?) {
        self.frame = frame
        moreView.isHidden = moreFrames == nil
        if let moreFrames, let more {
            moreView.show(more, frames: moreFrames)
            moreView.accessibilityIdentifier = "\(accessibilityIdentifier ?? "detail")-more"
        }
        disclosureView.isHidden = frames == nil
        if let frames, let disclosure {
            disclosureView.show(disclosure, frames: frames)
            disclosureView.accessibilityIdentifier = "detail-completed-toggle"
            disclosureView.accessibilityValue = open ? Strings.expanded : Strings.collapsed
        }
        // Folded rows keep their places, clipped, for the card to open over.
        for (index, row) in self.rows.enumerated() {
            row.accessibilityElementsHidden = index >= rows.count
            if index < rows.count { row.place(rows[index]) }
        }
    }

    final class RowView: UIView {
        private let tile = UIView()
        private let glyph = UIImageView()
        private let title = UILabel()
        private let meta = UILabel()
        private let separator = UIView()
        var onTap: (() -> Void)?
        private var opens = false

        override init(frame: CGRect) {
            super.init(frame: frame)
            tile.layer.cornerRadius = SettingsLayout.Metrics.tileRadius
            tile.layer.cornerCurve = .continuous
            glyph.tintColor = UIColor(Palette.settingsGlyph)
            glyph.contentMode = .center
            tile.addSubview(glyph)
            title.font = Fonts.ui(.regular, size: 17)
            title.textColor = UIColor(Palette.settingsText)
            title.lineBreakMode = .byTruncatingTail
            meta.font = Fonts.ui(.regular, size: 13)
            meta.textColor = UIColor(Palette.settingsSecondary)
            separator.backgroundColor = UIColor(Palette.settingsSeparator)
            for view in [tile, title, meta, separator] { addSubview(view) }
            isAccessibilityElement = true
            addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
        }

        @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

        func show(_ item: Item) {
            opens = item.opens
            tile.backgroundColor = UIColor(SettingsCardView.RowView.color(item.tile))
            glyph.image = Glyphs.image(item.glyph, size: SettingsLayout.Metrics.glyph)
            title.text = item.title
            meta.text = item.meta
            accessibilityLabel = item.title
            accessibilityValue = item.meta
            accessibilityTraits = item.opens ? .button : .staticText
            accessibilityIdentifier = item.id ?? "detail-activity:\(item.title)"
        }

        func place(_ frames: SessionDetailLayout.ActivityRow) {
            frame = frames.box
            let origin = frames.box.origin
            func local(_ rect: CGRect) -> CGRect { rect.offsetBy(dx: -origin.x, dy: -origin.y) }
            tile.frame = local(frames.icon)
            glyph.frame = tile.bounds
            title.frame = local(frames.title)
            meta.frame = local(frames.meta)
            separator.isHidden = frames.separator == nil
            if let rect = frames.separator { separator.frame = local(rect) }
        }

        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
            super.touchesBegan(touches, with: event)
            if opens { backgroundColor = UIColor(Palette.rowPressed) }
        }

        override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
            super.touchesEnded(touches, with: event)
            UIView.animate(withDuration: 0.2) { self.backgroundColor = nil }
        }

        override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
            super.touchesCancelled(touches, with: event)
            backgroundColor = nil
        }

        @objc private func tapped() { if opens { onTap?() } }
    }
}

/// The detail's mark, large: the seedling, its clay icon, Happy's own,
/// a picture, or a glyph on a tile.
final class DetailMarkView: UIView {
    var images: Images?
    var mark: Row.Mark = .none {
        didSet { if mark != oldValue { apply() } }
    }
    private let seedling = MarkView()
    private let picture = UIImageView()
    private var job: Task<Void, Never>?

    override init(frame: CGRect) {
        super.init(frame: frame)
        picture.contentMode = .scaleAspectFit
        picture.clipsToBounds = true
        addSubview(seedling)
        addSubview(picture)
        isAccessibilityElement = false
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        seedling.frame = bounds
        picture.frame = bounds
        if case .glyph = mark { picture.layer.cornerRadius = bounds.width * 0.28 }
        if case .image = mark { picture.layer.cornerRadius = bounds.width * 0.22 }
    }

    private func apply() {
        job?.cancel(); job = nil
        seedling.isHidden = true
        seedling.seed = nil
        picture.isHidden = false
        picture.image = nil
        picture.backgroundColor = nil
        picture.contentMode = .scaleAspectFit
        picture.layer.cornerRadius = 0
        switch mark {
        case .seedling(let seed):
            seedling.isHidden = false
            seedling.seed = seed
            picture.isHidden = true
        case .happy:
            picture.image = ClayIconImages.happy
        case .clay(let slug):
            picture.image = ClayIconImages.image(slug)
        case .image(let path, let thumbhash):
            picture.contentMode = .scaleAspectFill
            let pixels = Int(SessionDetailLayout.Metrics.mark * 3)
            picture.image = images?.cachedPicture(path, thumbhash: thumbhash, pixels: pixels) ?? Images.placeholder(thumbhash)
            job = Task { [weak self] in
                guard let image = await self?.images?.picture(path, thumbhash: thumbhash, pixels: pixels), !Task.isCancelled else { return }
                self?.picture.image = image
            }
        case .glyph(let name):
            picture.contentMode = .center
            picture.backgroundColor = UIColor(Palette.settingsTilePurple)
            picture.tintColor = UIColor(Palette.settingsGlyph)
            picture.image = Glyphs.image(name, size: 40)
        case .none:
            picture.contentMode = .center
            picture.backgroundColor = UIColor(Palette.settingsTilePurple)
            picture.tintColor = UIColor(Palette.settingsGlyph)
            picture.image = Glyphs.image("agents", size: 40)
        }
        setNeedsLayout()
    }
}
#endif
