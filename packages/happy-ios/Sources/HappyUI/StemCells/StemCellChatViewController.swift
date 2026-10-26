#if canImport(UIKit)
import AVKit
import HappyCore
import HappyLayout
import QuickLook
import UIKit

/// One Stem Cells conversation, simplified from desktop's: the work's
/// intro at the top (its stem cell, or the clay icon it grew into, over
/// "Say what it is — it’ll find its place."), what the person wrote and
/// what the agent said with the pictures and recordings it presented, and
/// a composer that sends photos too. Tool calls are never shown.
///
/// New work opens here before the daemon has made it: the intro and the
/// composer are up at once, and a first message waits for the work to exist.
///
/// Previewing, it is what a hold on the row shows over the sidebar, as
/// Telegram previews a chat: the newest messages under the name in a
/// capsule, nothing to type in or tap, and nothing marked read.
final class StemCellChatViewController: UIViewController {
    typealias Intro = StemCellIntroView.Mark

    private let session: StemCellsSession
    private let conversation: StemCellConversation
    private let spaceId: String?
    private let opensFocused: Bool
    /// New work brings the keyboard up as it opens, unless it opens on the library.
    var focusesOnOpen = true
    /// Opened on the library: the first pick brings the keyboard up, once.
    var focusesAfterPick = false
    private let previewing: Bool
    private let previewPill = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterial))
    /// The card's ground over the messages above the list, fading out under the capsule.
    private let previewFade = StemCellsPreviewFadeView()
    private let previewTitle = UILabel()
    private var intro: Intro?
    private let planner: StemCellChatPlanner
    private let media: StemCellMediaLoader
    private let pictures: ComposerImagePicker

    private let scrollView = UIScrollView()
    private let introView = StemCellIntroView()
    private var rowViews: [String: ChatPlanView] = [:]
    private var plans: [ChatRowPlan] = []
    private let working = StemCellWorkingView()
    private let card = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: Strings.Composer.inputPlaceholder))
    private let keyboardTracker = UIView()

    private var chat = StemCellChatSnapshot()
    private var following: Task<Void, Never>?
    private var planning: Task<Void, Never>?
    private var planned: (items: [StemCellChatItem], key: StemCellChatPlanner.Key, copied: String?, opened: Set<String>, proposals: [String: StemCellProposalShown])?
    /// Other agents' messages opened to read, for this screen's life.
    private var opened = Set<String>()
    /// The sidebar proposals the transcript shows, and their cards by row.
    private let proposals: StemCellSidebarProposals
    private var proposalViews: [String: StemCellSidebarProposalView] = [:]
    /// The proposals as the rows on screen were planned with them.
    private var shownProposals: [String: StemCellProposalShown] = [:]
    private var sidebarRows: [StemCellsRow] = []
    /// What the references messages make read as and open.
    private var references = StemCellReferences()
    /// The references with this conversation's own subagents, which the
    /// sidebar's lists never hold.
    private var subagentReferences: StemCellReferences {
        var known = references
        known.subagents = chat.subagentTitles
        return known
    }
    private var watch: StemCellsWatch?
    private var modelsWatch: StemCellsWatch?
    private var copied: (id: String, until: Task<Void, Never>)?
    /// The newest row is in view: what arrives keeps it there.
    private var followsNewest = true
    /// The computer was reachable when last heard: pictures that failed
    /// while it wasn't are asked for again when it is back.
    private var live = true
    private var preview: StemCellFilePreview?
    /// The glass header: back, and the name, renamed where it stands.
    private let header = StemCellChatHeaderView()
    private var titleView: StemCellChatTitleView { header.titleView }
    /// The edge swipe back, which the hidden bar would otherwise take with it.
    private let swipeBack = StemCellsSwipeBack()

    init(session: StemCellsSession, agentId: String, title: String, spaceId: String?, stemCell intro: Intro?, creation: StemCellCreation? = nil, previewing: Bool = false) {
        self.session = session
        self.spaceId = spaceId
        self.intro = intro
        self.previewing = previewing
        opensFocused = creation != nil
        conversation = StemCellConversation(client: session.client, store: session.store, agentId: agentId, creation: creation?.created, mode: creation == nil ? nil : session.models.newWorkMode)
        planner = StemCellChatPlanner(syntax: session.syntax)
        proposals = StemCellSidebarProposals(client: session.client, store: session.store)
        media = StemCellMediaLoader(client: session.client, agentId: agentId)
        let files = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("StemCells", isDirectory: true)
        pictures = ComposerImagePicker(staging: ComposerAttachmentStaging(filesDirectory: files))
        super.init(nibName: nil, bundle: nil)
        self.title = title
        titleView.text = title
        navigationItem.largeTitleDisplayMode = .never
        // New work's media is under the ID the daemon gives it.
        if let created = creation?.created {
            Task { [weak self] in
                guard let id = try? await created.value else { return }
                self?.media.agentId = id
            }
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.surface)
        scrollView.alwaysBounceVertical = true
        scrollView.keyboardDismissMode = .interactive
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.delegate = self
        view.addSubview(scrollView)
        scrollView.addSubview(introView)
        working.isHidden = true
        scrollView.addSubview(working)
        introView.accessibilityIdentifier = "stem-intro"
        introView.onOffer = { [weak self] offer in self?.make(offer) }
        // New work asks what it is; a conversation already going asks for the next message.
        if case .stemCell = intro { card.configuration.placeholder = Strings.StemCells.composerPlaceholder }
        card.configuration.showsAdd = true
        card.configuration.addAccessibilityLabel = Strings.StemCells.addPicture
        card.delegate = self
        card.textView.accessibilityIdentifier = "stem-composer"
        // A long press's Paste attaches a copied picture.
        card.textView.onPasteAttachment = { [weak self] in self?.pictures.paste() }
        pictures.host = { [weak self] in self }
        pictures.onChange = { [weak self] in
            guard let self else { return }
            card.configuration.attachments = pictures.images.map { AgentInputAttachmentPreview(id: $0.id, fileURL: $0.attachment.fileURL) }
            updatePrimary()
        }
        view.addSubview(card)
        header.onBack = { [weak self] in self?.navigationController?.popViewController(animated: true) }
        view.addSubview(header)

        keyboardTracker.isHidden = true
        keyboardTracker.isUserInteractionEnabled = false
        keyboardTracker.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(keyboardTracker)
        view.keyboardLayoutGuide.followsUndockedKeyboard = false
        NSLayoutConstraint.activate([
            keyboardTracker.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            keyboardTracker.widthAnchor.constraint(equalToConstant: 1),
            keyboardTracker.topAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            keyboardTracker.heightAnchor.constraint(equalToConstant: 1),
        ])

        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.cancelsTouchesInView = false
        scrollView.addGestureRecognizer(tap)
        scrollView.addGestureRecognizer(UILongPressGestureRecognizer(target: self, action: #selector(held(_:))))

        if previewing { setUpPreview() }
        applyIntro()
        proposals.onChange = { [weak self] in self?.replan() }
        let updates = conversation.updates
        following = Task { [weak self] in
            for await snapshot in updates {
                guard let self else { return }
                self.apply(snapshot)
            }
        }
        let conversation = conversation
        Task { await conversation.start() }
        watch = session.watch { [weak self] snapshot in self?.follow(snapshot) }
        modelsWatch = session.models.watch { [weak self] in self?.updateChips() }
        session.models.load()
        updateChips()
        // New work: the keyboard comes up with the screen.
        if opensFocused, focusesOnOpen { card.focus() }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // A preview is only looked at: what it shows stays unread.
        if previewing { return }
        // The header is the screen's own glass.
        navigationController?.setNavigationBarHidden(true, animated: animated)
        let conversation = conversation
        Task { await conversation.setVisible(true) }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !previewing, let navigationController else { return }
        swipeBack.attach(to: navigationController)
        // A swipe back let go of halfway gives the bar back to the screen
        // under it after this one appeared: hidden again.
        if !navigationController.isNavigationBarHidden { navigationController.setNavigationBarHidden(true, animated: false) }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // Leaving keeps a name being typed, as a tap away does.
        titleView.finishEditing()
        swipeBack.detach()
        // A screen pushed over this one has the bar it expects.
        if !previewing, !isMovingFromParent, let top = navigationController?.topViewController, top !== self, !(top is StemCellChatViewController) {
            navigationController?.setNavigationBarHidden(false, animated: animated)
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        let conversation = conversation
        Task { await conversation.setVisible(false) }
        if isMovingFromParent || navigationController == nil {
            following?.cancel()
            planning?.cancel()
            watch?.invalidate()
            modelsWatch?.invalidate()
            proposals.stop()
            Task { await conversation.stop() }
        }
    }

    // MARK: State

    /// The row's name and mark as the sidebar has them: Prioritizing's name
    /// lands here too, and the stem cell gives way to its clay icon.
    private func follow(_ snapshot: StemCellsSnapshot) {
        if snapshot.live, !live {
            media.retryFailed()
            proposals.reconnected()
        }
        live = snapshot.live
        // A proposal's rows name the spaces as the sidebar does now, folded
        // ones too.
        // References in messages read as the names they have now.
        if snapshot.references != references {
            references = snapshot.references
            replan()
        }
        if snapshot.allRows != sidebarRows {
            sidebarRows = snapshot.allRows
            proposals.spacesChanged()
        }
        if introView.offers != snapshot.offers {
            introView.setOffers(snapshot.offers)
            view.setNeedsLayout()
        }
        guard let spaceId, let row = snapshot.rows.first(where: { $0.spaceId == spaceId }) else { return }
        if title != row.label { title = row.label }
        titleView.text = row.label
        if previewing, previewTitle.text != row.label {
            previewTitle.text = row.label
            previewPill.accessibilityLabel = row.label
            view.setNeedsLayout()
        }
        // A task or a bot is renamed as its row is; Happy never.
        if !row.isHappy, row.targetKind == "task" || row.targetKind == "bot" {
            titleView.editableText = row.label == Strings.StemCells.untitled ? "" : row.label
            if titleView.onRename == nil {
                let store = session.store
                titleView.onRename = { title in Task { await store.rename(spaceId, title: title) } }
            }
        } else {
            titleView.onRename = nil
        }
        let next: Intro? = switch row.mark {
        case .stemCell(let seed): .stemCell(seed: seed)
        case .clay(let slug): .clay(slug)
        default: intro
        }
        if next != intro {
            intro = next
            applyIntro()
        }
    }

    private func applyIntro() {
        introView.isHidden = intro == nil
        if let intro { introView.configure(intro, settled: !chat.items.isEmpty) }
        view.setNeedsLayout()
    }

    private func apply(_ snapshot: StemCellChatSnapshot) {
        let wasSettled = !chat.items.isEmpty
        chat = snapshot
        media.register(snapshot.items)
        proposals.want(snapshot.items.flatMap(\.proposalIds))
        working.show(snapshot.activity)
        header.status = Self.status(snapshot.activity)
        if wasSettled != !snapshot.items.isEmpty, let intro { introView.configure(intro, settled: !snapshot.items.isEmpty) }
        updatePrimary()
        updateChips()
        replan()
        view.setNeedsLayout()
    }

    // MARK: Model

    /// What the next message goes with: the conversation's, else what new
    /// work starts on, else the computer's default.
    private var mode: AgentWire.Mode? {
        chat.mode ?? (opensFocused ? session.models.newWorkMode : nil) ?? session.models.catalog?.defaultMode()
    }

    private func updateChips() {
        let menus = session.models.catalog.flatMap { catalog in mode.map { StemCellModelMenus(catalog: catalog, selection: $0) } }
        StemCellModelPickers.configure(card, menus: menus)
    }

    /// The library over `host`: home's dock opens it over this screen as
    /// the screen comes in. What's picked waits in the composer, which then
    /// takes the keyboard.
    func presentLibrary(from host: UIViewController) {
        let pictures = pictures
        let room = pictures.room()
        guard room > 0 else { return }
        LibraryPicker.present(from: host, options: .init(limit: room, videos: false, sources: true)) { [weak self] picks in
            pictures.add(pictures: picks.compactMap { if case .image(let data, _) = $0.media { data } else { nil } })
            // A message carries text and pictures alone (the daemon takes
            // text and image blocks): any other file is said, not sent.
            let others = picks.filter { if case .image = $0.media { false } else { true } }
            LibraryPicker.discard(others)
            guard let self else { return }
            if !others.isEmpty {
                let names = others.compactMap { pick -> String? in
                    switch pick.media {
                    case .file(let url, _), .video(let url): url.lastPathComponent
                    case .image: nil
                    }
                }
                let alert = UIAlertController(title: Strings.StemCells.filesNotSent(names), message: Strings.StemCells.filesNotSentDetail, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: Strings.StemCells.done, style: .default))
                present(alert, animated: true)
            }
            guard focusesAfterPick else { return }
            focusesAfterPick = false
            if picks.count > others.count { card.focus() }
        }
    }

    private func pick(_ kind: StemCellModelPickers.Kind) {
        guard let mode else {
            session.models.load()
            return
        }
        let conversation = conversation
        StemCellModelPickers.present(kind, from: self, state: session.models, mode: mode) { next in
            Task { await conversation.setMode(next) }
        }
    }

    private var planKey: StemCellChatPlanner.Key {
        StemCellChatPlanner.Key(width: view.bounds.width, maxContentWidth: ContentWidth.maxWidth, environment: traitCollection.textEnvironment, references: subagentReferences, subagentTitles: chat.subagentTitles)
    }

    /// Plans the rows off the main thread, then shows them in one frame.
    private func replan() {
        let key = planKey
        guard key.width > 0 else { return }
        let items = chat.items
        // Artifacts the messages name are read for their titles, once each.
        let unread = items.flatMap { references.unread(in: $0.text) }
        if !unread.isEmpty {
            let store = session.store
            Task { await store.readArtifacts(unread) }
        }
        let copiedId = copied?.id
        let shown = proposals.shown
        let opened = opened
        if let planned, planned.items == items, planned.key == key, planned.copied == copiedId, planned.opened == opened, planned.proposals == shown { return }
        planned = (items, key, copiedId, opened, shown)
        planning?.cancel()
        let planner = planner
        planning = Task { [weak self] in
            let plans = await planner.plans(items, key: key, copied: copiedId, opened: opened, proposals: shown)
            guard !Task.isCancelled, let self else { return }
            self.shownProposals = shown
            self.show(plans)
        }
    }

    private func show(_ plans: [ChatRowPlan]) {
        self.plans = plans
        var seen = Set<String>()
        var hosted = Set<String>()
        for plan in plans {
            seen.insert(plan.id)
            let row = rowViews[plan.id] ?? {
                let row = ChatPlanView()
                row.drawsStaticContent = true
                row.isAccessibilityElement = true
                row.accessibilityIdentifier = "stem-message"
                scrollView.addSubview(row)
                rowViews[plan.id] = row
                return row
            }()
            row.apply(plan)
            row.accessibilityLabel = plan.accessibilityLabel
            var cardsHosted: [UIView] = []
            for (artifactId, layout, frame) in plan.proposals {
                guard let shown = shownProposals[artifactId] else { continue }
                let key = "\(plan.id)#\(artifactId)"
                hosted.insert(key)
                let card = proposalViews[key] ?? makeProposal(artifactId, key: key)
                if card.superview !== row { row.addSubview(card) }
                card.setLayoutFrame(frame)
                card.apply(shown, layout: layout)
                cardsHosted.append(card)
            }
            // A row with media reads as its message, then each picture or
            // recording on its own, and each card as what it opens.
            let cards = plan.hits.sorted { $0.frame.minY < $1.frame.minY }.compactMap { hit -> UIAccessibilityElement? in
                guard let label = self.cardLabel(hit.action) else { return nil }
                let card = UIAccessibilityElement(accessibilityContainer: row)
                card.accessibilityLabel = label
                card.accessibilityTraits = .button
                card.accessibilityIdentifier = "stem-card"
                card.accessibilityFrameInContainerSpace = hit.frame
                return card
            }
            let media: [Any] = (row.mediaViews as [Any]) + (cards as [Any]) + (cardsHosted as [Any])
            row.isAccessibilityElement = media.isEmpty
            if media.isEmpty {
                row.accessibilityElements = nil
            } else if let label = plan.accessibilityLabel, !label.isEmpty {
                // The message covers its words, never its media.
                let message = UIAccessibilityElement(accessibilityContainer: row)
                message.accessibilityLabel = label
                message.accessibilityIdentifier = "stem-message"
                message.accessibilityFrameInContainerSpace = plan.items.reduce(CGRect.null) { frame, item in
                    item.wordsFrame.map { frame.union($0) } ?? frame
                }
                row.accessibilityElements = [message] + media
            } else {
                row.accessibilityElements = media
            }
        }
        for (id, row) in rowViews where !seen.contains(id) {
            row.removeFromSuperview()
            rowViews.removeValue(forKey: id)
        }
        for (key, card) in proposalViews where !hosted.contains(key) {
            card.removeFromSuperview()
            proposalViews.removeValue(forKey: key)
        }
        layoutTranscript()
    }

    private func makeProposal(_ artifactId: String, key: String) -> StemCellSidebarProposalView {
        let card = StemCellSidebarProposalView(images: session.images)
        proposalViews[key] = card
        // A preview is only looked at: nothing in it is decided from there.
        if previewing { return card }
        let proposals = proposals
        card.onAccept = { proposals.accept(artifactId) }
        card.onDecline = { proposals.decline(artifactId) }
        card.onTurn = { [weak self] rowId in
            // The section opens under the finger, not pulled up to the newest row.
            self?.followsNewest = false
            StemCellsHaptics.play(.fold)
            proposals.turn(artifactId, rowId: rowId)
        }
        return card
    }

    /// The header's grey line: what the agent is at, in a word, while it is.
    private static func status(_ activity: StemCellActivity?) -> String? {
        guard let activity else { return nil }
        return switch activity.phase {
        case .thinking, .waitingForModel: Strings.StemCells.phaseThinking
        case .awaitingAnswer: Strings.StemCells.phaseAwaitingAnswer
        default: Strings.StemCells.phaseWorking
        }
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if previewing { return layoutPreview() }
        replan()
        header.safeTop = view.safeAreaInsets.top
        header.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: header.layout.backdrop.height)
        let screen = StemCellChatScreenLayout(
            size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets),
            keyboardTop: keyboardTracker.frame.minY
        ) { [card] width in card.height(fitting: width) }
        card.setLayoutFrame(screen.card)
        scrollView.frame = view.bounds
        // The transcript starts under the header's row and scrolls under it.
        let insets = UIEdgeInsets(top: header.layout.listTop, left: 0, bottom: screen.listBottom, right: 0)
        if scrollView.contentInset != insets {
            scrollView.contentInset = insets
            scrollView.verticalScrollIndicatorInsets = insets
        }
        layoutTranscript()
    }

    // MARK: Preview

    private func setUpPreview() {
        card.isHidden = true
        header.isHidden = true
        scrollView.isUserInteractionEnabled = false
        view.accessibilityIdentifier = "stem-preview"
        previewPill.layer.cornerRadius = StemCellsPreviewLayout.Metrics.pillHeight / 2
        previewPill.layer.cornerCurve = .continuous
        previewPill.clipsToBounds = true
        previewPill.isAccessibilityElement = true
        previewPill.accessibilityTraits = .header
        previewPill.accessibilityIdentifier = "stem-preview-title"
        previewPill.accessibilityLabel = title
        previewTitle.text = title
        previewTitle.font = .systemFont(ofSize: 17, weight: .semibold)
        previewTitle.textColor = .label
        previewTitle.textAlignment = .center
        previewTitle.lineBreakMode = .byTruncatingTail
        previewPill.contentView.addSubview(previewTitle)
        view.addSubview(previewFade)
        view.addSubview(previewPill)
    }

    private func layoutPreview() {
        replan()
        let layout = StemCellsPreviewLayout(size: view.bounds.size, titleSize: previewTitle.sizeThatFits(view.bounds.size))
        previewPill.frame = layout.pill
        previewTitle.frame = layout.title.offsetBy(dx: -layout.pill.minX, dy: -layout.pill.minY)
        scrollView.frame = view.bounds
        let insets = UIEdgeInsets(top: layout.listTop, left: 0, bottom: layout.listBottom, right: 0)
        if scrollView.contentInset != insets { scrollView.contentInset = insets }
        layoutTranscript()
        previewFade.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: layout.fadeOpaque)
        previewFade.clearFrom = layout.fadeClear / max(1, layout.fadeOpaque)
    }

    /// The newest message, taller than the card, shows from its start.
    private func showNewestFromItsStart() {
        guard previewing else { return }
        let views: [UIView] = [introView] + plans.compactMap { rowViews[$0.id] }
        if let newest = views.last(where: { $0.frame.height > 0 }), newest.frame.minY - scrollView.contentOffset.y < scrollView.contentInset.top {
            scrollView.contentOffset.y = newest.frame.minY - scrollView.contentInset.top
        }
        // Nothing scrolled under the title: nothing to fade, and the first line stays whole.
        previewFade.isHidden = scrollView.contentOffset.y <= -scrollView.contentInset.top + 0.5
    }

    private func layoutTranscript() {
        let width = view.bounds.width
        let viewport = max(0, view.bounds.height - scrollView.contentInset.top - scrollView.contentInset.bottom)
        var heights: [CGFloat] = []
        var introLayout: MakeStuffIntroLayout?
        if intro != nil {
            let layout = introView.layout(width: width)
            introLayout = layout
            heights.append(layout.size.height)
        }
        heights += plans.map(\.size.height)
        heights.append(chat.activity == nil ? 0 : StemCellWorkingLayout.Metrics.height)
        let stack = StemCellChatStackLayout(heights: heights, width: width, viewport: viewport)
        var index = 0
        if let introLayout {
            introView.setLayoutFrame(stack.frames[0])
            introView.place(introLayout)
            index = 1
        }
        for plan in plans {
            rowViews[plan.id]?.setLayoutFrame(stack.frames[index])
            index += 1
        }
        working.frame = stack.frames[index]
        let previous = scrollView.contentSize.height
        scrollView.contentSize = CGSize(width: width, height: stack.contentHeight)
        if followsNewest, previous != stack.contentHeight || scrollView.contentOffset.y != newestOffset {
            scrollView.contentOffset.y = newestOffset
        } else if !followsNewest, scrollView.contentOffset.y > newestOffset, !scrollView.isTracking, !scrollView.isDecelerating {
            // Shorter than the place it was read at (a section folded): no gap under the end.
            scrollView.contentOffset.y = newestOffset
        }
        showNewestFromItsStart()
    }

    private var newestOffset: CGFloat {
        max(-scrollView.contentInset.top, scrollView.contentSize.height + scrollView.contentInset.bottom - scrollView.bounds.height)
    }

    // MARK: Acts

    private func updatePrimary() {
        let hasContent = !card.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pictures.images.isEmpty
        card.configuration.primaryAction = AgentInputPrimaryAction.resolve(
            hasComposerContent: hasContent, isSendBlocked: false, isSendDisabled: false, showAbortButton: chat.working, canAbort: true
        )
    }

    private func send() {
        let text = card.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let picked = pictures.images.map(\.attachment)
        guard !text.isEmpty || !picked.isEmpty else { return }
        card.setText("", selection: NSRange(location: 0, length: 0))
        StemCellsHaptics.play(.send)
        followsNewest = true
        let conversation = conversation
        let store = session.store
        let staged = pictures
        Task {
            // Read off the main thread; the staged files go once they are read.
            let photos = await Task.detached {
                picked.compactMap { attachment in (try? Data(contentsOf: attachment.fileURL)).map { (mimeType: attachment.mimeType, data: $0) } }
            }.value
            staged.clear()
            await store.attentionInput()
            await conversation.send(text: text, pictures: photos)
        }
    }

    /// What a card says it opens; nil for any other hit.
    private func cardLabel(_ action: ChatRowAction) -> String? {
        switch action {
        case .openArtifact(let artifact): Strings.StemCells.open(artifact.title.isEmpty ? Strings.StemCells.untitledArtifact : artifact.title)
        case .openMedia(let key): media.media(key).flatMap { $0.isVisual ? nil : Strings.StemCells.open($0.item.name) }
        default: nil
        }
    }

    /// Desktop opens a picture in its Lightbox and plays a recording where
    /// it is; the phone plays it in the system player, and shows a document
    /// or file in Quick Look once its bytes are here.
    private func open(_ key: String) {
        if let file = media.media(key), !file.isVisual {
            let preview = StemCellFilePreview(loader: media, media: file)
            self.preview = preview
            Task { [weak self] in
                guard let controller = await preview.controller() else {
                    self?.showFileUnavailable()
                    return
                }
                self?.present(controller, animated: true)
            }
            return
        }
        if let player = media.player(key) {
            let playback = AVPlayerViewController()
            playback.player = player
            present(playback, animated: true) { player.play() }
            return
        }
        let presented = media.media(key)
        present(StemCellPictureViewController(source: media, key: key, thumbhash: presented?.item.thumbhash, label: presented?.item.name ?? Strings.StemCells.picture), animated: true)
    }

    private func showFileUnavailable() {
        let alert = UIAlertController(title: nil, message: Strings.StemCells.fileUnavailable, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Common.ok, style: .default))
        present(alert, animated: true)
    }

    @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
        // A tap away from the name being edited keeps it, as in the sidebar.
        if titleView.isEditing {
            titleView.finishEditing()
            return
        }
        for (id, row) in rowViews {
            let point = recognizer.location(in: row)
            guard row.bounds.contains(point) else { continue }
            if let link = row.link(at: point), let reference = HappyReferences.reference(link: link) {
                open(reference)
                return
            }
            if let link = row.link(at: point), let url = URL(string: link) {
                UIApplication.shared.open(url)
                return
            }
            switch row.action(at: point) {
            case .copyMessage(_, let text):
                UIPasteboard.general.string = text
                showCopied(id)
            case .retry(let localId):
                let conversation = conversation
                Task { await conversation.retry(localId) }
            case .openMedia(let key):
                open(key)
            case .openArtifact(let artifact):
                navigationController?.pushViewController(StemCellArtifactViewController(session: session, artifact: artifact), animated: true)
            case .toggleTool(let messageId):
                toggle(messageId)
            default:
                break
            }
            return
        }
    }

    /// Opens or closes another agent's message where it is, as the
    /// conversation grows anywhere: read at the newest, it stays there.
    private func toggle(_ messageId: String) {
        if opened.remove(messageId) == nil { opened.insert(messageId) }
        // It opens where the finger is, not pulled up after the newest line.
        followsNewest = false
        replan()
    }

    /// What a message names, opened over this one: a conversation, or an
    /// artifact at the version the reference pinned.
    private func open(_ reference: HappyReferences.Reference) {
        if reference.kind == "artifact" {
            // Still being read, the viewer reads it itself.
            var known: (title: String, type: String, latest: Int) = ("", "", 1)
            switch references.artifacts[reference.id] {
            case .active(let title, let type, let latest)?: known = (title, type, latest)
            case nil: let store = session.store; Task { await store.readArtifacts([reference.id]) }
            default: return
            }
            var artifact = StemCellArtifact(id: reference.id, version: reference.version ?? known.latest, type: known.type, title: known.title, followsLatest: reference.version == nil)
            artifact.pinned = reference.version != nil
            navigationController?.pushViewController(StemCellArtifactViewController(session: session, artifact: artifact), animated: true)
            return
        }
        guard let entity = references.entity(reference) else { return }
        // A bot's or task's own conversation opens as its row opens it: renamed in its bar, its mark in the intro.
        let row = sidebarRows.first { $0.kind == .space && $0.agentId == entity.agentId }
        let intro: Intro? = switch row?.mark {
        case .stemCell(let seed)?: .stemCell(seed: seed)
        case .clay(let slug)?: .clay(slug)
        default: nil
        }
        let title = references.view(reference).label
        let chat = StemCellChatViewController(session: session, agentId: entity.agentId, title: title, spaceId: row?.spaceId, stemCell: intro)
        navigationController?.pushViewController(chat, animated: true)
    }

    @objc private func held(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began else { return }
        for row in rowViews.values {
            let point = recognizer.location(in: row)
            guard row.bounds.contains(point), let hit = row.hold(at: point) else { continue }
            switch hit.action {
            case .copyMenu(let text), .selectable(let text):
                UIPasteboard.general.string = text
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            case .markdownSelectable(_, let markdown):
                navigationController?.pushViewController(TextSelectionViewController(text: markdown), animated: true)
            default:
                break
            }
            return
        }
    }

    // MARK: Offers

    /// Desktop's `createOfferSelect`: a Surface is named, then made and
    /// opened; a bot is made at once and its conversation opened. The new
    /// work stays where it is, under them.
    private func make(_ offer: StemCellOffer) {
        let store = session.store
        switch offer {
        case .bot:
            Task { @MainActor [weak self] in
                guard let bot = try? await store.createBot(), let agentId = bot.agent?.id, let self else { return }
                let chat = StemCellChatViewController(session: session, agentId: agentId, title: bot.name, spaceId: nil, stemCell: nil)
                navigationController?.pushViewController(chat, animated: true)
            }
        case .surface(let type):
            let alert = UIAlertController(title: Strings.StemCells.offer(offer), message: nil, preferredStyle: .alert)
            alert.addTextField { field in
                field.text = Strings.StemCells.surfaceName(type)
                field.placeholder = Strings.StemCells.nameIt
                field.autocapitalizationType = .sentences
                field.clearButtonMode = .whileEditing
                field.accessibilityIdentifier = "stem-offer-name"
            }
            alert.addAction(UIAlertAction(title: Strings.StemCells.cancel, style: .cancel))
            alert.addAction(UIAlertAction(title: Strings.StemCells.make, style: .default) { [weak self, weak alert] _ in
                let typed = alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let name = typed.isEmpty ? Strings.StemCells.surfaceName(type) : typed
                Task { @MainActor [weak self] in
                    guard let surface = try? await store.createSurface(type: type, name: name), let self else { return }
                    navigationController?.pushViewController(StemCellsSurfaceViewController(session: session, surface: surface), animated: true)
                }
            })
            present(alert, animated: true)
        }
    }

    private func showCopied(_ id: String) {
        copied?.until.cancel()
        let until = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, let self else { return }
            copied = nil
            replan()
        }
        copied = (id, until)
        replan()
    }
}

extension StemCellChatViewController: AgentInputCardDelegate {
    func agentInputCardDidChangeText(_ card: AgentInputCardView) {
        updatePrimary()
    }

    func agentInputCardDidInvalidateHeight(_ card: AgentInputCardView) {
        if card.animatesHeightChange {
            UIView.animate(withDuration: 0.2) { self.view.setNeedsLayout(); self.view.layoutIfNeeded() }
        } else {
            view.setNeedsLayout()
        }
    }

    func agentInputCardDidPressPrimary(_ card: AgentInputCardView) {
        if card.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, pictures.images.isEmpty {
            guard chat.working else { return }
            let conversation = conversation
            Task { await conversation.abort() }
        } else {
            send()
        }
    }

    func agentInputCardDidPressSend(_ card: AgentInputCardView) { send() }

    /// The add button opens the shared library sheet at once: no question
    /// first. Photos only: a message carries text and pictures alone.
    func agentInputCardDidPressAdd(_ card: AgentInputCardView) {
        presentLibrary(from: self)
    }

    func agentInputCard(_ card: AgentInputCardView, didRemoveAttachment id: String) { pictures.remove(id: id) }

    func agentInputCard(_ card: AgentInputCardView, didSelect key: String, in chip: AgentInputChip) {
        StemCellModelPickers.Kind(rawValue: key).map(pick)
    }

    func agentInputCard(_ card: AgentInputCardView, didPress chip: AgentInputChip) {
        switch chip {
        case .permission: pick(.provider)
        case .model: pick(.model)
        case .effort: pick(.effort)
        }
    }

    func agentInputCardDidPressStop(_ card: AgentInputCardView) {
        let conversation = conversation
        Task { await conversation.abort() }
    }
}

extension StemCellChatViewController: ChatMediaProviding {
    var chatMedia: ChatMediaSource? { media }
}

extension StemCellChatViewController: StoriesProviding {
    var stories: StoriesSession? { StoriesSession.session(for: session) }
}

private extension ChatDrawItem {
    /// Where a message's words are drawn: its bubble, text and blocks, not
    /// its pictures.
    var wordsFrame: CGRect? {
        switch self {
        case .box(let box): box.frame
        case .text(_, let frame), .scroller(_, let frame, _, _), .mermaid(_, let frame), .webImage(_, let frame, _), .diff(_, let frame, _, _, _, _), .diffHeader(_, _, let frame): frame
        default: nil
        }
    }
}

extension StemCellChatViewController: UIScrollViewDelegate {
    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard scrollView.isTracking || scrollView.isDecelerating else { return }
        followsNewest = scrollView.contentOffset.y >= newestOffset - 24
        if scrollView.contentOffset.y < 200 - scrollView.contentInset.top, chat.hasMore {
            let conversation = conversation
            Task { await conversation.loadOlder() }
        }
    }
}

/// The preview card's own ground, whole and then none of it: the same
/// colour to its own clear, so it draws nothing but the messages going.
final class StemCellsPreviewFadeView: UIView {
    override class var layerClass: AnyClass { CAGradientLayer.self }

    /// Where, from 0 at the top to 1 at the foot, the ground starts to go.
    var clearFrom: CGFloat = 0 {
        didSet { if clearFrom != oldValue { update() } }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        update()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.update()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    private func update() {
        guard let layer = layer as? CAGradientLayer else { return }
        let ground = UIColor(Palette.surface).resolvedColor(with: traitCollection)
        layer.colors = [ground.cgColor, ground.cgColor, ground.withAlphaComponent(0).cgColor]
        layer.locations = [0, NSNumber(value: Double(clearFrom)), 1]
    }
}
/// The navigation controller's edge swipe back while a screen hides the
/// bar: it begins whenever there is a screen to go back to, and the
/// system's own delegate is given back on leaving.
@MainActor
final class StemCellsSwipeBack: NSObject, UIGestureRecognizerDelegate {
    private weak var navigation: UINavigationController?
    private weak var system: (any UIGestureRecognizerDelegate)?

    func attach(to navigation: UINavigationController) {
        guard self.navigation == nil, let gesture = navigation.interactivePopGestureRecognizer else { return }
        self.navigation = navigation
        system = gesture.delegate
        gesture.delegate = self
        gesture.isEnabled = true
    }

    func detach() {
        guard let navigation else { return }
        if navigation.interactivePopGestureRecognizer?.delegate === self { navigation.interactivePopGestureRecognizer?.delegate = system }
        self.navigation = nil
        system = nil
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        (navigation?.viewControllers.count ?? 0) > 1 && navigation?.transitionCoordinator == nil
    }
}
#endif
