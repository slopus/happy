#if canImport(UIKit)
import AVKit
import HappyCore
import HappyLayout
import Photos
import QuickLook
import UIKit
import UniformTypeIdentifiers

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
    /// A conversation read ahead (`StemCellsWarmChats`), held while this
    /// screen shows it; nil for new work, which has its own.
    private let warm: (chat: StemCellsWarmChats.Chat, token: UUID)?
    /// When its row was tapped, to time how soon it showed.
    private let tappedAt: CFTimeInterval?
    /// What the push's first frame had: the transcript, or nothing yet.
    private var firstFrame: Bool?
    private let spaceId: String?
    /// New work nobody named or wrote in, as its row says.
    private var untouched: Bool
    /// Named or written in here: kept, whatever the row says until the
    /// store catches up.
    private var kept = false
    private let opensFocused: Bool
    /// New work brings the keyboard up as it opens, unless it opens on the "+" sheet.
    var focusesOnOpen = true
    /// Opened on the "+" sheet: the first thing added brings the keyboard up, once.
    var focusesAfterPick = false
    /// The keyboard was up as the "+" sheet opened: it comes back once the
    /// sheet, and whatever was chosen on it, is done.
    private var keyboardOwed = false
    /// New work from home's dock: it fades in and out over home with the
    /// composer where the dock is (`StemCellsNewWorkTransition`), and an
    /// edge swipe drives the way back.
    var opensOverHome = false
    /// The keyboard new work opens with, not yet asked for.
    private var focusPending = false
    private var swipeHome: UIPercentDrivenInteractiveTransition?
    private var focusedBeforeSwipe = false
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
    /// The screen's ground under and beside the composer: the transcript
    /// ends where the composer starts, never showing under or through it.
    /// Home's dock scrim, under the composer and feathered above it. Over
    /// home it lies on home's own dock scrim, so new work's fade leaves it.
    private let composerScrim = HeaderScrimView(edge: .bottom)
    /// Where the transcript's drawn content starts and ends in it (not the
    /// room held under a lifted send or waiting steering): what the scrims
    /// measure how far it has gone under them by.
    private var contentSpan: ClosedRange<CGFloat> = 0...0
    /// A jump to the newest message under way: layout moves its target
    /// rather than cutting it short.
    private var jumping = false
    /// Desktop's way back to the newest message.
    private let jump = StemCellChatJumpButton()
    private var jumpShown = false
    private let card = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: Strings.Composer.inputPlaceholder))
    private let keyboardTracker = UIView()
    /// The keyboard's top as its notifications last said (down: past any
    /// screen), which the composer rides on the keyboard's own curve. The
    /// guide (`keyboardTracker`) moves a layout pass ahead of them, so it
    /// is followed only while a finger may be dragging the keyboard down:
    /// from a drag's start until they say where it went.
    private var keyboardTop = CGFloat.greatestFiniteMagnitude
    private var fingerOnKeyboard = false

    private var chat = StemCellChatSnapshot()
    private var following: Task<Void, Never>?
    private var planning: Task<Void, Never>?
    private var planned: (items: [StemCellChatItem], key: StemCellChatPlanner.Key, copied: String?, opened: Set<String>, proposals: [String: StemCellProposalShown], queued: Set<String>)?
    /// The steering waiting under the working line, as of the plans on
    /// screen: read with them, never with a snapshot they don't show yet.
    private var plansQueued = Set<String>()
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
    /// The steering last drawn under the working line.
    private var queuedShown = Set<String>()
    /// The composer's text full screen, while it is up.
    private weak var editor: ComposerEditorViewController?
    /// The draft arrivals set here so far (`StemCellChatSnapshot.draftArrivals`);
    /// none yet, so the first snapshot's draft shows, however a conversation
    /// read ahead came by it.
    private var draftArrivals = -1
    /// Set while a draft from elsewhere goes into the composer: not typing.
    private var showingDraft = false
    /// The last keystroke's stamp, never going back.
    private var lastDraftEdit: Double = 0
    /// A message sent while the agent was idle, not yet drawn: as it lands
    /// it is lifted to desktop's line (`StemCellSendLift`).
    private var liftPending: String?
    /// The lifted send and its line, while the reply hasn't filled the room
    /// under it.
    private var lift: (id: String, line: CGFloat)?
    /// Where the transcript's rows end, as last laid out; nil while they
    /// stand off the top (a short one resting on its composer), where
    /// dropping a lift would move them.
    private var rowsEnd: CGFloat?
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
        untouched = creation != nil
        focusPending = creation != nil
        if creation == nil {
            let held = session.warm.hold(agentId)
            warm = held
            conversation = held.chat.conversation
            // A preview lays out at its card's width: its own planner, so
            // the full width's rows stay cached.
            planner = previewing ? StemCellChatPlanner(syntax: session.syntax) : held.chat.planner
        } else {
            warm = nil
            conversation = StemCellConversation(client: session.client, store: session.store, agentId: agentId, creation: creation?.created, mode: session.models.newWorkMode, persistence: session.engine)
            planner = StemCellChatPlanner(syntax: session.syntax)
        }
        tappedAt = previewing ? nil : session.warm.takeTap(agentId)
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
            creating = true
            Task { [weak self] in
                guard let id = try? await created.value else { return }
                self?.media.agentId = id
                self?.creating = false
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
        // New work asks what it is; a conversation already going asks for the next message.
        if case .stemCell = intro { card.configuration.placeholder = Strings.StemCells.composerPlaceholder }
        card.configuration.showsAdd = true
        card.configuration.showsExpand = true
        card.configuration.addAccessibilityLabel = Strings.StemCells.addPicture
        card.delegate = self
        card.textView.accessibilityIdentifier = "stem-composer"
        card.accessibilityIdentifier = "stem-input"
        // A long press's Paste attaches a copied picture.
        card.textView.onPasteAttachment = { [weak self] in self?.pictures.paste() }
        pictures.host = { [weak self] in self }
        pictures.onChange = { [weak self] in
            guard let self else { return }
            card.configuration.attachments = pictures.images.map { AgentInputAttachmentPreview(id: $0.id, fileURL: $0.attachment.fileURL) }
            updatePrimary()
        }
        view.addSubview(composerScrim)
        jump.isHidden = true
        jump.alpha = 0
        jump.addTarget(self, action: #selector(jumpToLatest), for: .touchUpInside)
        view.addSubview(jump)
        view.addSubview(card)
        header.onBack = { [weak self] in
            guard let self else { return }
            // The keyboard goes down with the composer as the screen goes.
            if opensOverHome { card.blur() }
            navigationController?.popViewController(animated: true)
        }
        header.onOpen = { [weak self] in self?.openDetail() }
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

        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillChange(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)

        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.cancelsTouchesInView = false
        scrollView.addGestureRecognizer(tap)
        scrollView.addGestureRecognizer(UILongPressGestureRecognizer(target: self, action: #selector(held(_:))))

        if previewing { setUpPreview() }
        applyIntro()
        proposals.onChange = { [weak self] in self?.replan() }
        watch = session.watch { [weak self] snapshot in self?.follow(snapshot) }
        if let warm {
            // Read ahead: what it has shows on the first frame.
            session.warm.watch(warm.chat, token: warm.token) { [weak self] snapshot in self?.apply(snapshot) }
            if warm.chat.snapshot.loaded { apply(warm.chat.snapshot) }
        } else {
            let updates = conversation.updates
            following = Task { [weak self] in
                for await snapshot in updates {
                    guard let self else { return }
                    self.apply(snapshot)
                }
            }
            let conversation = conversation
            Task { await conversation.start() }
        }
        if !previewing {
            let conversation = conversation
            let drafts = session.drafts
            Task { await conversation.useDrafts(drafts) }
        }
        modelsWatch = session.models.watch { [weak self] in self?.updateChips() }
        session.models.load()
        updateChips()
        if opensOverHome {
            let edge = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(swipedHome(_:)))
            edge.edges = .left
            view.addGestureRecognizer(edge)
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // A preview is only looked at: what it shows stays unread.
        if previewing { return }
        // What the keyboard did while another screen was over this one
        // went unheard: down, unless it is still this composer's.
        fingerOnKeyboard = false
        if !card.textView.isFirstResponder { keyboardTop = .greatestFiniteMagnitude }
        // The header is the screen's own glass.
        navigationController?.setNavigationBarHidden(true, animated: animated)
        let conversation = conversation
        Task { await conversation.setVisible(true) }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !previewing, let navigationController else { return }
        // New work: the keyboard comes up with the screen, if nothing asked yet.
        takeOpeningFocus()
        // Over home, the way back is this screen's own swipe.
        if opensOverHome, navigationController.viewControllers.first is StemCellsDockHosting {
            navigationController.interactivePopGestureRecognizer?.isEnabled = false
        } else {
            swipeBack.attach(to: navigationController)
        }
        // A swipe back let go of halfway gives the bar back to the screen
        // under it after this one appeared: hidden again.
        if !navigationController.isNavigationBarHidden { navigationController.setNavigationBarHidden(true, animated: false) }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // Leaving keeps a name being typed, as a tap away does.
        titleView.finishEditing()
        picker?.close(animated: false)
        if isMovingFromParent { putAwayIfEmpty() }
        if !previewing {
            let conversation = conversation
            Task { await conversation.flushDraft() }
        }
        swipeBack.detach()
        navigationController?.interactivePopGestureRecognizer?.isEnabled = true
        // A screen pushed over this one has the bar it expects.
        if !previewing, !isMovingFromParent, let top = navigationController?.topViewController, top !== self, !(top is StemCellChatViewController), !(top is StemCellSessionDetailViewController) {
            navigationController?.setNavigationBarHidden(false, animated: animated)
        }
    }

    /// New work left with nothing in it goes: off the sidebar as the screen
    /// starts to go, so the sidebar comes back without it, and off the
    /// computer once it has gone. A swipe back let go of halfway keeps it.
    private func putAwayIfEmpty() {
        guard !previewing, let spaceId, untouched, !kept, chat.loaded, chat.items.isEmpty, !card.hasContent else { return }
        putAway = true
        let store = session.store
        Task { await store.putAway(spaceId, true) }
        guard let coordinator = transitionCoordinator else {
            Task { await store.discard(spaceId) }
            return
        }
        coordinator.animate(alongsideTransition: nil) { context in
            // Read now: the context doesn't outlive this call.
            let cancelled = context.isCancelled
            Task { cancelled ? await store.putAway(spaceId, false) : await store.discard(spaceId) }
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
            // Read ahead, it stays read for a quick way back.
            if let warm {
                session.warm.release(warm.chat, token: warm.token, opened: !previewing, putAway: putAway)
            } else {
                Task { await conversation.stop() }
            }
        }
    }

    // MARK: Detail

    /// The conversation's detail, over it: its numbers, its family and its
    /// activity, and its rename. New work has none until the daemon made it.
    private func openDetail() {
        guard !previewing, !creating, !media.agentId.isEmpty else { return }
        let agentId = media.agentId
        card.blur()
        let detail = StemCellSessionDetailViewController(session: session, agentId: agentId, title: title ?? "", spaceId: spaceId)
        detail.onRenamed = { [weak self] in self?.kept = true }
        navigationController?.pushViewController(detail, animated: true)
    }

    // MARK: Keyboard

    /// The composer goes with the keyboard: to the same place, in the same
    /// time, on the same curve.
    @objc private func keyboardWillChange(_ note: Notification) {
        guard !previewing, let screen = view.window?.screen,
              let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
        let curve = (note.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?.uintValue ?? 7
        let local = view.convert(end, from: screen.coordinateSpace)
        let top = local.minY >= view.bounds.maxY || local.isEmpty ? CGFloat.greatestFiniteMagnitude : local.minY
        keyboardTop = top
        fingerOnKeyboard = false
        guard duration > 0 else { return view.setNeedsLayout() }
        UIView.animate(withDuration: duration, delay: 0, options: [UIView.AnimationOptions(rawValue: curve << 16), .beginFromCurrentState, .allowUserInteraction]) {
            self.view.setNeedsLayout()
            self.view.layoutIfNeeded()
        }
    }

    // MARK: Over home

    /// The keyboard new work opens with: asked for once, as the screen comes in.
    func takeOpeningFocus() {
        guard focusPending else { return }
        focusPending = false
        guard focusesOnOpen else { return }
        card.focus()
    }

    /// New work over home, from 0 (only the composer, where the dock is) to
    /// 1 (all of it). A composer holding something the dock doesn't fades too.
    func newWorkFade(_ alpha: CGFloat) {
        view.backgroundColor = UIColor(Palette.surface).withAlphaComponent(alpha)
        scrollView.alpha = alpha
        jump.alpha = jumpShown ? alpha : 0
        header.alpha = alpha
        card.alpha = composerIsEmpty ? 1 : alpha
    }

    /// Nothing typed or picked: the composer is the dock's very picture.
    var composerIsEmpty: Bool { card.text.isEmpty && pictures.images.isEmpty }

    /// A swipe home let go of: the keyboard comes back if it was up.
    func newWorkPopCancelled() {
        if focusedBeforeSwipe { card.focus() }
        focusedBeforeSwipe = false
    }

    @objc private func swipedHome(_ pan: UIScreenEdgePanGestureRecognizer) {
        let progress = min(1, max(0, pan.translation(in: view).x / max(1, view.bounds.width)))
        switch pan.state {
        case .began:
            guard let navigationController, navigationController.transitionCoordinator == nil, navigationController.viewControllers.count > 1 else { return }
            titleView.finishEditing()
            swipeHome = UIPercentDrivenInteractiveTransition()
            focusedBeforeSwipe = card.textView.isFirstResponder
            card.blur()
            navigationController.popViewController(animated: true)
        case .changed:
            swipeHome?.update(progress)
        case .ended, .cancelled, .failed:
            // Past a third and still going right, or flung: home. Flicked back: stays.
            let velocity = pan.velocity(in: view).x
            if pan.state == .ended, velocity > 600 || (progress > 0.35 && velocity >= -100) {
                swipeHome?.finish()
            } else {
                swipeHome?.cancel()
            }
            swipeHome = nil
        default:
            break
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
        // Under a folded section too.
        if let spaceId, let row = snapshot.allRows.first(where: { $0.spaceId == spaceId }) { untouched = row.isUntouchedStemCell }
        guard let spaceId, let row = snapshot.allRows.first(where: { $0.spaceId == spaceId }) else { return }
        if title != row.label { title = row.label }
        titleView.text = row.label
        if previewing, previewTitle.text != row.label {
            previewTitle.text = row.label
            previewPill.accessibilityLabel = row.label
            view.setNeedsLayout()
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
        showIntro()
        if let intro { introView.configure(intro, settled: settled(chat)) }
        view.setNeedsLayout()
    }

    /// The intro shows with what is under it: not alone, where an empty
    /// conversation has it, while history is read or its rows are first
    /// planned. A send into an empty one keeps it up.
    private func showIntro() {
        introView.isHidden = intro == nil || reading(chat) || (!chat.items.isEmpty && !planShown)
    }
    /// Left empty and put away as the screen went: nothing to keep of it.
    private var putAway = false

    /// New work the daemon hasn't made yet: it has no detail to open.
    private var creating = false

    /// A plan has been shown, if only an empty one.
    private var planShown = false

    /// History still being read: nothing shows yet, not the intro alone
    /// where an empty conversation has it, nor the computer's default model.
    /// New work has none to read.
    private func reading(_ chat: StemCellChatSnapshot) -> Bool { !chat.loaded && !opensFocused }

    /// The intro's "say what it is" line is for work with nothing in it yet.
    private func settled(_ chat: StemCellChatSnapshot) -> Bool { reading(chat) || !chat.items.isEmpty }

    private func apply(_ snapshot: StemCellChatSnapshot) {
        let wasSettled = settled(chat)
        chat = snapshot
        if picked == snapshot.mode { picked = nil }
        media.register(snapshot.items)
        if snapshot.draftArrivals != draftArrivals {
            draftArrivals = snapshot.draftArrivals
            // Typed here since, on its way to the conversation: that stands.
            if snapshot.draftUpdatedAt >= lastDraftEdit { showDraft(snapshot.draft) }
        }
        proposals.want(snapshot.items.flatMap(\.proposalIds))
        working.show(snapshot.activity)
        header.status = Self.status(snapshot.activity)
        if wasSettled != settled(snapshot), let intro { introView.configure(intro, settled: settled(snapshot)) }
        showIntro()
        updatePrimary()
        updateChips()
        replan()
        view.setNeedsLayout()
    }

    // MARK: Model

    /// What the next message goes with: the conversation's, else what new
    /// work starts on, else the computer's default.
    private var mode: AgentWire.Mode? {
        picked ?? chat.mode ?? (opensFocused ? session.models.newWorkMode : nil) ?? session.models.catalog?.defaultMode()
    }
    /// A pick made here, until the conversation's own mode says it back.
    private var picked: AgentWire.Mode?
    /// The "+" sheet while it is up: its permission menu follows the mode.
    private weak var attachSheet: StemCellAttachSheetViewController?
    /// The model or effort list while it is open.
    private var picker: StemCellPickerPresenter?

    private var menus: StemCellModelMenus? {
        session.models.catalog.flatMap { catalog in mode.map { StemCellModelMenus(catalog: catalog, selection: $0) } }
    }

    private func updateChips() {
        if reading(chat), picked == nil {
            card.configuration.model = nil
            card.configuration.effort = nil
        } else {
            StemCellModelPickers.configure(card, menus: menus)
            picker?.update(menus: menus, usage: session.models.usage)
        }
        if let attachSheet {
            attachSheet.permission = permissionName
            attachSheet.permissionMenu = permissionMenu
        }
    }

    /// The "+" sheet's permission menu; nil until the models are read.
    private var permissionMenu: UIMenu? {
        menus.map { menus in
            UIMenu(StemCellModelPickers.permissionMenu(menus)) { [weak self] key in self?.choose(key) }
        }
    }

    /// The "+" sheet over `host`: home's dock opens it over this screen as
    /// the screen comes in. What it adds waits in the composer, which then
    /// takes the keyboard.
    func presentAttach(from host: UIViewController) {
        let sheet = StemCellAttachSheetViewController(limit: ComposerAttachmentRules.remaining(selected: pictures.images.count), permission: permissionName)
        sheet.permissionMenu = permissionMenu
        if session.models.catalog == nil { session.models.load() }
        sheet.onAction = { [weak self] action in
            guard let self else { return }
            switch action {
            case .photos: presentLibrary()
            case .camera: presentCamera()
            case .add(let ids): add(assets: ids)
            case .paste: pasteFromClipboard()
            case .files: presentFiles()
            // Its menu waits for the models, read as the sheet opened.
            case .permission: session.models.load()
            }
        }
        // The keyboard goes while the sheet is up: a menu over the sheet
        // gives the keys back to the composer as it opens, which would put
        // the keyboard over the sheet. It comes back once the sheet is
        // closed, or once what was chosen there is done.
        keyboardOwed = card.textView.isFirstResponder
        card.blur()
        sheet.onGone = { [weak self] in self?.settleFocus(added: false) }
        attachSheet = sheet
        host.present(sheet, animated: true)
    }

    /// The mode the next message runs with, by its name.
    private var permissionName: String {
        Strings.StemCells.permissionName(mode?.permissionMode ?? session.models.catalog?.defaultPermissionMode ?? "auto")
    }

    /// The whole library, photos only: a message carries text and pictures alone.
    private func presentLibrary() {
        let room = pictures.room()
        guard room > 0 else { return settleFocus(added: false) }
        let picker = LibraryPicker.present(from: self, options: .init(limit: room, videos: false)) { [weak self] picks in self?.take(picks) }
        picker.onCancel = { [weak self] in self?.settleFocus(added: false) }
    }

    /// Photos picked in the sheet's strip, read in full off the main thread.
    private func add(assets ids: [String]) {
        Task { [weak self] in
            let found = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
            let byID = Dictionary((0..<found.count).map { (found.object(at: $0).localIdentifier, found.object(at: $0)) }, uniquingKeysWith: { a, _ in a })
            var picks: [LibraryPick] = []
            for id in ids {
                guard let asset = byID[id], let pick = await LibraryPicker.read(asset) else { continue }
                picks.append(pick)
            }
            guard let self else { return LibraryPicker.discard(picks) }
            take(picks)
        }
    }

    private func presentCamera() {
        guard UIImagePickerController.isSourceTypeAvailable(.camera), pictures.room() > 0 else { return settleFocus(added: false) }
        let camera = UIImagePickerController()
        camera.sourceType = .camera
        camera.mediaTypes = [UTType.image.identifier]
        camera.delegate = self
        present(camera, animated: true)
    }

    private func presentFiles() {
        guard pictures.room() > 0 else { return settleFocus(added: false) }
        let files = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
        files.allowsMultipleSelection = true
        files.delegate = self
        present(files, animated: true)
    }

    /// The clipboard, read as the system allows: a picture attaches, text
    /// goes in where the cursor is, anything else is said, not sent. What
    /// it holds is asked without a prompt; reading it may prompt, and a
    /// prompt waits on the thread that reads, so that is never this one.
    private func pasteFromClipboard() {
        let board = UIPasteboard.general
        let picture = board.hasImages
        guard picture || board.hasStrings || board.hasURLs else { return nothingToPaste() }
        Task { [weak self] in
            let clip = await Task.detached(priority: .userInitiated) { Self.readClipboard(picture: picture) }.value
            guard let self else { return }
            switch clip {
            case .picture(let data):
                guard pictures.room() > 0 else { return settleFocus(added: false) }
                pictures.add(pictures: [data])
                settleFocus(added: true)
            case .text(let text):
                focusesAfterPick = false
                keyboardOwed = false
                card.focus()
                card.textView.insertText(text)
            case .other:
                nothingToPaste()
            case nil:
                // Refused, or gone since it was asked about.
                settleFocus(added: false)
            }
        }
    }

    private enum Clip: Sendable {
        case picture(Data)
        case text(String)
        /// A file copied in Files, say: its name is not what was meant.
        case other
    }

    /// The picture as it was copied (so its orientation comes along), else
    /// re-encoded; else the text. Nil when the paste was refused.
    nonisolated private static func readClipboard(picture: Bool) -> Clip? {
        let board = UIPasteboard.general
        if picture {
            for type in board.types {
                guard let uti = UTType(type), uti.conforms(to: .image), let data = board.data(forPasteboardType: type), !data.isEmpty else { continue }
                return .picture(data)
            }
            if let data = board.image?.pngData() { return .picture(data) }
        }
        if board.types.contains(UTType.fileURL.identifier) { return .other }
        guard let text = board.string ?? board.url?.absoluteString, !text.isEmpty else { return nil }
        return .text(text)
    }

    /// Said, then the keyboard as it was, once it is read.
    private func nothingToPaste() {
        let alert = UIAlertController(title: Strings.StemCells.nothingToPaste, message: Strings.StemCells.filesNotSentDetail, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.StemCells.done, style: .default) { [weak self] _ in self?.settleFocus(added: false) })
        present(alert, animated: true)
    }

    /// What the sheet, the library or Files gave: pictures wait in the
    /// composer; any other file is said, not sent (the daemon takes text
    /// and image blocks alone).
    private func take(_ picks: [LibraryPick]) {
        pictures.add(pictures: picks.compactMap { if case .image(let data, _) = $0.media { data } else { nil } })
        let others = picks.filter { if case .image = $0.media { false } else { true } }
        LibraryPicker.discard(others)
        let added = picks.count > others.count
        if !others.isEmpty {
            let names = others.compactMap { pick -> String? in
                switch pick.media {
                case .file(let url, _), .video(let url): url.lastPathComponent
                case .image: nil
                }
            }
            let alert = UIAlertController(title: Strings.StemCells.filesNotSent(names), message: Strings.StemCells.filesNotSentDetail, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: Strings.StemCells.done, style: .default) { [weak self] _ in self?.settleFocus(added: added) })
            present(alert, animated: true)
        } else {
            settleFocus(added: added)
        }
    }

    /// What the "+" sheet started is over: the keyboard comes up if it was
    /// up before, or, for new work opened on the sheet, once something is
    /// in it. Either way it is owed no longer.
    private func settleFocus(added: Bool) {
        let focuses = keyboardOwed || (added && focusesAfterPick)
        keyboardOwed = false
        focusesAfterPick = false
        guard focuses, view.window != nil else { return }
        card.focus()
    }

    /// A pick from the model control or the "+" sheet's permission.
    private func choose(_ key: String) {
        let conversation = conversation
        StemCellModelPickers.choose(key, state: session.models, mode: mode) { [weak self] next in
            // Held here at once, so the chips read it before the conversation says so.
            self?.picked = next
            self?.updateChips()
            Task { await conversation.setMode(next) }
        }
    }

    private var planKey: StemCellChatPlanner.Key {
        StemCellChatPlanner.Key(width: view.bounds.width, maxContentWidth: ContentWidth.maxWidth, environment: traitCollection.textEnvironment, references: subagentReferences, subagentTitles: chat.subagentTitles)
    }

    /// Plans the rows off the main thread, then shows them in one frame.
    private func replan() {
        let key = planKey
        // Nothing is planned from history not yet read.
        guard key.width > 0, !reading(chat) else { return }
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
        let queued = Set(items.suffix(chat.queued).map(\.id))
        if let planned, planned.items == items, planned.key == key, planned.copied == copiedId, planned.opened == opened, planned.proposals == shown {
            // Only where the steering stands moved: the rows are the same.
            if planned.queued != queued, planning == nil {
                self.planned?.queued = queued
                plansQueued = queued
                view.setNeedsLayout()
            } else {
                self.planned?.queued = queued
            }
            return
        }
        planned = (items, key, copiedId, opened, shown, queued)
        planning?.cancel()
        // Rows as they stand untouched are shared with the warm chat: taken
        // from it as it laid them out ahead, and left with it for the next open.
        let untouched = !previewing && copiedId == nil && opened.isEmpty && shown.isEmpty
        if untouched, let ahead = warm?.chat.plans(for: items, key: key) {
            planning = nil
            shownProposals = shown
            plansQueued = queued
            return show(ahead)
        }
        let planner = planner
        let warmChat = untouched ? warm?.chat : nil
        planning = Task { [weak self] in
            let plans = await planner.plans(items, key: key, copied: copiedId, opened: opened, proposals: shown)
            guard !Task.isCancelled, let self else { return }
            self.planning = nil
            warmChat?.keep(plans, items: items, key: key)
            self.shownProposals = shown
            // The latest word on it, which may have moved while these were planned.
            self.plansQueued = self.planned?.queued ?? queued
            self.show(plans)
        }
    }

    private func show(_ plans: [ChatRowPlan]) {
        self.plans = plans
        planShown = true
        showIntro()
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
        timeShown()
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
        if firstFrame == nil {
            firstFrame = drawn
            scrollView.accessibilityIdentifier = "stem-transcript"
        }
        timeShown()
        header.safeTop = view.safeAreaInsets.top
        header.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: header.layout.scrim.height)
        let screen = StemCellChatScreenLayout(
            size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets),
            keyboardTop: fingerOnKeyboard ? keyboardTracker.frame.minY : keyboardTop
        ) { [card] width in card.height(fitting: width) }
        card.setLayoutFrame(screen.card)
        picker?.follow()
        let foot = StemCellChatFootLayout(size: view.bounds.size, card: screen.card)
        composerScrim.setLayoutFrame(foot.scrim)
        jump.setLayoutFrame(foot.jump)
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
        composerScrim.isHidden = true
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
        // Steering the turn hasn't taken waits under the working line, as
        // next in the queue, with room under it for the line that follows
        // it once taken (desktop's `conversationPendingSteering` and
        // `footerReserveHeight`): taking it up moves nothing else.
        let queuedIds = plansQueued
        let settled = plans.filter { !queuedIds.contains($0.id) }
        let waiting = plans.filter { queuedIds.contains($0.id) }
        heights += settled.map(\.size.height)
        heights.append(chat.activity == nil ? 0 : StemCellWorkingLayout.Metrics.height)
        heights += waiting.map(\.size.height)
        if !waiting.isEmpty { heights.append(StemCellWorkingLayout.Metrics.height) }
        // The intro stays under the bar, as desktop's leading header.
        let pins = introLayout != nil && !previewing
        let first = introLayout == nil ? 0 : 1
        func row(_ id: String) -> Int? {
            if let index = settled.firstIndex(where: { $0.id == id }) { return first + index }
            return waiting.firstIndex { $0.id == id }.map { first + settled.count + 1 + $0 }
        }
        func stacked() -> StemCellChatStackLayout {
            let held = lift.flatMap { lift in row(lift.id).map { StemCellChatStackLayout.Lift(row: $0, line: lift.line) } }
            return StemCellChatStackLayout(heights: heights, width: width, viewport: viewport, pinsFirst: pins, lift: held)
        }
        var stack = stacked()
        if let id = liftPending, let sent = row(id) {
            liftPending = nil
            // Where it lands following the end; lifted from there if below the line.
            let line = StemCellSendLift(viewport: viewport, introLine: introLayout?.line.maxY)
            if line.lifts(shownAt: stack.frames[sent].minY - max(0, stack.contentHeight - viewport)) {
                lift = (id, line.line)
            } else {
                lift = nil
            }
            stack = stacked()
        }
        if !stack.holding { lift = nil }
        rowsEnd = stack.frames.first?.minY == 0 ? stack.frames.last?.maxY : nil
        // The reserve under waiting steering is room, not content.
        let drawn = (waiting.isEmpty ? stack.frames : Array(stack.frames.dropLast())).filter { $0.height > 0 }
        contentSpan = (drawn.first?.minY ?? 0)...max(drawn.first?.minY ?? 0, drawn.last?.maxY ?? 0)
        if let introLayout {
            introView.setLayoutFrame(stack.frames[0])
            introView.place(introLayout)
        }
        // Steering taken up goes into the transcript above the line, moving
        // there as the line moves under it.
        let taken = !queuedShown.subtracting(queuedIds).isEmpty && view.window != nil
        queuedShown = queuedIds
        let place = {
            for plan in self.plans {
                if let index = row(plan.id) { self.rowViews[plan.id]?.setLayoutFrame(stack.frames[index]) }
            }
            self.working.frame = stack.frames[first + settled.count]
        }
        if taken {
            UIView.animate(withDuration: 0.25, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: place)
        } else {
            place()
        }
        let contentHeight = stack.contentHeight
        let previous = scrollView.contentSize.height
        scrollView.contentSize = CGSize(width: width, height: contentHeight)
        if jumping {
            if previous != contentHeight { scrollView.setContentOffset(CGPoint(x: 0, y: newestOffset), animated: true) }
        } else if followsNewest, previous != contentHeight || scrollView.contentOffset.y != newestOffset {
            scrollView.contentOffset.y = newestOffset
        } else if !followsNewest, scrollView.contentOffset.y > newestOffset, !scrollView.isTracking, !scrollView.isDecelerating {
            // Shorter than the place it was read at (a section folded): no gap under the end.
            scrollView.contentOffset.y = newestOffset
        }
        showNewestFromItsStart()
        updateJump()
        updateScrims()
    }

    /// The scrims at both edges come in as the transcript's content goes
    /// under them: its first line past the top of the list under the
    /// header, its last past the list's foot under the composer.
    private func updateScrims() {
        let top = scrollView.contentOffset.y + scrollView.contentInset.top
        let foot = scrollView.contentOffset.y + scrollView.bounds.height - scrollView.contentInset.bottom
        header.scrolledUnder = top - contentSpan.lowerBound
        // Its strength, never its alpha, which would turn its blur off.
        composerScrim.presence = HeaderScrim.presence(scrolledUnder: contentSpan.upperBound - foot)
    }

    /// The transcript is up: history read and its rows, if any, laid out.
    private var drawn: Bool { chat.loaded && (chat.items.isEmpty || planShown) }

    private var timed = false

    /// How long from the row's tap until the transcript was on screen, and
    /// whether the push's first frame had it: logged, and the transcript's
    /// value for the UI tests.
    private func timeShown() {
        guard !timed, let tappedAt, drawn, let firstFrame else { return }
        timed = true
        // Committed by the time the main queue comes back to this.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let ms = Int(((CACurrentMediaTime() - tappedAt) * 1000).rounded())
            let warm = StemCellsWarmChats.enabled ? "warm" : "off"
            #if DEBUG
            print("STEM_OPEN \(warm) first=\(firstFrame) ms=\(ms) rows=\(plans.count)")
            #endif
            scrollView.accessibilityValue = "first=\(firstFrame) ms=\(ms) rows=\(plans.count)"
        }
    }

    private var newestOffset: CGFloat {
        max(-scrollView.contentInset.top, scrollView.contentSize.height + scrollView.contentInset.bottom - scrollView.bounds.height)
    }

    /// The way back shows while the reader is more than a third of the
    /// list's height from the newest message, as desktop's does, and
    /// shimmers while the working line spins: not on a question to the
    /// person or a scheduled wait, which show still.
    private func updateJump() {
        let viewport = scrollView.bounds.height - scrollView.contentInset.top - scrollView.contentInset.bottom
        let away = !previewing && StemCellChatFootLayout.showsJump(distanceFromEnd: newestOffset - scrollView.contentOffset.y, viewport: viewport)
        // Hidden, it doesn't sweep.
        jump.working = away && StemCellChatJumpButton.spins(chat.activity)
        guard away != jumpShown else { return }
        jumpShown = away
        if away { jump.isHidden = false }
        UIView.animate(withDuration: 0.16, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
            self.jump.alpha = away ? 1 : 0
        } completion: { _ in
            // Shown again meanwhile, it stays.
            if !self.jumpShown { self.jump.isHidden = true }
        }
    }

    /// Back to the newest message, following it from there.
    @objc private func jumpToLatest() {
        followsNewest = true
        jumping = true
        scrollView.setContentOffset(CGPoint(x: 0, y: newestOffset), animated: true)
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
        kept = true
        card.setText("", selection: NSRange(location: 0, length: 0))
        StemCellsHaptics.play(.send)
        followsNewest = true
        // Mid-turn, a send waits under the reply at the end instead.
        let id = ClientID.make()
        liftPending = chat.working ? nil : id
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
            await conversation.send(id: id, text: text, pictures: photos)
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
        // Every picture of the conversation, swiped between in its order.
        var pictures = StemCellPicture.all(in: chat.items)
        if !pictures.contains(where: { $0.key == key }) {
            let presented = media.media(key)
            pictures = [StemCellPicture(key: key, thumbhash: presented?.item.thumbhash, label: presented?.item.name ?? Strings.StemCells.picture)]
        }
        let index = pictures.firstIndex { $0.key == key } ?? 0
        present(StemCellPictureViewController(source: media, pictures: pictures, index: index), animated: true)
    }

    /// A draft from elsewhere (the computer, the person's other device,
    /// what this phone kept) in the composer, the caret at its end; never
    /// over a word being composed.
    private func showDraft(_ text: String) {
        if let editor, editor.presentingViewController != nil {
            editor.show(text)
        }
        guard card.text != text, !card.hasMarkedText else { return }
        showingDraft = true
        card.setText(text, selection: NSRange(location: (text as NSString).length, length: 0), animatesHeight: false)
        showingDraft = false
        updatePrimary()
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
        guard !showingDraft else { return }
        draftEdited(card.text)
    }

    /// The draft, as typed here or full screen: kept and saved once the
    /// keystrokes pause.
    private func draftEdited(_ text: String) {
        guard !previewing else { return }
        let at = max((Date().timeIntervalSince1970 * 1000).rounded(), lastDraftEdit + 1)
        lastDraftEdit = at
        let conversation = conversation
        Task { await conversation.setDraft(text, at: at) }
    }

    /// The text full screen, the caret where it was; collapsed, it comes
    /// back to the card as it was left there.
    func agentInputCardDidPressExpand(_ card: AgentInputCardView) {
        guard presentedViewController == nil else { return }
        let editor = ComposerEditorViewController(
            text: card.text,
            selection: card.selectedRange,
            keyboardTop: keyboardTop < view.bounds.maxY ? view.convert(CGPoint(x: 0, y: keyboardTop), to: nil).y : nil
        )
        editor.onChange = { [weak self] text in self?.draftEdited(text) }
        editor.onClose = { [weak self] text, selection, focused in
            guard let self else { return }
            self.showingDraft = true
            self.card.setText(text, selection: selection, animatesHeight: false)
            self.showingDraft = false
            self.updatePrimary()
            // Taken before the editor goes, so the keyboard stays up.
            if focused { self.card.focus() }
        }
        self.editor = editor
        present(editor, animated: true)
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

    /// The add button opens the "+" sheet: photos, the clipboard, files
    /// and the permission the next message runs with.
    func agentInputCardDidPressAdd(_ card: AgentInputCardView) {
        presentAttach(from: self)
    }

    func agentInputCard(_ card: AgentInputCardView, didRemoveAttachment id: String) { pictures.remove(id: id) }

    func agentInputCard(_ card: AgentInputCardView, didSelect key: String, in chip: AgentInputChip) {
        choose(key)
    }

    /// A chip opens its list; with no models yet, they are asked for again.
    func agentInputCard(_ card: AgentInputCardView, didPress chip: AgentInputChip) {
        guard let menus, !reading(chat) || picked != nil else { return session.models.load() }
        picker?.close(animated: false)
        let picker = StemCellPickerPresenter(list: chip == .effort ? .effort : .model, card: card, menus: menus, usage: session.models.usage) { [weak self] key in
            self?.choose(key)
        }
        picker.onClose = { [weak self, weak picker] in
            if let self, self.picker === picker { self.picker = nil }
        }
        // Under the header's row, which the safe area doesn't know of.
        picker.top = { [weak self] in self?.header.layout.listTop ?? 0 }
        self.picker = picker
        picker.show(in: view)
        StemCellModelPickers.opened(session.models, mode: mode)
    }

    func agentInputCard(_ card: AgentInputCardView, didOpenMenuIn chip: AgentInputChip) {
        StemCellModelPickers.opened(session.models, mode: mode)
    }

    func agentInputCardDidPressStop(_ card: AgentInputCardView) {
        let conversation = conversation
        Task { await conversation.abort() }
    }
}

extension StemCellChatViewController: UIImagePickerControllerDelegate, UINavigationControllerDelegate, UIDocumentPickerDelegate {
    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        let image = info[.originalImage] as? UIImage
        picker.dismiss(animated: true)
        guard let data = image?.jpegData(compressionQuality: 0.9) else { return settleFocus(added: false) }
        pictures.add(pictures: [data])
        settleFocus(added: true)
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        settleFocus(added: false)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        settleFocus(added: false)
    }

    /// Files' copies, pictures among them read as pictures, off the main thread.
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let room = max(1, ComposerAttachmentRules.remaining(selected: pictures.images.count))
        for extra in urls.dropFirst(room) { try? FileManager.default.removeItem(at: extra) }
        let urls = Array(urls.prefix(room))
        Task { [weak self] in
            let picks = await Task.detached(priority: .userInitiated) { urls.compactMap { LibraryPicker.document($0, videos: false) } }.value
            guard let self else { return LibraryPicker.discard(picks) }
            take(picks)
        }
    }
}

extension StemCellChatViewController: NavigationTransitionProviding {
    func navigationTransition(_ operation: UINavigationController.Operation, other: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        guard opensOverHome, let home = other as? StemCellsDockHosting else { return nil }
        return StemCellsNewWorkTransition(operation, chat: self, home: home, interaction: operation == .pop ? swipeHome : nil)
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
    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        fingerOnKeyboard = true
        jumping = false
    }

    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
        jumping = false
        view.setNeedsLayout()
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        // No keyboard up, or one the finger never moved: nothing will say where it went.
        if !card.textView.isFirstResponder || abs(keyboardTracker.frame.minY - min(keyboardTop, view.bounds.maxY)) < 1 { fingerOnKeyboard = false }
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        updateJump()
        updateScrims()
        guard scrollView.isTracking || scrollView.isDecelerating else { return }
        followsNewest = scrollView.contentOffset.y >= newestOffset - 24
        // Read away from the end: room held under it, wholly out of view, goes.
        if !followsNewest, lift != nil, let rowsEnd, scrollView.contentOffset.y + scrollView.bounds.height - scrollView.contentInset.bottom <= rowsEnd {
            lift = nil
            view.setNeedsLayout()
        }
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
