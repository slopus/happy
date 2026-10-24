#if canImport(UIKit)
import AVKit
import HappyCore
import HappyLayout
import UIKit

/// One Stem Cells conversation, simplified from desktop's: the work's
/// intro at the top (its stem cell, or the clay icon it grew into, over
/// "Say what it is — it’ll find its place."), what the person wrote and
/// what the agent said with the pictures and recordings it presented, and
/// a composer that sends photos too. Tool calls are never shown.
///
/// New work opens here before the daemon has made it: the intro and the
/// composer are up at once, and a first message waits for the work to exist.
final class StemCellChatViewController: UIViewController {
    typealias Intro = StemCellIntroView.Mark

    private let session: StemCellsSession
    private let conversation: StemCellConversation
    private let spaceId: String?
    private let opensFocused: Bool
    private var intro: Intro?
    private let planner: StemCellChatPlanner
    private let media: StemCellMediaLoader
    private let pictures: ComposerImagePicker

    private let scrollView = UIScrollView()
    private let introView = StemCellIntroView()
    private var rowViews: [String: ChatPlanView] = [:]
    private var plans: [ChatRowPlan] = []
    private let working = StemCellsShimmerLabel()
    private let card = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: Strings.Composer.inputPlaceholder))
    private let keyboardTracker = UIView()

    private var chat = StemCellChatSnapshot()
    private var following: Task<Void, Never>?
    private var planning: Task<Void, Never>?
    private var planned: (items: [StemCellChatItem], key: StemCellChatPlanner.Key, copied: String?)?
    private var watch: StemCellsWatch?
    private var copied: (id: String, until: Task<Void, Never>)?
    /// The newest row is in view: what arrives keeps it there.
    private var followsNewest = true

    init(session: StemCellsSession, agentId: String, title: String, spaceId: String?, stemCell intro: Intro?, creation: StemCellCreation? = nil) {
        self.session = session
        self.spaceId = spaceId
        self.intro = intro
        opensFocused = creation != nil
        conversation = StemCellConversation(client: session.client, store: session.store, agentId: agentId, creation: creation?.created)
        planner = StemCellChatPlanner(syntax: session.syntax)
        media = StemCellMediaLoader(client: session.client, agentId: agentId)
        let files = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("StemCells", isDirectory: true)
        pictures = ComposerImagePicker(staging: ComposerAttachmentStaging(filesDirectory: files))
        super.init(nibName: nil, bundle: nil)
        self.title = title
        navigationItem.largeTitleDisplayMode = .never
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
        working.attributedText = NSAttributedString(string: Strings.StemCells.working, attributes: [.font: StemCellsFonts.ui(.medium, size: 15)])
        working.textColor = UIColor(Palette.textSecondary)
        working.isHidden = true
        working.isAccessibilityElement = true
        working.accessibilityLabel = Strings.StemCells.working
        working.accessibilityIdentifier = "stem-working"
        scrollView.addSubview(working)
        introView.accessibilityIdentifier = "stem-intro"
        introView.onOffer = { [weak self] offer in self?.make(offer) }
        // New work asks what it is; a conversation already going asks for the next message.
        if case .stemCell = intro { card.configuration.placeholder = Strings.StemCells.composerPlaceholder }
        card.configuration.showsAdd = true
        card.configuration.addAccessibilityLabel = Strings.StemCells.addPicture
        card.delegate = self
        card.textView.accessibilityIdentifier = "stem-composer"
        pictures.host = { [weak self] in self }
        pictures.onChange = { [weak self] in
            guard let self else { return }
            card.configuration.attachments = pictures.images.map { AgentInputAttachmentPreview(id: $0.id, fileURL: $0.attachment.fileURL) }
            updatePrimary()
        }
        view.addSubview(card)

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

        applyIntro()
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
        // New work: the keyboard comes up with the screen.
        if opensFocused { card.focus() }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(false, animated: animated)
        let conversation = conversation
        Task { await conversation.setVisible(true) }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        let conversation = conversation
        Task { await conversation.setVisible(false) }
        if isMovingFromParent || navigationController == nil {
            following?.cancel()
            planning?.cancel()
            watch?.invalidate()
            Task { await conversation.stop() }
        }
    }

    // MARK: State

    /// The row's name and mark as the sidebar has them: Prioritizing's name
    /// lands here too, and the stem cell gives way to its clay icon.
    private func follow(_ snapshot: StemCellsSnapshot) {
        if introView.offers != snapshot.offers {
            introView.setOffers(snapshot.offers)
            view.setNeedsLayout()
        }
        guard let spaceId, let row = snapshot.rows.first(where: { $0.spaceId == spaceId }) else { return }
        if title != row.label { title = row.label }
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
        working.shimmering = snapshot.working
        working.isHidden = !snapshot.working
        if wasSettled != !snapshot.items.isEmpty, let intro { introView.configure(intro, settled: !snapshot.items.isEmpty) }
        updatePrimary()
        replan()
        view.setNeedsLayout()
    }

    private var planKey: StemCellChatPlanner.Key {
        StemCellChatPlanner.Key(width: view.bounds.width, maxContentWidth: ContentWidth.maxWidth, environment: traitCollection.textEnvironment)
    }

    /// Plans the rows off the main thread, then shows them in one frame.
    private func replan() {
        let key = planKey
        guard key.width > 0 else { return }
        let items = chat.items
        let copiedId = copied?.id
        if let planned, planned.items == items, planned.key == key, planned.copied == copiedId { return }
        planned = (items, key, copiedId)
        planning?.cancel()
        let planner = planner
        planning = Task { [weak self] in
            let plans = await planner.plans(items, key: key, copied: copiedId)
            guard !Task.isCancelled, let self else { return }
            self.show(plans)
        }
    }

    private func show(_ plans: [ChatRowPlan]) {
        self.plans = plans
        var seen = Set<String>()
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
            // A row with media reads as its message, then each picture or
            // recording on its own.
            let media = row.mediaViews
            row.isAccessibilityElement = media.isEmpty
            if media.isEmpty {
                row.accessibilityElements = nil
            } else {
                let message = UIAccessibilityElement(accessibilityContainer: row)
                message.accessibilityLabel = plan.accessibilityLabel
                message.accessibilityIdentifier = "stem-message"
                message.accessibilityFrameInContainerSpace = CGRect(origin: .zero, size: plan.size)
                row.accessibilityElements = [message] + media
            }
        }
        for (id, row) in rowViews where !seen.contains(id) {
            row.removeFromSuperview()
            rowViews.removeValue(forKey: id)
        }
        layoutTranscript()
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        replan()
        let screen = StemCellChatScreenLayout(
            size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets),
            keyboardTop: keyboardTracker.frame.minY
        ) { [card] width in card.height(fitting: width) }
        card.setLayoutFrame(screen.card)
        scrollView.frame = view.bounds
        let insets = UIEdgeInsets(top: screen.listTop, left: 0, bottom: screen.listBottom, right: 0)
        if scrollView.contentInset != insets {
            scrollView.contentInset = insets
            scrollView.verticalScrollIndicatorInsets = insets
        }
        layoutTranscript()
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
        let workingHeight: CGFloat = chat.working ? 36 : 0
        heights.append(workingHeight)
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
        let workingFrame = stack.frames[index]
        let workingSize = working.sizeThatFits(CGSize(width: width - 32, height: workingHeight))
        working.frame = CGRect(x: 16, y: workingFrame.minY + (workingHeight - workingSize.height) / 2, width: min(workingSize.width, width - 32), height: workingSize.height)
        let previous = scrollView.contentSize.height
        scrollView.contentSize = CGSize(width: width, height: stack.contentHeight)
        if followsNewest, previous != stack.contentHeight || scrollView.contentOffset.y != newestOffset {
            scrollView.contentOffset.y = newestOffset
        }
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

    /// Desktop opens a picture in its Lightbox and plays a recording where
    /// it is; the phone plays it in the system player.
    private func open(_ key: String) {
        if let player = media.player(key) {
            let playback = AVPlayerViewController()
            playback.player = player
            present(playback, animated: true) { player.play() }
            return
        }
        let presented = media.media(key)
        present(StemCellPictureViewController(source: media, key: key, thumbhash: presented?.item.thumbhash, label: presented?.item.name ?? Strings.StemCells.picture), animated: true)
    }

    @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
        for (id, row) in rowViews {
            let point = recognizer.location(in: row)
            guard row.bounds.contains(point) else { continue }
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
            default:
                break
            }
            return
        }
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

    func agentInputCardDidPressAdd(_ card: AgentInputCardView) { pictures.attach() }

    func agentInputCard(_ card: AgentInputCardView, didRemoveAttachment id: String) { pictures.remove(id: id) }

    func agentInputCardDidPressStop(_ card: AgentInputCardView) {
        let conversation = conversation
        Task { await conversation.abort() }
    }
}

extension StemCellChatViewController: ChatMediaProviding {
    var chatMedia: ChatMediaSource? { media }
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

#endif
