#if canImport(UIKit)
import AVKit
import HappyCore
import HappyLayout
import UIKit

/// A conversation's detail, pushed from its header's capsule: the legacy
/// app's session screen made over in Settings' glass style. Its mark and
/// name (renamed where it stands, as Settings' name is), its model, effort
/// and when it started as tiles; what it shared, Telegram's shared media in
/// our style (its pictures, recordings and files in a grid, then the links
/// written in it); where it sits in the sidebar's tree drawn by the
/// sidebar's own rows, and desktop's Activity: the children at work and the
/// terminals running, then the settled children under a fold. Every row
/// opens its conversation. Frames are `StemCellSessionDetailLayout`'s; what
/// it shows is read off the main thread (`StemCellsSessionDetailFeed`,
/// `StemCellsSharedFeed`) and again as the conversation's events come.
final class StemCellSessionDetailViewController: UIViewController, UIGestureRecognizerDelegate {
    private let session: StemCellsSession
    private let agentId: String
    private let spaceId: String?
    /// Renamed here: the conversation under it keeps new work it would
    /// otherwise put away.
    var onRenamed: (() -> Void)?

    private let feed: StemCellsSessionDetailFeed
    /// The conversation as its screen holds it: what it shared, at once.
    private let warm: (chat: StemCellsWarmChats.Chat, token: UUID)
    /// What it shared further back, a page of history at a time.
    private let sharedFeed: StemCellsSharedFeed
    private var sharedState = StemCellsSharedFeed.State()
    /// The transcript's and the history's, newest first.
    private var shared = StemCellsShared()
    private var mediaLimit = StemCellSessionDetailViewController.mediaPage
    private var linksLimit = StemCellSessionDetailViewController.linksPage
    private var asking: Task<Void, Never>?
    /// What a "Show more" asked while history was being read: asked once it's in.
    private var pendingAsk = (media: false, links: false)
    private var reader = StemCellsShared.Reader()
    private var previewing: Task<Void, Never>?
    private lazy var loader = StemCellMediaLoader(client: session.client, agentId: agentId)
    private var preview: StemCellFilePreview?
    /// Four rows of media, five links; each "Show more" as many again.
    private static let mediaPage = 12
    private static let linksPage = 5
    private var detail: StemCellsSessionDetail?
    private var chat = StemCellChatSnapshot()
    private var row: StemCellsRow?
    private var family: [StemCellsRow] = []
    private var completedOpen = false
    private var heldName: String?

    private let bar = StemCellsGlassBar()
    private let scroll = UIScrollView()
    private let mark = StemCellDetailMarkView()
    private let name = UILabel()
    private var nameField: StemCellsRenameField?
    private let subtitle = UILabel()
    private let tiles = (0..<3).map { _ in StemCellDetailTileView() }
    private let actions = StemCellsSettingsCardView()
    private let mediaHeading = StemCellDetailTileView.heading()
    private let mediaCard = StemCellDetailMediaCardView()
    private let linksHeading = StemCellDetailTileView.heading()
    private let linksCard = StemCellDetailActivityCardView()
    private let familyHeading = StemCellDetailTileView.heading()
    private let familyCard = StemCellDetailCardView()
    private let tree = StemCellsSidebarView()
    private let activityHeading = StemCellDetailTileView.heading()
    private let running = StemCellDetailActivityCardView()
    private let completed = StemCellDetailActivityCardView()
    private var watch: StemCellsWatch?
    private var following: Task<Void, Never>?

    private static let treePadding: CGFloat = 8

    /// `title` is what its screen called it, for one the sidebar doesn't hold.
    init(session: StemCellsSession, agentId: String, title: String, spaceId: String?) {
        self.session = session
        self.agentId = agentId
        self.spaceId = spaceId
        fallbackTitle = title.isEmpty ? nil : title
        feed = StemCellsSessionDetailFeed(client: session.client, store: session.store, agentId: agentId)
        sharedFeed = StemCellsSharedFeed(client: session.client, agentId: agentId)
        warm = session.warm.hold(agentId)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.stemCellsSettingsGround)
        view.accessibilityIdentifier = "stem-detail"
        scroll.alwaysBounceVertical = true
        scroll.keyboardDismissMode = .interactive
        view.addSubview(scroll)
        mark.images = session.images
        scroll.addSubview(mark)
        name.font = StemCellsFonts.ui(.medium, size: 28)
        name.textColor = UIColor(Palette.stemCellsSettingsText)
        name.textAlignment = .center
        name.lineBreakMode = .byTruncatingTail
        name.accessibilityIdentifier = "stem-detail-name"
        name.accessibilityTraits = .header
        name.isUserInteractionEnabled = true
        name.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(nameTapped)))
        scroll.addSubview(name)
        subtitle.font = StemCellsFonts.ui(.regular, size: 17)
        subtitle.textColor = UIColor(Palette.stemCellsSettingsSecondary)
        subtitle.textAlignment = .center
        subtitle.accessibilityIdentifier = "stem-detail-subtitle"
        scroll.addSubview(subtitle)
        for (tile, id) in zip(tiles, ["model", "effort", "started"]) {
            tile.accessibilityIdentifier = "stem-detail-tile:\(id)"
            scroll.addSubview(tile)
        }
        scroll.addSubview(actions)
        mediaHeading.text = Strings.StemCells.media.uppercased()
        scroll.addSubview(mediaHeading)
        mediaCard.source = loader
        mediaCard.accessibilityIdentifier = "stem-detail-media"
        mediaCard.onSelect = { [weak self] index in self?.openMedia(index) }
        mediaCard.onMore = { [weak self] in self?.showMore(media: true) }
        scroll.addSubview(mediaCard)
        linksHeading.text = Strings.StemCells.links.uppercased()
        scroll.addSubview(linksHeading)
        linksCard.accessibilityIdentifier = "stem-detail-links"
        linksCard.onSelect = { [weak self] index in self?.openLink(index) }
        scroll.addSubview(linksCard)
        familyHeading.text = Strings.StemCells.family.uppercased()
        scroll.addSubview(familyHeading)
        tree.scrolls = false
        tree.padding = (Self.treePadding, Self.treePadding)
        tree.images = session.images
        tree.onSelect = { [weak self] row in self?.open(row) }
        tree.accessibilityIdentifier = "stem-detail-family"
        familyCard.addSubview(tree)
        scroll.addSubview(familyCard)
        activityHeading.text = Strings.StemCells.activity.uppercased()
        scroll.addSubview(activityHeading)
        running.onSelect = { [weak self] index in self?.openChild(self?.detail?.running, index) }
        running.accessibilityIdentifier = "stem-detail-running"
        scroll.addSubview(running)
        completed.onSelect = { [weak self] index in self?.openChild(self?.detail?.completed, index) }
        completed.accessibilityIdentifier = "stem-detail-completed"
        scroll.addSubview(completed)
        scroll.addGestureRecognizer({
            let tap = UITapGestureRecognizer(target: self, action: #selector(tappedAway))
            tap.cancelsTouchesInView = false
            tap.delegate = self
            return tap
        }())

        bar.leading = .back
        bar.onLeading = { [weak self] in self?.navigationController?.popViewController(animated: true) }
        StemCellsGlassChrome.install(bar, on: self)

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
    private func follow(_ snapshot: StemCellsSnapshot) {
        let rows = snapshot.allRows
        let found = spaceId.flatMap { id in rows.first { $0.spaceId == id && $0.kind == .space } } ?? rows.first { $0.agentId == agentId && ($0.kind == .space || $0.kind == .session) }
        row = found
        if let heldName, found?.label == heldName { self.heldName = nil }
        applyName()
        let next = found.map { StemCellsFamily.of($0.id, in: rows) } ?? []
        // Alone, it has no family worth a card.
        family = next.count > 1 ? next : []
        _ = tree.apply(family)
        tree.selectedRowId = found?.id
        var renames: [StemCellsSettingsRow] = []
        if canRename {
            renames.append(StemCellsSettingsRow(id: "rename", title: Strings.StemCells.rename, icon: ("pencil", .blue), accessory: .none, action: { [weak self] in self?.beginRename() }))
        }
        actionRows = renames
        view.setNeedsLayout()
    }

    private var actionRows: [StemCellsSettingsRow] = []
    private let fallbackTitle: String?

    /// Its row's name, mark and kind; else, for a subagent the sidebar
    /// doesn't hold, what its screen and the daemon call it.
    private func applyName() {
        name.text = heldName ?? row?.label ?? detail?.title ?? fallbackTitle ?? Strings.StemCells.untitledSession
        mark.mark = row?.mark ?? .glyph("agents")
        subtitle.text = row.map { Self.subtitle($0) } ?? Self.subtitle(subtask: detail?.subtask == true, working: detail?.working == true)
    }

    /// A task or a bot is renamed; Happy never.
    private var canRename: Bool {
        guard let row, spaceId != nil else { return false }
        return !row.isHappy && (row.targetKind == "task" || row.targetKind == "bot")
    }

    private static func subtitle(subtask: Bool, working: Bool) -> String {
        [subtask ? Strings.StemCells.subtask : Strings.StemCells.subagent, working ? Strings.StemCells.phaseWorking : nil].compactMap { $0 }.joined(separator: " · ")
    }

    private static func subtitle(_ row: StemCellsRow) -> String {
        let kind = row.kind == .session ? Strings.StemCells.subtask
            : row.targetKind == "bot" ? Strings.StemCells.bot
            : row.targetKind == "task" ? Strings.StemCells.task
            : Strings.StemCells.conversation
        let status: String? = switch row.status {
        case .working, .waiting: Strings.StemCells.phaseWorking
        case .awaitingInput: Strings.StemCells.phaseAwaitingAnswer
        case .none: nil
        }
        return [kind, status].compactMap { $0 }.joined(separator: " · ")
    }

    /// The tiles: model, effort, and when it started.
    private func applyNumbers() {
        let none = Strings.StemCells.none
        let mode = detail?.mode ?? chat.mode
        let menus = session.models.catalog.flatMap { catalog in mode.map { StemCellModelMenus(catalog: catalog, selection: $0) } }
        let values: [(String, String)] = [
            (menus?.current?.label ?? mode?.modelId ?? none, Strings.StemCells.model),
            ((menus?.effort ?? mode?.effort).map(StemCellModelMenus.effortName) ?? none, Strings.StemCells.effort),
            (detail?.createdAt.map { Strings.StemCells.started(StemCellsDetailFormat.started(since: $0, now: Date())) } ?? none, Strings.StemCells.started),
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
        loader.register([StemCellChatItem(id: "shared", role: .agent, pieces: shared.media.map { one in
            switch one {
            case .picture(let id, let mimeType, let data): .picture(id: id, mimeType: mimeType, data: data)
            case .tool(let media): media.isVisual ? .gallery([media], columns: 0) : .file(media)
            }
        }, delivery: .sent)])
        mediaCard.show(media)
        linksCard.show(shownLinks.map { link in
            .init(glyph: "link-outline", tile: .blue, title: link.title ?? link.host, meta: Self.address(link.url), opens: true, id: "stem-detail-link:\(link.url)")
        }, disclosure: nil, more: StemCellsSettingsRow(id: "links-more", title: Strings.StemCells.showMore, accessory: .none, action: { [weak self] in self?.showMore(media: false) }))
        view.setNeedsLayout()
    }

    private var shownMedia: [StemCellsShared.Media] { Array(shared.media.prefix(mediaLimit)) }
    private var shownLinks: [StemCellsShared.Link] { Array(shared.links.prefix(linksLimit)) }

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
        StemCellsHaptics.play(.fold)
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
                .init(glyph: "agents", tile: .purple, title: child.title ?? Strings.StemCells.subagent, meta: Self.meta(child), opens: true)
            } + detail.terminals.map { terminal in
                let age = terminal.startedAt.map { Strings.StemCells.age(StemCellsDetailFormat.age(since: $0, now: Date().timeIntervalSince1970 * 1000)) }
                return .init(glyph: "terminal", tile: .gray, title: terminal.command, meta: [Strings.StemCells.terminalRunning, age].compactMap { $0 }.joined(separator: " · "), opens: false)
            },
            disclosure: nil
        )
        completed.show(
            detail.completed.map { child in
                .init(glyph: "agents", tile: .gray, title: child.title ?? Strings.StemCells.subagent, meta: Self.meta(child), opens: true)
            },
            disclosure: StemCellsSettingsRow(id: "completed", title: Strings.StemCells.completed, icon: ("checkbox-outline", .green), value: "\(detail.completed.count)", accessory: .chevron, action: { [weak self] in self?.toggleCompleted() })
        )
        completed.open = completedOpen
        view.setNeedsLayout()
    }

    private static func meta(_ child: StemCellsSessionDetail.Child) -> String {
        [Strings.StemCells.activityStatus(child.status, archived: child.archived), child.tokens.map(Strings.StemCells.tokenCount)].compactMap { $0 }.joined(separator: " · ")
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width
        scroll.frame = view.bounds
        let side = StemCellSessionDetailLayout.Metrics.side
        let cardWidth = max(0, width - 2 * side)
        let familyHeight: CGFloat? = family.isEmpty ? nil : StemCellsSidebarLayout.layout(
            StemCellsSidebarView.layoutRows(family), width: cardWidth, top: Self.treePadding, bottom: Self.treePadding, scale: traitCollection.displayScale
        ).contentHeight
        let workCount = (detail?.running.count ?? 0) + (detail?.terminals.count ?? 0)
        let settled = detail?.completed.count ?? 0
        let layout = StemCellSessionDetailLayout(
            width: width, nameHeight: ceil(name.font.lineHeight), subtitleHeight: ceil(subtitle.font.lineHeight),
            tiles: tiles.count, actions: actionRows.count,
            media: .init(count: shownMedia.count, more: hasMore(shared.media.count, limit: mediaLimit)),
            links: .init(count: shownLinks.count, more: hasMore(shared.links.count, limit: linksLimit)),
            family: familyHeight, running: workCount, completed: settled,
            countWidth: StemCellsSettingsCardView.valueWidth("\(settled)") ?? 0, open: completedOpen
        )
        mark.frame = layout.mark
        name.frame = layout.name
        nameField?.frame = layout.name
        subtitle.frame = layout.subtitle
        for (tile, frame) in zip(tiles, layout.tiles) { tile.place(frame) }
        actions.isHidden = actionRows.isEmpty
        actions.frame = layout.actions.frame
        actions.show(actionRows, layout: layout.actions)
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
            tree.frame = familyCard.bounds
        }
        activityHeading.isHidden = layout.activityHeading == nil
        if let frame = layout.activityHeading { activityHeading.frame = frame }
        running.isHidden = layout.running == nil
        if let card = layout.running { running.place(card) }
        completed.isHidden = layout.completed == nil
        if let card = layout.completed { completed.place(card) }
        scroll.contentSize = CGSize(width: width, height: layout.contentHeight)
    }

    // MARK: Acts

    /// Another conversation of the family, over this one; this one's own
    /// row goes back to it.
    private func open(_ row: StemCellsRow) {
        guard let agentId = row.agentId, row.kind == .space || row.kind == .session, row.targetKind != "surface" else { return }
        if agentId == self.agentId { navigationController?.popViewController(animated: true); return }
        let intro: StemCellChatViewController.Intro? = switch row.mark {
        case .stemCell(let seed): .stemCell(seed: seed)
        case .clay(let slug): .clay(slug)
        default: nil
        }
        navigationController?.pushViewController(StemCellChatViewController(session: session, agentId: agentId, title: row.label, spaceId: row.spaceId, stemCell: intro), animated: true)
    }

    private func openChild(_ children: [StemCellsSessionDetail.Child]?, _ index: Int) {
        guard let children, children.indices.contains(index) else { return }
        let child = children[index]
        let title = child.title ?? Strings.StemCells.subagent
        navigationController?.pushViewController(StemCellChatViewController(session: session, agentId: child.id, title: title, spaceId: nil, stemCell: nil), animated: true)
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
            let preview = StemCellFilePreview(loader: loader, media: file)
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
        let pictures = shared.media.filter(\.isPicture).map { picture -> StemCellPicture in
            switch picture {
            case .picture: StemCellPicture(key: picture.key, thumbhash: nil, label: Strings.StemCells.picture)
            case .tool(let media): StemCellPicture(key: media.key, thumbhash: media.item.thumbhash, label: media.item.name)
            }
        }
        guard let at = pictures.firstIndex(where: { $0.key == one.key }) else { return }
        present(StemCellPictureViewController(source: loader, pictures: pictures, index: at), animated: true)
    }

    private func openLink(_ index: Int) {
        let links = shownLinks
        guard links.indices.contains(index), let url = URL(string: links[index].url) else { return }
        UIApplication.shared.open(url)
    }

    private func toggleCompleted() {
        StemCellsHaptics.play(.fold)
        completedOpen.toggle()
        completed.open = completedOpen
        if completedOpen, let detail {
            // Placed where they open before the card grows over them.
            UIView.performWithoutAnimation {
                completed.placeRows(StemCellSessionDetailLayout(
                    width: view.bounds.width, nameHeight: 0, subtitleHeight: 0, tiles: 0, actions: 0, family: nil,
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
        let field = StemCellsRenameField()
        field.font = name.font
        field.textColor = name.textColor
        field.tintColor = UIColor(Palette.stemCellsSettingsPrimary)
        field.textAlignment = .center
        field.text = row.label == Strings.StemCells.untitled ? "" : (heldName ?? row.label)
        field.returnKeyType = .done
        field.autocapitalizationType = .sentences
        field.accessibilityIdentifier = "stem-detail-rename"
        field.frame = name.frame
        let initial = field.text ?? ""
        field.onFinish = { [weak self] kept in self?.finishRename(kept, initial: initial) }
        scroll.addSubview(field)
        nameField = field
        name.isHidden = true
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
        guard let spaceId, let title = kept?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty, title != initial else { return }
        // Shown at once and kept until the computer says the same.
        heldName = title
        name.text = title
        StemCellsHaptics.play(.renamed)
        onRenamed?()
        let store = session.store
        Task { await store.rename(spaceId, title: title) }
    }

    @objc private func tappedAway() { endEditingName(keep: true) }

    /// Beside the rows' own taps, never instead of them; not on the name,
    /// whose tap starts the rename.
    func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard let view = touch.view else { return true }
        if view === name || view.isDescendant(of: actions) { return false }
        return nameField.map { !view.isDescendant(of: $0) } ?? true
    }

    func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}

/// A white card, Settings' rounding.
final class StemCellDetailCardView: UIView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.stemCellsSettingsCard)
        layer.cornerRadius = StemCellSessionDetailLayout.Metrics.radius
        layer.cornerCurve = .continuous
        clipsToBounds = true
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
}

/// One number: large, over what it counts.
final class StemCellDetailTileView: UIView {
    private let value = UILabel()
    private let label = UILabel()
    private var frames: StemCellSessionDetailLayout.Tile?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.stemCellsSettingsCard)
        layer.cornerRadius = StemCellSessionDetailLayout.Metrics.tileRadius
        layer.cornerCurve = .continuous
        value.font = StemCellsFonts.ui(.semiBold, size: 24)
        value.textColor = UIColor(Palette.stemCellsSettingsText)
        value.adjustsFontSizeToFitWidth = true
        value.minimumScaleFactor = 0.6
        label.font = StemCellsFonts.ui(.regular, size: 13)
        label.textColor = UIColor(Palette.stemCellsSettingsSecondary)
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

    func place(_ tile: StemCellSessionDetailLayout.Tile) {
        frame = tile.frame
        value.frame = tile.value
        label.frame = tile.label
    }

    /// A section's heading over its card: Settings' footnote caps.
    static func heading() -> UILabel {
        let label = UILabel()
        label.font = StemCellsFonts.ui(.regular, size: 13)
        label.textColor = UIColor(Palette.stemCellsSettingsSecondary)
        label.accessibilityTraits = .header
        return label
    }
}

/// Activity's cards: a row per child or terminal, what it is over its
/// facts; the settled card opens and closes under its first row.
final class StemCellDetailActivityCardView: UIView {
    struct Item {
        var glyph: String
        var tile: StemCellsSettingsRow.Tile
        var title: String
        var meta: String
        var opens: Bool
        /// Its accessibility identifier; else `stem-detail-activity:<title>`.
        var id: String?
    }

    var onSelect: ((Int) -> Void)?
    var open = false {
        didSet {
            disclosureView.chevronTurned = open
            disclosureView.accessibilityValue = open ? Strings.StemCells.expanded : Strings.StemCells.collapsed
        }
    }
    private var items: [Item] = []
    private var disclosure: StemCellsSettingsRow?
    private var rows: [RowView] = []
    /// The settled card's first row: Settings' row, its chevron turned down while open.
    private let disclosureView = StemCellsSettingsCardView.RowView()
    /// "Show more" under the rows.
    private let moreView = StemCellsSettingsCardView.RowView()
    private var more: StemCellsSettingsRow?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.stemCellsSettingsCard)
        layer.cornerRadius = StemCellSessionDetailLayout.Metrics.radius
        layer.cornerCurve = .continuous
        clipsToBounds = true
        disclosureView.isHidden = true
        addSubview(disclosureView)
        moreView.isHidden = true
        addSubview(moreView)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func show(_ items: [Item], disclosure: StemCellsSettingsRow?, more: StemCellsSettingsRow? = nil) {
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
    func placeRows(_ card: StemCellSessionDetailLayout.ActivityCard?) {
        guard let card else { return }
        for (row, frames) in zip(rows, card.rows) { row.place(frames) }
    }

    func place(_ card: StemCellSessionDetailLayout.ActivityCard) {
        place(frame: card.frame, disclosure: card.disclosure, rows: card.rows, more: nil)
    }

    func place(frame: CGRect, disclosure frames: StemCellsSettingsLayout.Row?, rows: [StemCellSessionDetailLayout.ActivityRow], more moreFrames: StemCellsSettingsLayout.Row?) {
        self.frame = frame
        moreView.isHidden = moreFrames == nil
        if let moreFrames, let more {
            moreView.show(more, frames: moreFrames)
            moreView.accessibilityIdentifier = "\(accessibilityIdentifier ?? "stem-detail")-more"
        }
        disclosureView.isHidden = frames == nil
        if let frames, let disclosure {
            disclosureView.show(disclosure, frames: frames)
            disclosureView.accessibilityIdentifier = "stem-detail-completed-toggle"
            disclosureView.accessibilityValue = open ? Strings.StemCells.expanded : Strings.StemCells.collapsed
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
            tile.layer.cornerRadius = StemCellsSettingsLayout.Metrics.tileRadius
            tile.layer.cornerCurve = .continuous
            glyph.tintColor = UIColor(Palette.stemCellsSettingsGlyph)
            glyph.contentMode = .center
            tile.addSubview(glyph)
            title.font = StemCellsFonts.ui(.regular, size: 17)
            title.textColor = UIColor(Palette.stemCellsSettingsText)
            title.lineBreakMode = .byTruncatingTail
            meta.font = StemCellsFonts.ui(.regular, size: 13)
            meta.textColor = UIColor(Palette.stemCellsSettingsSecondary)
            separator.backgroundColor = UIColor(Palette.stemCellsSettingsSeparator)
            for view in [tile, title, meta, separator] { addSubview(view) }
            isAccessibilityElement = true
            addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
        }

        @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

        func show(_ item: Item) {
            opens = item.opens
            tile.backgroundColor = UIColor(StemCellsSettingsCardView.RowView.color(item.tile))
            glyph.image = StemCellsGlyphs.image(item.glyph, size: StemCellsSettingsLayout.Metrics.glyph)
            title.text = item.title
            meta.text = item.meta
            accessibilityLabel = item.title
            accessibilityValue = item.meta
            accessibilityTraits = item.opens ? .button : .staticText
            accessibilityIdentifier = item.id ?? "stem-detail-activity:\(item.title)"
        }

        func place(_ frames: StemCellSessionDetailLayout.ActivityRow) {
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
            if opens { backgroundColor = UIColor(Palette.stemCellsRowPressed) }
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

/// The detail's mark, large: the stem cell, its clay icon, Happy's own,
/// a picture, or a glyph on a tile.
final class StemCellDetailMarkView: UIView {
    var images: StemCellsImages?
    var mark: StemCellsRow.Mark = .none {
        didSet { if mark != oldValue { apply() } }
    }
    private let stemCell = StemCellMarkView()
    private let picture = UIImageView()
    private var job: Task<Void, Never>?

    override init(frame: CGRect) {
        super.init(frame: frame)
        picture.contentMode = .scaleAspectFit
        picture.clipsToBounds = true
        addSubview(stemCell)
        addSubview(picture)
        isAccessibilityElement = false
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        stemCell.frame = bounds
        picture.frame = bounds
        if case .glyph = mark { picture.layer.cornerRadius = bounds.width * 0.28 }
        if case .image = mark { picture.layer.cornerRadius = bounds.width * 0.22 }
    }

    private func apply() {
        job?.cancel(); job = nil
        stemCell.isHidden = true
        stemCell.seed = nil
        picture.isHidden = false
        picture.image = nil
        picture.backgroundColor = nil
        picture.contentMode = .scaleAspectFit
        picture.layer.cornerRadius = 0
        switch mark {
        case .stemCell(let seed):
            stemCell.isHidden = false
            stemCell.seed = seed
            picture.isHidden = true
        case .happy:
            picture.image = ClayIconImages.happy
        case .clay(let slug):
            picture.image = ClayIconImages.image(slug)
        case .image(let path, let thumbhash):
            picture.contentMode = .scaleAspectFill
            let pixels = Int(StemCellSessionDetailLayout.Metrics.mark * 3)
            picture.image = images?.cachedPicture(path, thumbhash: thumbhash, pixels: pixels) ?? StemCellsImages.placeholder(thumbhash)
            job = Task { [weak self] in
                guard let image = await self?.images?.picture(path, thumbhash: thumbhash, pixels: pixels), !Task.isCancelled else { return }
                self?.picture.image = image
            }
        case .glyph(let name):
            picture.contentMode = .center
            picture.backgroundColor = UIColor(Palette.stemCellsSettingsTilePurple)
            picture.tintColor = UIColor(Palette.stemCellsSettingsGlyph)
            picture.image = StemCellsGlyphs.image(name, size: 40)
        case .none:
            picture.contentMode = .center
            picture.backgroundColor = UIColor(Palette.stemCellsSettingsTilePurple)
            picture.tintColor = UIColor(Palette.stemCellsSettingsGlyph)
            picture.image = StemCellsGlyphs.image("agents", size: 40)
        }
        setNeedsLayout()
    }
}
#endif
