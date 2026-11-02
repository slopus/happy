#if canImport(UIKit)
import AVKit
import HappyCore
import HappyLayout
import QuickLook
import UIKit
import UniformTypeIdentifiers

/// One V2 conversation, simplified from desktop's: the work's
/// intro at the top (the clay icon it was given, over
/// "Say what it is — it’ll find its place."), what the person wrote and
/// what the agent said with the pictures and recordings it presented, and
/// a composer that sends photos too. Tool calls are never shown.
///
/// New work opens here before the daemon has made it: what it will be (Task
/// or Bot, and a name) in the middle (`NewWorkPanel`) and the composer with
/// the keyboard, up as the screen comes in; a first message makes it and
/// waits for it to exist.
///
/// Previewing, it is what a hold on the row shows over the sidebar, as
/// Telegram previews a chat: the newest messages under the name in a
/// capsule, nothing to type in or tap, and nothing marked read.
final class ChatViewController: UIViewController, ComposeHosting, KeyboardPushed {
    typealias Intro = IntroView.Mark

    private let session: Session
    private let conversation: Conversation
    /// A conversation read ahead (`WarmChats`), held while this
    /// screen shows it; nil for new work, which has its own.
    private let warm: (chat: WarmChats.Chat, token: UUID)?
    /// When its row was tapped, to time how soon it showed.
    private let tappedAt: CFTimeInterval?
    /// What the push's first frame had: the transcript, or nothing yet.
    private var firstFrame: Bool?
    private let spaceId: String?
    private let opensFocused: Bool
    /// New work brings the keyboard up as it opens, unless it opens on the "+" sheet.
    var focusesOnOpen = true
    /// Opened on the "+" sheet: the first thing added brings the keyboard up, once.
    var focusesAfterPick = false
    /// The keyboard new work opens with, not yet asked for.
    private var focusPending = false
    /// The ask a screen opened this conversation with (Settings' rename
    /// and avatar), put in the composer unsent once the draft it already
    /// had has arrived.
    private let prefill: ChatPrefill?
    /// The ask has been put in: it goes in once, however many drafts
    /// arrive afterwards.
    private var prefilled = false
    /// A new task on its way to the screen from this one's compose.
    private var composing = false
    private let previewing: Bool
    private let previewPill = GlassCapsuleView()
    /// The card's ground over the messages above the list, fading out under the capsule.
    private let previewFade = PreviewFadeView()
    private let previewTitle = UILabel()
    private var intro: Intro?
    private let planner: ChatPlanner
    private let media: MediaLoader
    private let pictures: ComposerImagePicker
    private var acceptingSend = false

    /// The transcript, on UltraList: the rows the library keeps near the
    /// screen, each drawn from its plan. A preview reads it too, from the
    /// start of the newest message.
    private let ultra = AgentChatUltraList()
    private lazy var transcriptHeaderScrim = HeaderScrimView()
    private let introView = IntroView()
    /// New work's Task or Bot and name, until its first message shows.
    private let newWorkPanel: NewWorkPanel?
    /// The panel has gone, or is going, for good.
    private var newWorkPanelGone = false
    /// The proposal cards each row on screen hosts.
    private var rowCards: [String: Set<String>] = [:]
    private(set) var plans: [ChatRowPlan] = []
    private var plansById: [String: ChatRowPlan] = [:]
    /// The composer's scrim, in its frame and always there: one that came
    /// and went with the content under it flashed as a short transcript
    /// bounced off its top.
    private let composerScrim = HeaderScrimView(edge: .bottom)
    /// Desktop's way back to the newest message.
    private let jump = ChatJumpButton()
    private var jumpShown = false
    let card = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: Strings.Composer.inputPlaceholder))
    /// How much of the context window the conversation has spent, under
    /// the card at its far end, as desktop's under its composer.
    let meter = ContextMeterView()
    /// What it shows; nil hides its row.
    private(set) var gauge: AgentContextGauge?
    private let keyboardTracker = UIView()
    /// The keyboard's top as its notifications last said (down: past any
    /// screen), which the composer rides on the keyboard's own curve. The
    /// guide (`keyboardTracker`) moves a layout pass ahead of them, so it
    /// is followed only while a finger may be dragging the keyboard down:
    /// from a drag's start until they say where it went.
    private var keyboardTop = CGFloat.greatestFiniteMagnitude
    private var fingerOnKeyboard = false
    /// The keyboard as the transcript's list has it while the screen is
    /// shown (`ChatUltraKeyboard`, as the sessions' chat has): a finger
    /// dragging the transcript down carries it, and every show and hide
    /// moves the list's inset on the keyboard's spring, which the card and
    /// what rides it follow. None in a preview.
    private(set) var ultraKeyboard: ChatUltraKeyboard?

    private var chat = ChatSnapshot()
    private var following: Task<Void, Never>?
    private var planning: Task<Void, Never>?
    private var planned: (items: [ChatItem], key: ChatPlanner.Key, copied: String?, opened: Set<String>, proposals: [String: ProposalShown], queued: Set<String>)?
    /// The steering waiting under the working line, as of the plans on
    /// screen: read with them, never with a snapshot they don't show yet.
    private var plansQueued = Set<String>()
    /// Other agents' messages, and the person's long ones, opened to read,
    /// for this screen's life.
    private var opened = Set<String>()
    /// Finished turns opened on their work ("View traces"), by run, for
    /// this screen's life: every other finished turn is folded.
    private var expandedTurns = Set<String>()
    /// A turn was opened or folded: the next apply moves rows in place,
    /// the rows the reader sees staying where they are.
    private var foldMoved = false
    /// Each waiting question's ticked options, by question and prompt.
    private var picks: [String: [String: [String]]] = [:]
    /// The sidebar proposals the transcript shows, and their cards by row.
    private let proposals: SidebarProposals
    private var proposalViews: [String: SidebarProposalView] = [:]
    /// The proposals as the rows on screen were planned with them.
    private var shownProposals: [String: ProposalShown] = [:]
    private var sidebarRows: [Row] = []
    /// What the references messages make read as and open.
    private var references = References()
    /// The messages' words looked through for references not read yet, by
    /// item, and what references read as then.
    private var scanned = (references: References(), texts: [String: String]())
    /// Inline pages' heights as they measured themselves.
    private var pageHeights: [String: CGFloat] = [:]
    /// The references with this conversation's own subagents, which the
    /// sidebar's lists never hold.
    private var subagentReferences: References {
        var known = references
        known.subagents = chat.subagentTitles
        return known
    }
    private var watch: Watch?
    private var modelsWatch: Watch?
    /// Holds the accounts' readings followed while this screen shows.
    private var usageWatch: Watch?
    private var headerWatch: Watch?
    private var headerState: Strings.HeaderStatus.State = .connecting
    private var copied: (id: String, until: Task<Void, Never>)?
    /// The newest row is in view: what arrives keeps it there.
    private var followsNewest = true {
        didSet {
            if followsNewest != oldValue {
                tellReadsNewest(moving: ultra.list.isTracking || ultra.list.isDecelerating)
            }
        }
    }
    /// What the conversation was last told by `tellReadsNewest`.
    private var toldReadsNewest: Bool?
    /// The steering last drawn under the working line.
    private var queuedShown = Set<String>()
    /// The composer's text full screen, while it is up.
    private weak var editor: ComposerEditorViewController?
    /// The draft arrivals set here so far (`LegacyChatSnapshot.draftArrivals`);
    /// none yet, so the first snapshot's draft shows, however a conversation
    /// read ahead came by it.
    private var draftArrivals = -1
    /// Set while a draft from elsewhere goes into the composer: not typing.
    private var showingDraft = false
    /// The last keystroke's stamp, never going back.
    private var lastDraftEdit: Double = 0
    #if DEBUG
    private var probe: ScrollProbe?
    private var composeTrace: ComposeTrace?
    #endif
    /// The computer was reachable when last heard: pictures that failed
    /// while it wasn't are asked for again when it is back.
    private var live = true
    private var preview: FilePreview?
    /// The title in the navigation bar: the name, and the agent's status,
    /// on a glass capsule between the bar's own glass buttons.
    private let header = ChatHeaderView()
    private var titleView: ChatTitleView { header.titleView }

    init(session: Session, agentId: String, title: String, spaceId: String?, intro: Intro?, newTask: NewTask? = nil, prefill: ChatPrefill? = nil, previewing: Bool = false) {
        self.session = session
        self.spaceId = spaceId
        self.intro = intro
        self.previewing = previewing
        self.prefill = previewing ? nil : prefill
        self.newTask = newTask
        newWorkPanel = newTask == nil || previewing ? nil : NewWorkPanel(mode: .work)
        opensFocused = newTask != nil
        // An ask typed in for the person brings the keyboard up too, so
        // they only have to finish the sentence.
        focusPending = newTask != nil || (prefill != nil && !previewing)
        if newTask == nil {
            let held = session.warm.hold(agentId)
            warm = held
            conversation = held.chat.conversation
            // A preview lays out at its card's width: its own planner, so
            // the full width's rows stay cached.
            planner = previewing ? ChatPlanner(syntax: session.syntax) : held.chat.planner
        } else {
            warm = nil
            conversation = Conversation(client: session.client, store: session.store, agentId: agentId, newTask: newTask, mode: session.models.newWorkMode, persistence: session.engine)
            planner = ChatPlanner(syntax: session.syntax)
        }
        tappedAt = previewing ? nil : session.warm.takeTap(agentId)
        proposals = SidebarProposals(client: session.client, store: session.store)
        media = MediaLoader(client: session.client, agentId: agentId, library: session.media)
        let files = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("Agents", isDirectory: true)
        pictures = ComposerImagePicker(staging: ComposerAttachmentStaging(filesDirectory: files), maxFileBytes: AttachmentRules.maxFileBytes)
        super.init(nibName: nil, bundle: nil)
        self.title = title
        titleView.text = title
        header.resize()
        navigationItem.titleView = header
        navigationItem.largeTitleDisplayMode = .never
        // A new task's media is under the ID the computer gives it, once
        // its first message has made it; from then on its row on home
        // names this screen, as the task names itself.
        if let newTask {
            creating = true
            made = Task { [weak self, engine = session.engine] in
                guard let id = try? await newTask.made() else { return }
                self?.media.agentId = id
                self?.creating = false
                for await home in await engine.snapshots() {
                    guard let self, !Task.isCancelled else { return }
                    guard let row = home.allRows.first(where: { $0.agentId == id && $0.depth == 0 }) else { continue }
                    rowName = (row.label, true)
                    applyTitle()
                }
            }
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.surface)
        introView.accessibilityIdentifier = "intro"
        ultra.host = self
        ultra.onReachedOldest = { [weak self] in self?.loadOlder() }
        view.addSubview(ultra)
        if !previewing {
            // The header's own edge: the ground at the top, easing out
            // through the bar's foot (`HeaderScrim`).
            transcriptHeaderScrim.presence = 0
            view.addSubview(transcriptHeaderScrim)
        }
        // Back, the title, and Compose alone, a glass circle as Back is:
        // the permission mode is on the detail the title opens. New work
        // has Back alone until its first send.
        showHeader(animated: false)
        card.configuration.showsAdd = true
        card.configuration.showsExpand = true
        card.configuration.addAccessibilityLabel = Strings.addPicture
        card.delegate = self
        card.textView.accessibilityIdentifier = "composer"
        card.accessibilityIdentifier = "input"
        // A long press's Paste attaches a copied picture.
        card.textView.onPasteAttachment = { [weak self] in self?.pictures.paste() }
        pictures.host = { [weak self] in self }
        pictures.onChange = { [weak self] in
            guard let self else { return }
            card.configuration.attachments = pictures.images.map {
                AgentInputAttachmentPreview(id: $0.id, fileURL: $0.attachment.fileURL, name: $0.attachment.name, mimeType: $0.attachment.mimeType)
            }
            updatePrimary()
        }
        if let newWorkPanel, let newTask {
            newWorkPanel.choice = newTask.choice
            newWorkPanel.onChange = { [newTask] choice in newTask.choice = choice }
            newWorkPanel.onReturn = { [weak self] in self?.card.focus() }
            view.addSubview(newWorkPanel)
        }
        view.addSubview(composerScrim)
        jump.isHidden = true
        jump.alpha = 0
        jump.addTarget(self, action: #selector(jumpToLatest), for: .touchUpInside)
        view.addSubview(jump)
        view.addSubview(card)
        meter.isHidden = true
        view.addSubview(meter)
        header.onOpen = { [weak self] in self?.openDetail() }

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
        // Made after the screen's own observer, so a notification has set
        // where the keyboard rests before the list's keyboard moves.
        if !previewing {
            ultraKeyboard = ChatUltraKeyboard(
                list: ultra.list, view: view,
                accessoryHeight: { [weak self] in self?.heightAboveKeyboard ?? 0 },
                hasInput: { [weak self] in self?.ownsKeyboard ?? false },
                changed: { [weak self] change in self?.followUltraKeyboard(change) }
            )
        }

        // The rows hear their own taps and presses; this one only ends a
        // rename.
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.cancelsTouchesInView = false
        ultra.addGestureRecognizer(tap)

        if previewing { setUpPreview() }
        #if DEBUG
        if !previewing, let mode = ProcessInfo.processInfo.environment["HAPPY_CHAT_PROBE"] { probe = ScrollProbe(self, relayout: mode == "relayout") }
        if !previewing, newTask != nil, ComposeTrace.isOn { composeTrace = ComposeTrace(self) }
        #endif
        applyIntro()
        proposals.onChange = { [weak self] in self?.replan() }
        watch = session.watch { [weak self] snapshot in self?.follow(snapshot) }
        headerWatch = session.watchHeader { [weak self] state in
            guard let self else { return }
            headerState = state
            updateHeaderStatus()
        }
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
        // A failure card names the models it offers from the catalog.
        modelsWatch = session.models.watch { [weak self] in self?.updateChips(); self?.replan() }
        session.models.load()
        updateChips()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        header.ride(transitionCoordinator, appearing: true)
        // A preview is only looked at: what it shows stays unread.
        if previewing { return }
        #if DEBUG
        composeTrace?.event("willAppear window=\(view.window != nil)")
        #endif
        // What the keyboard did while another screen was over this one
        // went unheard: down, unless it is still this composer's.
        fingerOnKeyboard = false
        if !ownsKeyboard { keyboardTop = .greatestFiniteMagnitude }
        ultraKeyboard?.activate()
        // Back from a screen over this one, or a swipe back let go of.
        updateBar(animated: animated)
        let conversation = conversation
        Task { await conversation.setVisible(true) }
        // The model chip warns as its account runs low, so the readings are
        // followed while the composer shows.
        if usageWatch == nil { usageWatch = session.models.followUsage() }
        toldReadsNewest = nil
        tellReadsNewest(moving: false)
    }

    /// In the window as the push starts: new work's keyboard comes up with
    /// the push, as Messages' compose does, not after it.
    override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        if previewing { return }
        #if DEBUG
        composeTrace?.event("isAppearing window=\(view.window != nil)")
        #endif
        // Pushed with the keyboard already coming (`KeyboardPush`), the
        // composer takes it once the push is over, not inside it.
        if !keyboardPushed { takeOpeningFocus() }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        #if DEBUG
        composeTrace?.appeared()
        #endif
        // In its window now, which a later layout may not follow.
        ultraKeyboard?.refresh()
        guard !previewing, let navigationController else { return }
        _ = navigationController
        // New work: the keyboard comes up now if it couldn't with the push,
        // or the composer takes it from the push's stand-in.
        takeOpeningFocus()
        keyboardPushed = false
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        header.ride(transitionCoordinator, appearing: false)
        MessageLiftOverlay.putBack(from: self)
        #if DEBUG
        probe?.observePop()
        composeTrace?.event("willDisappear interactive=\(transitionCoordinator?.isInteractive == true)")
        #endif
        // A finger or a release holding the keyboard lets it go at once.
        if ultraKeyboard?.isDriving == true { ultraKeyboard?.dismissImmediately() }
        // Leaving keeps a name being typed, as a tap away does.
        titleView.finishEditing()
        picker?.close(animated: false)
        giveBarBack(animated: animated)
        if !previewing {
            let conversation = conversation
            Task { await conversation.flushDraft() }
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        #if DEBUG
        composeTrace?.event("didDisappear")
        if isMovingFromParent || navigationController == nil { composeTrace?.stop() }
        #endif
        let conversation = conversation
        Task { await conversation.setVisible(false) }
        usageWatch?.invalidate()
        usageWatch = nil
        // Covered or gone: the keyboard isn't this screen's to follow, and
        // nothing its motion carried keeps moving.
        if let keyboard = ultraKeyboard, keyboard.isActive {
            keyboard.deactivate()
            landKeyboardRiders()
        }
        if isMovingFromParent || navigationController == nil {
            ultraKeyboard?.invalidate()
            ultraKeyboard = nil
            following?.cancel()
            made?.cancel()
            #if DEBUG
            probe?.link.invalidate()
            #endif
            planning?.cancel()
            watch?.invalidate()
            modelsWatch?.invalidate()
            headerWatch?.invalidate()
            proposals.stop()
            // The list lets go of its rows, and of this screen with them.
            ultra.deactivate()
            // Read ahead, it stays read for a quick way back.
            if let warm {
                session.warm.release(warm.chat, token: warm.token, opened: !previewing)
            } else {
                Task { await conversation.stop() }
            }
        }
    }

    // MARK: Detail

    /// The conversation shown: empty for new work until the daemon made it.
    var shownAgentId: String { media.agentId }

    /// The conversation's detail, over it: its numbers, its family and its
    /// activity, and its rename. New work has none until the daemon made it.
    private func openDetail() {
        guard !previewing, !creating, !media.agentId.isEmpty else { return }
        let agentId = media.agentId
        card.blur()
        let detail = SessionDetailViewController(session: session, agentId: agentId, title: title ?? "", spaceId: spaceId)
        detail.permissionChoice = { [weak self] in self?.permissionChoice }
        navigationController?.pushViewController(detail, animated: true)
    }

    // MARK: Keyboard

    /// The transcript follows the layout guide while the finger can move
    /// the keyboard, until its next frame notification takes over.
    private func beginKeyboardDrag() {
        fingerOnKeyboard = true
        tellReadsNewest(moving: true)
    }

    private func endKeyboardDrag() {
        // A drag that never moved the keyboard receives no frame notification.
        if !ownsKeyboard || abs(keyboardTracker.frame.minY - min(keyboardTop, view.bounds.maxY)) < 1 {
            fingerOnKeyboard = false
        }
    }

    /// The composer goes with the keyboard: to the same place, in the same
    /// time, on the same curve.
    @objc private func keyboardWillChange(_ note: Notification) {
        guard !previewing, let screen = view.window?.screen,
              let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
        let curve = (note.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?.uintValue ?? 7
        let local = view.convert(end, from: screen.coordinateSpace)
        // An undocked keyboard (an iPad's floating or split one) covers
        // nothing, as the layout guide reads it with
        // `followsUndockedKeyboard` off.
        let docked = local.maxY >= view.bounds.maxY - 1
        let top = !docked || local.minY >= view.bounds.maxY || local.isEmpty ? CGFloat.greatestFiniteMagnitude : local.minY
        keyboardTop = top
        fingerOnKeyboard = false
        guard duration > 0 else {
            updateBar(animated: false)
            return view.setNeedsLayout()
        }
        if ultraKeyboard?.isActive == true {
            // The list's keyboard hears this next and lays the screen out
            // on its own motion (`followUltraKeyboard`). Sideways, the bar
            // goes or comes back in the keyboard's time.
            UIView.animate(withDuration: duration, delay: 0, options: [UIView.AnimationOptions(rawValue: curve << 16), .beginFromCurrentState, .allowUserInteraction]) {
                self.updateBar(animated: false)
            }
            return
        }
        // UltraList moves only on its own transitions, never inside a UIView
        // animation: the transcript's inset goes on the keyboard's spring,
        // started in the same transaction as the card's, so the newest row
        // rides the card. Rows a finger or a fling holds stay where they are.
        let list = ultra.list
        let held = list.isTracking || list.isDragging || list.isDecelerating
        insetMotion = ChatUltraKeyboard.Change(transition: .keyboard(duration), compensates: !held)
        defer { insetMotion = nil }
        UIView.animate(withDuration: duration, delay: 0, options: [UIView.AnimationOptions(rawValue: curve << 16), .beginFromCurrentState, .allowUserInteraction]) {
            // The bar goes or comes back in the keyboard's time, so the
            // transcript moves once.
            self.updateBar(animated: false)
            self.view.setNeedsLayout()
            self.view.layoutIfNeeded()
        }
    }

    /// The move the screen is being laid out in (the keyboard's, the card
    /// growing): the transcript takes its inset on it, so its rows go with
    /// the card. UltraList never moves inside a UIView animation.
    private var insetMotion: ChatUltraKeyboard.Change?

    /// The inset's move for a layout inside a UIView animation of
    /// `duration` on its default curve. Rows a finger or a fling holds stay
    /// where they are.
    private func insetMotion(easingIn duration: TimeInterval) -> ChatUltraKeyboard.Change {
        let list = ultra.list
        return ChatUltraKeyboard.Change(transition: .easeInOut(duration), compensates: !(list.isTracking || list.isDragging || list.isDecelerating))
    }

    /// How far above the keyboard's top the card reaches, the gap under it
    /// included: what UltraView's keyboard controller carries on the
    /// keyboard as a finger drags it.
    private var heightAboveKeyboard: CGFloat {
        max(0, view.bounds.maxY - (ultraKeyboard?.height ?? 0) - card.frame.minY)
    }

    /// What rides the keyboard: placed from its top, so carried with it.
    private var keyboardRiders: [UIView] { [card, meter, jump, composerScrim] + (newWorkPanel.map { [$0] } ?? []) }

    /// The list's keyboard moved: the screen takes its new layout at once,
    /// the list's inset moving on `change`, and what rides the keyboard is
    /// carried there from where it is drawn now, on the motion the inset
    /// just started (UltraView's `applyViewportMotion`), as the sessions'
    /// chat carries its dock. The scrim reaches from the card to the
    /// bottom, so its height moves too.
    private func followUltraKeyboard(_ change: ChatUltraKeyboard.Change) {
        guard isViewLoaded, view.window != nil else { return }
        let list = ultra.list
        let riders = keyboardRiders
        let drawn = riders.map { $0.layer.presentation()?.frame ?? $0.frame }
        let scrimHeight = composerScrim.layer.presentation()?.bounds.height ?? composerScrim.bounds.height
        let insets = list.viewportInsets
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        insetMotion = change
        UIView.performWithoutAnimation {
            view.setNeedsLayout()
            view.layoutIfNeeded()
        }
        insetMotion = nil
        let moved = list.viewportInsets != insets
        if moved || change.finishes {
            for (rider, old) in zip(riders, drawn) {
                list.applyViewportMotion(to: rider.layer, keyPath: "position.y", displacement: moved ? Double(old.midY - rider.frame.midY) : 0)
            }
            list.applyViewportMotion(to: composerScrim.layer, keyPath: "bounds.size.height", displacement: moved ? Double(scrimHeight - composerScrim.bounds.height) : 0)
        }
        CATransaction.commit()
    }

    /// The screen has gone or the keyboard is done with: nothing the list's
    /// motion carried keeps moving.
    private func landKeyboardRiders() {
        let list = ultra.list
        for rider in keyboardRiders { list.applyViewportMotion(to: rider.layer, keyPath: "position.y", displacement: 0) }
        list.applyViewportMotion(to: composerScrim.layer, keyPath: "bounds.size.height", displacement: 0)
    }

    // MARK: The bar sideways

    /// The safe area's top as it is with the bar showing, kept while this
    /// screen hides it: what the card's shape is decided against, so
    /// hiding the bar can't change the shape that hid it.
    private var barSafeTop: CGFloat?

    /// The card's shape for where the keyboard rests (never the finger
    /// dragging it), from the full card with one line.
    private var compacts: Bool {
        var safeArea = LayoutInsets(view.safeAreaInsets)
        if let barSafeTop { safeArea.top = barSafeTop }
        return ChatScreenLayout.compacts(size: view.bounds.size, safeArea: safeArea, keyboardTop: keyboardTop, meter: gauge != nil, maxContentWidth: ContentWidth.maxWidth) { [card] width in
            card.restingHeight(fitting: width)
        }
    }

    /// Steve's OK, in the conversation of 2026-10-30 (AGENTS.md rule 9):
    /// a phone held sideways with the keyboard up and the card compact
    /// hides the navigation bar, which gives the transcript its room back.
    /// It comes back as the keyboard goes down, the phone turns upright,
    /// or another screen comes over this one or back from it. The bar is
    /// the standard one, only hidden; the swipe back stays
    /// (`PopGestureDelegate`), and the status bar is the system's.
    private func updateBar(animated: Bool) {
        guard !previewing, let navigationController, navigationController.topViewController === self else { return }
        let hides = ChatScreenLayout.hidesBar(
            compact: compacts,
            sideways: traitCollection.verticalSizeClass == .compact && traitCollection.userInterfaceIdiom == .phone,
            keyboardUp: keyboardTop < view.bounds.maxY
        )
        guard hides != navigationController.isNavigationBarHidden else { return }
        if hides { barSafeTop = view.safeAreaInsets.top }
        navigationController.setNavigationBarHidden(hides, animated: animated)
        if !hides { barSafeTop = nil }
    }

    /// The screen under (or over) this one keeps its bar.
    private func giveBarBack(animated: Bool) {
        guard barSafeTop != nil else { return }
        barSafeTop = nil
        guard let navigationController, navigationController.isNavigationBarHidden else { return }
        navigationController.setNavigationBarHidden(false, animated: animated)
    }

    override func viewWillTransition(to size: CGSize, with coordinator: any UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        // Turning upright with the keyboard up: the bar is back with the turn.
        coordinator.animate(alongsideTransition: { [weak self] _ in self?.updateBar(animated: false) }) { [weak self] _ in
            self?.updateBar(animated: false)
        }
    }

    // MARK: New work

    /// The keyboard new work opens with: asked for once, as the screen comes
    /// in. The composer takes it, as desktop's does; the name is a tap away.
    /// Off screen still, it waits for the screen.
    func takeOpeningFocus() {
        guard focusPending, view.window != nil else { return }
        focusPending = false
        guard focusesOnOpen else { return }
        card.focus()
        #if DEBUG
        composeTrace?.event("focus composer=\(card.textView.isFirstResponder)")
        #endif
    }

    /// Pushed by `KeyboardPush`: the keyboard comes up with the push, held
    /// by a stand-in until the push is over.
    private var keyboardPushed = false

    func keyboardPushWillStart(keyboardUp: Bool) {
        keyboardPushed = true
        // Laid out with the keyboard down; its notification, heard once
        // the screen is in the window, carries the card up with it.
        if !keyboardUp { ultraKeyboard?.startsDown = true }
    }

    /// Already heard: this screen's observers come after the push's.
    func keyboardPushStarted(_ keyboard: Notification) {}

    /// The keyboard is this screen's: the composer's or the name's.
    private var ownsKeyboard: Bool {
        card.textView.isFirstResponder || newWorkPanel?.name.isFirstResponder == true
    }

    /// The panel centred between the bar's foot and the card's top, so it
    /// moves with the card, in the same animation, as the keyboard comes
    /// and goes.
    private func layoutNewWorkPanel(above card: CGRect) {
        guard let newWorkPanel, !newWorkPanelGone else { return }
        let layout = newWorkPanel.layout(width: view.bounds.width, top: view.safeAreaInsets.top, bottom: card.minY)
        newWorkPanel.place(layout)
        newWorkPanel.isHidden = !layout.fits
    }

    /// The first message is in: the panel fades, and the conversation is
    /// an ordinary one. The keyboard, wherever it was, stays up in the
    /// composer.
    private func dismissNewWorkPanel() {
        guard let newWorkPanel, !newWorkPanelGone else { return }
        newWorkPanelGone = true
        // The composer takes the keyboard before the name is shut, so it
        // never goes down in between.
        if newWorkPanel.name.isFirstResponder { card.focus() }
        newWorkPanel.dismiss()
        showHeader(animated: true)
    }

    /// Compose, at the bar's right.
    private lazy var composeItems = HeaderBar.trailing([
        .compose: HeaderBar.composeItem { [weak self] in self?.compose() },
    ])

    /// New work's header is Back alone until its first send
    /// (`ConversationHeader`); every other conversation's has its name and
    /// Compose.
    private func showHeader(animated: Bool) {
        ConversationHeader.show(newTask == nil || newWorkPanelGone, title: header, items: composeItems, on: navigationItem, animated: animated)
    }

    /// Nothing typed or picked.
    var composerIsEmpty: Bool { card.text.isEmpty && pictures.images.isEmpty }

    /// The bar's compose: a new task in this conversation's place, so Back
    /// still leads home and the stack grows no deeper. Nothing is made
    /// until its first message; when the task compose opens is this one,
    /// it only takes the keyboard. What is typed here stays in its draft.
    func compose() {
        guard !previewing, !composing, let navigationController, navigationController.topViewController === self else { return }
        composing = true
        let store = session.store
        let session = session
        Task { @MainActor in
            defer { composing = false }
            let task = await store.newTask()
            guard self.navigationController?.topViewController === self else { return }
            Haptics.play(.newWork)
            if task === newTask {
                card.focus()
                return
            }
            // The keyboard, up or not, goes to the new screen with its push.
            ComposeNavigation.replace(self, with: NewWork.chat(session, task: task), traits: card.textView, keyboardUp: ownsKeyboard)
        }
    }

    // MARK: State

    /// The row's name and mark as the sidebar has them: Prioritizing's name
    /// lands here too, and so does the clay icon it chose.
    private func follow(_ snapshot: Snapshot) {
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
        guard let spaceId, let row = snapshot.allRows.first(where: { $0.spaceId == spaceId }) else { return }
        rowName = (row.label, row.titled)
        applyTitle()
        let next: Intro? = switch row.mark {
        case .clay(let slug): .clay(slug)
        default: intro
        }
        if next != intro {
            intro = next
            applyIntro()
        }
    }

    /// The row's name as the sidebar has it, and whether it is one of its own.
    private var rowName: (label: String, titled: Bool)?

    /// The row's name, or, while it has none ("New"), the conversation's
    /// own title once the daemon has written one, as desktop's header reads it.
    private func applyTitle() {
        guard let rowName else { return }
        let label = rowName.titled ? rowName.label : chat.title.flatMap { $0.isEmpty ? nil : $0 } ?? rowName.label
        if title != label { title = label }
        if titleView.text != label { titleView.text = label; header.resize() }
        if previewing, previewTitle.text != label {
            previewTitle.text = label
            previewPill.accessibilityLabel = label
            view.setNeedsLayout()
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

    /// A task its first message makes, which hasn't been sent yet: it has
    /// no detail to open.
    private var creating = false
    /// The task this conversation's first message makes, when it is one.
    private let newTask: NewTask?
    /// Waits for it to be made, then names this screen after its row.
    private var made: Task<Void, Never>?

    /// A plan has been shown, if only an empty one.
    private var planShown = false

    /// History still being read: nothing shows yet, not the intro alone
    /// where an empty conversation has it, nor the computer's default model.
    /// New work has none to read.
    private func reading(_ chat: ChatSnapshot) -> Bool { !chat.loaded && !opensFocused }

    /// The intro's "say what it is" line is for work with nothing in it yet.
    private func settled(_ chat: ChatSnapshot) -> Bool { reading(chat) || !chat.items.isEmpty }

    private func apply(_ snapshot: ChatSnapshot) {
        // A new measurement alone, as each turn streams: only the meter moves.
        var measured = chat
        measured.context = snapshot.context
        if snapshot.context != chat.context, measured == snapshot {
            chat = snapshot
            return updateMeter()
        }
        let wasSettled = settled(chat)
        chat = snapshot
        applyTitle()
        if picked == snapshot.mode { picked = nil }
        media.register(snapshot.items)
        if snapshot.draftArrivals != draftArrivals {
            draftArrivals = snapshot.draftArrivals
            // Typed here since, on its way to the conversation: that stands.
            if snapshot.draftUpdatedAt >= lastDraftEdit { showDraft(snapshot.draft) }
        }
        if snapshot.localDraftLoaded { showPrefill() }
        proposals.want(snapshot.items.flatMap(\.proposalIds))
        updateHeaderStatus()
        if wasSettled != settled(snapshot), let intro { introView.configure(intro, settled: settled(snapshot)) }
        showIntro()
        if !snapshot.items.isEmpty { dismissNewWorkPanel() }
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
    /// The "+" menu and what it opens, as the legacy chat's composer has them.
    private lazy var attach: AttachMenuPresenter = {
        let presenter = AttachMenuPresenter(pictures: pictures, composer: .init(
            textView: { [weak self] in self?.card.textView },
            focus: { [weak self] in self?.card.focus() },
            addControl: { [weak self] in self?.card.addControl },
            text: { [weak self] in self?.card.text ?? "" },
            setText: { [weak self] text in self?.card.setText(text, selection: NSRange(location: (text as NSString).length, length: 0)) },
            send: { [weak self] in self?.send() }
        ))
        presenter.onSettled = { [weak self] added, keyboardWasUp in self?.settleFocus(added: added, keyboardWasUp: keyboardWasUp) }
        return presenter
    }()
    /// The model or effort list while it is open.
    private var picker: PickerPresenter?
    /// The permission modes for the detail over this screen, a pick going
    /// the way the header's More menu sent it (`choose`); nil until the
    /// catalog is in.
    var permissionChoice: PermissionModeChoice? {
        guard let menus else { return nil }
        return PermissionModeChoice(menu: ModelPickers.permissionMenu(menus)) { [weak self] key in self?.choose(key) }
    }

    private var menus: ModelMenus? {
        session.models.catalog.flatMap { catalog in mode.map { ModelMenus(catalog: catalog, selection: $0) } }
    }

    private func updateChips() {
        if reading(chat), picked == nil {
            card.configuration.model = nil
            card.configuration.effort = nil
        } else {
            ModelPickers.configure(card, menus: menus, usage: session.models.usage)
            picker?.update(menus: menus, usage: session.models.usage)
        }
        updateMeter()
    }

    /// The meter for the conversation's last measurement against the
    /// selected model's window. There is none while history is read, nor
    /// for new work before its first message, which has no conversation
    /// to measure yet (desktop's gauge needs a session).
    private func updateMeter() {
        let next = (reading(chat) && picked == nil) || (opensFocused && chat.items.isEmpty) ? nil
            : AgentContextGauge.derive(catalog: session.models.catalog, context: chat.context, selection: mode)
        if let next { meter.show(next) }
        let rowChanged = (next == nil) != (gauge == nil)
        gauge = next
        if rowChanged { view.setNeedsLayout() }
    }

    /// The "+" menu over `host`: new work for a picture opens it over this
    /// screen as the screen comes in. As Telegram's attachment menu, it
    /// takes the keyboard down while it is up; the draft and what already
    /// waits in the composer stay. What it adds waits in the composer,
    /// which then takes the keyboard, as does closing it with nothing.
    func presentAttach(from host: UIViewController) {
        guard attach.sheet == nil else { return }
        if session.models.catalog == nil { session.models.load() }
        attach.present(from: host)
    }

    /// The mode the next message runs with, by its name.
    private var permissionName: String {
        Strings.permissionName(mode?.permissionMode ?? session.models.catalog?.defaultPermissionMode ?? "auto")
    }

    /// What the "+" sheet started is over: the keyboard comes up if it was
    /// up before, or, for new work opened on the sheet, once something is
    /// in it. Either way it is owed no longer.
    private func settleFocus(added: Bool, keyboardWasUp: Bool) {
        let focuses = keyboardWasUp || (added && focusesAfterPick)
        focusesAfterPick = false
        guard focuses, view.window != nil else { return }
        card.focus()
    }

    /// A pick from the model control or the "+" sheet's permission.
    private func choose(_ key: String) {
        let conversation = conversation
        ModelPickers.choose(key, state: session.models, mode: mode) { [weak self] next in
            // Held here at once, so the chips read it before the conversation says so.
            self?.picked = next
            self?.updateChips()
            // A failure card offers to continue on what was picked.
            self?.replan()
            Task { await conversation.setMode(next) }
        }
    }

    private var planKey: ChatPlanner.Key {
        var key = ChatPlanner.Key(width: view.bounds.width, maxContentWidth: ContentWidth.maxWidth, environment: traitCollection.textEnvironment, references: subagentReferences, subagentTitles: chat.subagentTitles, pageHeights: pageHeights)
        // Only a failure card reads the composer's model; without one the
        // key stays the warm chat's, so its rows planned ahead are taken.
        if chat.items.contains(where: { if case .failure = $0.role { true } else { false } }) {
            key.switchTarget = switchTarget
            key.modelNames = Dictionary((session.models.catalog?.models ?? []).map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        }
        return key
    }

    /// The composer's model, named as its picker names it.
    private var switchTarget: ChatPlanner.SwitchTarget? {
        guard let mode else { return nil }
        return ChatPlanner.SwitchTarget(mode: mode, label: session.models.catalog?.model(mode)?.name ?? mode.modelId)
    }

    /// A failure card's action: the turn again, or continued on the
    /// composer's model. What went wrong doing it is said, not swallowed.
    private func resolveFailure(_ failure: Failure) {
        guard let action = ChatPlanner.action(failure, target: switchTarget) else { return }
        let conversation = conversation
        let mode: AgentWire.Mode? = if case .switchTo(let target) = action { target.mode } else { nil }
        Task { [weak self] in
            do { try await conversation.resolveFailure(failure.messageId, switchTo: mode) }
            catch {
                let alert = UIAlertController(title: Strings.Common.error, message: Store.describe(error), preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: Strings.Common.ok, style: .default))
                self?.present(alert, animated: true)
            }
        }
    }

    /// The conversation as the transcript shows it: each finished turn
    /// folded unless opened, a waiting question with what is ticked.
    private var shownItems: [ChatItem] {
        var items = chat.items
        if !picks.isEmpty {
            for index in items.indices {
                guard case .question(var ask) = items[index].role, let picked = picks[ask.question.id] else { continue }
                ask.picked = picked
                items[index].role = .question(ask)
            }
        }
        return TurnFold.fold(items, expanded: expandedTurns)
    }

    /// The question waiting on the person, with what is ticked.
    private var waitingQuestion: ChatItem.Ask? {
        for item in chat.items.reversed() {
            guard case .question(var ask) = item.role, ask.phase != .answered else { continue }
            ask.picked = picks[ask.question.id] ?? [:]
            return ask
        }
        return nil
    }

    /// Opens a finished turn on its work, or folds it again, the rows the
    /// reader is looking at staying where they are.
    private func toggleTurn(_ turn: String) {
        if expandedTurns.remove(turn) == nil { expandedTurns.insert(turn) }
        followsNewest = false
        foldMoved = true
        replan()
    }

    /// Ticks or unticks an option of the waiting question.
    private func pick(questionId: String, promptId: String, option: Int) {
        guard let ask = waitingQuestion, ask.question.id == questionId, ask.phase != .submitting,
              let options = ask.question.questions.first(where: { $0.id == promptId })?.options, options.indices.contains(option) else { return }
        let label = options[option].label
        UISelectionFeedbackGenerator().selectionChanged()
        picks[questionId] = ask.picking(label, in: promptId)
        replan()
    }

    /// Sends what is ticked; the answer stands once the computer takes it.
    private func submit(questionId: String) {
        guard let ask = waitingQuestion, ask.question.id == questionId, ask.complete else { return }
        let conversation = conversation
        Task { await conversation.answer(ask.picked) }
    }

    /// Plans the rows off the main thread, then shows them in one frame.
    private func replan() {
        let key = planKey
        // Nothing is planned from history not yet read.
        guard key.width > 0, !reading(chat) else { return }
        // Ticks outlive only the question they were for.
        if !picks.isEmpty {
            let waiting = waitingQuestion?.question.id
            picks = picks.filter { $0.key == waiting }
        }
        let items = shownItems
        // A turn that just ended folds its work away in place.
        if let before = planned?.items {
            let ended = Set(before.compactMap { if case .turnEnd = $0.role { $0.id } else { nil } })
            let newest = items.last { $0.turn != nil }?.turn
            if items.contains(where: { if case .turnEnd = $0.role { !ended.contains($0.id) && $0.turn == newest } else { false } }) { foldMoved = true }
        }
        // Only words not looked through yet, as of what references read as
        // now: a long conversation isn't read again on every layout pass.
        if scanned.references != references { scanned = (references, [:]) }
        let fresh = items.filter { scanned.texts[$0.id] != $0.text }
        for item in fresh { scanned.texts[item.id] = item.text }
        // Artifacts the messages name are read for their titles, once each.
        let unread = fresh.flatMap { references.unread(in: $0.text) }
        if !unread.isEmpty {
            let store = session.store
            Task { await store.readArtifacts(unread) }
        }
        // An HTML artifact a call shows is read for whether it wants to be inline.
        let pages = items.flatMap(\.pieces).compactMap { piece -> String? in
            guard case .artifact(let artifact) = piece, artifact.type == "html", artifact.followsLatest, references.artifacts[artifact.id] == nil else { return nil }
            return artifact.id
        }
        if !pages.isEmpty {
            let store = session.store
            Task { await store.readArtifacts(pages) }
        }
        // So are the names of the people they mention.
        let people = fresh.flatMap { references.unknownUsers(in: $0.text) }
        if !people.isEmpty {
            let store = session.store
            Task { await store.readUsers(people) }
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
        let untouched = !previewing && copiedId == nil && opened.isEmpty && shown.isEmpty && expandedTurns.isEmpty && picks.isEmpty
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
        #if DEBUG || HAPPY_FIXTURES
        GymFrameMeter.noteApply(rows: plans.count, changed: plans.filter { plan in plansById[plan.id].map { $0 !== plan } ?? false }.count)
        #endif
        self.plans = plans
        plansById = Dictionary(plans.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        planShown = true
        showIntro()
        layoutTranscript()
        timeShown()
    }

    /// `row` shows `plan`, and reads as it.
    private func configure(_ row: ChatPlanView, _ plan: ChatRowPlan) {
        // The same plan, with no cards that may have moved: as it was.
        if row.plan === plan, plan.proposals.isEmpty, rowCards[plan.id] == nil { return }
        row.apply(plan)
        row.accessibilityLabel = plan.accessibilityLabel
        // A long message reads whole; it opens or closes by an action.
        let id = plan.id
        var hosted = Set<String>()
        for (artifactId, layout, frame) in plan.proposals {
            guard let shown = shownProposals[artifactId] else { continue }
            let key = "\(plan.id)#\(artifactId)"
            hosted.insert(key)
            let card = proposalViews[key] ?? makeProposal(artifactId, key: key)
            if card.superview !== row { row.addSubview(card) }
            card.setLayoutFrame(frame)
            card.apply(shown, layout: layout)
        }
        for key in (rowCards[id] ?? []).subtracting(hosted) {
            proposalViews.removeValue(forKey: key)?.removeFromSuperview()
        }
        rowCards[id] = hosted.isEmpty ? nil : hosted
        reads(row, plan)
    }

    /// What VoiceOver reads of `row`: what of it is a view now, a tall
    /// row's chunks near the screen included. Its cards stay over its chunks.
    private func reads(_ row: ChatPlanView, _ plan: ChatRowPlan) {
        let id = plan.id
        #if DEBUG || HAPPY_FIXTURES
        let evidence = ProcessInfo.processInfo.environment["HAPPY_CHAT_PROBE"] == nil ? nil : "id=\(id),alpha=\(plan.alpha)"
        row.accessibilityValue = evidence
        #endif
        let toggles = plan.toggles.map { name in
            [UIAccessibilityCustomAction(name: name) { [weak self] _ in self?.toggle(id); return true }]
        }
        // A long press's actions: Copy, and Select Text on its own screen.
        let selects = plan.selection.map { selection in
            [
                UIAccessibilityCustomAction(name: Strings.Chat.copy) { _ in UIPasteboard.general.string = selection.whole; return true },
                UIAccessibilityCustomAction(name: Strings.TextSelection.title) { [weak self] _ in
                    self?.navigationController?.pushViewController(TextSelectionViewController(text: selection.whole), animated: true)
                    return true
                },
            ]
        }
        row.accessibilityCustomActions = (toggles ?? []) + (selects ?? [])
        let cardsHosted: [UIView] = plan.proposals.compactMap { proposalViews["\(id)#\($0.artifactId)"] }.filter { $0.superview === row }
        for card in cardsHosted { row.bringSubviewToFront(card) }
        // A row with media reads as its message, then each picture or
        // recording on its own, and each card as what it opens.
        let cards = plan.hits.sorted { $0.frame.minY < $1.frame.minY }.compactMap { hit -> UIAccessibilityElement? in
            guard let label = self.cardLabel(hit.action) else { return nil }
            let card = UIAccessibilityElement(accessibilityContainer: row)
            card.accessibilityLabel = label
            card.accessibilityTraits = .button
            card.accessibilityIdentifier = "card"
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
            message.accessibilityIdentifier = "message"
            #if DEBUG || HAPPY_FIXTURES
            message.accessibilityValue = evidence
            #endif
            message.accessibilityCustomActions = toggles
            message.accessibilityFrameInContainerSpace = plan.items.reduce(CGRect.null) { frame, item in
                item.wordsFrame.map { frame.union($0) } ?? frame
            }
            row.accessibilityElements = [message] + media
        } else {
            row.accessibilityElements = media
        }
    }

    private func makeProposal(_ artifactId: String, key: String) -> SidebarProposalView {
        let card = SidebarProposalView(images: session.images)
        proposalViews[key] = card
        // A preview is only looked at: nothing in it is decided from there.
        if previewing { return card }
        let proposals = proposals
        card.onAccept = { proposals.accept(artifactId) }
        card.onDecline = { proposals.decline(artifactId) }
        card.onTurn = { [weak self] rowId in
            // The section opens under the finger, not pulled up to the newest row.
            self?.followsNewest = false
            Haptics.play(.fold)
            proposals.turn(artifactId, rowId: rowId)
        }
        return card
    }

    /// The header's grey line: what the agent is at, in a word, while it is.
    private func updateHeaderStatus() {
        header.status = Strings.HeaderStatus.text(headerState, activity: chat.activity, loaded: chat.loaded)
        // The link on its way, or the chat still catching up: said with
        // the spinner, as home's title says it.
        header.statusSpins = Strings.HeaderStatus.spins(headerState) || (headerState == .online && !chat.loaded)
        // "Thinking" and "Working" sweep while the working line's loader
        // runs; a question or a wait is said still.
        header.statusShimmers = headerState == .online && chat.loaded && ChatJumpButton.spins(chat.activity)
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if previewing { return layoutPreview() }
        replan()
        if firstFrame == nil {
            firstFrame = drawn
            // The UI tests find the transcript by this.
            ultra.list.accessibilityIdentifier = "transcript"
        }
        timeShown()
        header.maxWidth = ChatTitleLayout.maxWidth(barWidth: view.bounds.width)
        // From where the keyboard rests, not the finger dragging it: the
        // card keeps its shape through a drag and changes once it settles.
        let compact = compacts
        card.configuration.compact = compact
        let guideTop = keyboardTracker.frame.minY
        ultraKeyboard?.prepareLayout(guideTop: guideTop)
        let screen = ChatScreenLayout(
            size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets),
            // The list's keyboard, while the screen is shown: where it put
            // the keyboard, or the guide under the system's own dismissal.
            keyboardTop: ultraKeyboard.flatMap { $0.isActive ? $0.keyboardTop(guideTop: guideTop) : nil }
                ?? (fingerOnKeyboard ? guideTop : keyboardTop),
            meter: ChatScreenLayout.showsMeter(hasGauge: gauge != nil, compact: compact),
            maxContentWidth: ContentWidth.maxWidth
        ) { [card] width in card.height(fitting: width) }
        transcriptHeaderScrim.setLayoutFrame(screen.headerScrim)
        card.setLayoutFrame(screen.card)
        meter.isHidden = screen.meter == nil
        if let frame = screen.meter { meter.setLayoutFrame(frame) }
        layoutNewWorkPanel(above: screen.card)
        picker?.follow()
        let foot = ChatFootLayout(size: view.bounds.size, card: screen.card)
        composerScrim.setLayoutFrame(foot.scrim)
        jump.setLayoutFrame(foot.jump)
        // The transcript starts under the navigation bar and scrolls under
        // it. The list is inverted: its top edge is the composer's edge.
        if ultra.frame != view.bounds { ultra.frame = view.bounds }
        ultra.setViewport(size: view.bounds.size, insets: UIEdgeInsets(top: screen.listBottom, left: 0, bottom: view.safeAreaInsets.top, right: 0),
                          keyboard: insetMotion)
        layoutTranscript()
        updateHeaderEdge()
        ultraKeyboard?.refresh()
    }

    // MARK: Preview

    private func setUpPreview() {
        card.isHidden = true
        composerScrim.isHidden = true
        navigationItem.titleView = nil
        ultra.isUserInteractionEnabled = false
        // Read from the start of the newest message, not its end.
        ultra.showsNewestFromItsStart = true
        view.accessibilityIdentifier = "preview"
        previewPill.isAccessibilityElement = true
        previewPill.accessibilityTraits = .header
        previewPill.accessibilityIdentifier = "preview-title"
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
        let layout = PreviewLayout(size: view.bounds.size, titleSize: previewTitle.sizeThatFits(view.bounds.size))
        previewPill.frame = layout.pill
        previewTitle.frame = layout.title.offsetBy(dx: -layout.pill.minX, dy: -layout.pill.minY)
        ultra.frame = view.bounds
        // Inverted: the list's top edge is the card's foot.
        ultra.setViewport(size: view.bounds.size, insets: UIEdgeInsets(top: layout.listBottom, left: 0, bottom: layout.listTop, right: 0))
        layoutTranscript()
        previewFade.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: layout.fadeOpaque)
        previewFade.clearFrom = layout.fadeClear / max(1, layout.fadeOpaque)
        updatePreviewFade()
    }

    /// Nothing scrolled under the title: nothing to fade, and the first
    /// line stays whole.
    private func updatePreviewFade() {
        guard previewing else { return }
        previewFade.isHidden = ultra.distanceFromOldest <= 0.5
    }

    private func layoutTranscript() {
        var introLayout: MakeStuffIntroLayout?
        if intro != nil { introLayout = introView.layout(width: view.bounds.width) }
        // Steering the turn hasn't taken waits under the newest settled
        // row, as next in the queue (desktop's
        // `conversationPendingSteering`). What the agent is at is the
        // header's (`header.status`): the transcript keeps no working line
        // of its own.
        let queuedIds = plansQueued
        let settled = plans.filter { !queuedIds.contains($0.id) }
        let waiting = plans.filter { queuedIds.contains($0.id) }
        // Steering taken up goes into the transcript above the queue,
        // easing there.
        let wasTaken = !queuedShown.subtracting(queuedIds).isEmpty && view.window != nil
        queuedShown = queuedIds
        var opening: (view: UIView, height: CGFloat)?
        if let introLayout {
            introView.place(introLayout)
            opening = (view: introView, height: introLayout.size.height)
        }
        let folds = foldMoved && view.window != nil
        foldMoved = false
        ultra.apply(settled + waiting, intro: opening, animated: wasTaken, moves: folds, streaming: chat.working, queued: waiting.count)
        updateJump()
    }

    /// The transcript is up: history read and its rows, if any, laid out.
    private var drawn: Bool { chat.loaded && (chat.items.isEmpty || planShown) }

    private var timed = false
    /// What `timeShown` found, the transcript's value.
    private var timing = ""

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
            let warm = WarmChats.enabled ? "warm" : "off"
            #if DEBUG
            print("HAPPY_OPEN \(warm) first=\(firstFrame) ms=\(ms) rows=\(plans.count)")
            #endif
            timing = "first=\(firstFrame) ms=\(ms) rows=\(plans.count)"
            ultra.list.accessibilityValue = timing
            #if DEBUG
            probe?.report()
            #endif
        }
    }

    /// The way back shows while the reader is more than a third of the
    /// list's height from the newest message, as desktop's does, and
    /// shimmers while the working line spins: not on a question to the
    /// person or a scheduled wait, which show still.
    private func updateJump() {
        let away = !previewing && ChatFootLayout.showsJump(distanceFromEnd: ultra.distanceFromNewest, viewport: ultra.viewportHeight)
        // Hidden, it doesn't sweep.
        jump.working = away && ChatJumpButton.spins(chat.activity)
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

    /// Tells the conversation, when it changes, whether the reader is at the
    /// newest message with the scroll at rest: only then may a run's end trim
    /// the runs above (desktop's `trimHistory` on a watched session), so
    /// nothing moves under a finger or a glide.
    private func tellReadsNewest(moving: Bool) {
        let reads = followsNewest && !moving
        guard reads != toldReadsNewest else { return }
        toldReadsNewest = reads
        let conversation = conversation
        Task { await conversation.setReadsNewest(reads) }
    }

    /// Back to the newest message, following it from there.
    @objc private func jumpToLatest() {
        followsNewest = true
        ultra.scrollToNewest(animated: true)
        tellReadsNewest(moving: false)
    }

    // MARK: Acts

    private func updatePrimary() {
        let hasContent = !card.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pictures.images.isEmpty
        card.configuration.primaryAction = AgentInputPrimaryAction.resolve(
            hasComposerContent: hasContent, isSendBlocked: false, isSendDisabled: false, showAbortButton: chat.working, canAbort: true
        )
    }

    /// A send follows the transcript the person is actually reading.
    /// A send now would fly in from the composer (`SendFollow`).
    var sendFlies: Bool { ChatSendFlight.flies(distance: ultra.distanceFromNewest) }

    private func send() {
        guard !acceptingSend else { return }
        let text = card.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let picked = pictures.images.map(\.attachment)
        let pickedIDs = pictures.images.map(\.id)
        guard !text.isEmpty || !picked.isEmpty else { return }
        // A question waiting takes what is typed as its answer, as on
        // desktop: each prompt its ticked options, else the words. Words
        // no prompt needed still go as a message.
        if let ask = waitingQuestion, ask.phase != .submitting, !text.isEmpty {
            let (answers, textUsed) = ask.answers(typed: text)
            let conversation = conversation
            Task { await conversation.answer(answers) }
            if textUsed {
                Haptics.play(.send)
                card.setText("", selection: NSRange(location: 0, length: 0))
                return
            }
        }
        acceptingSend = true
        Haptics.play(.send)
        // Telegram's send: the reader is carried to the end; at the end
        // the message flies in from the composer, from history it arrives
        // with the scroll. The transcript is never lifted.
        let id = ClientID.make()
        if sendFlies {
            ultra.flight = ChatSendFlight(source: ChatSendFlight.source(from: card, in: view), host: view, message: id)
            followsNewest = true
            ultra.follow()
        } else {
            followsNewest = true
            ultra.scrollToNewest(animated: !UIAccessibility.isReduceMotionEnabled)
        }
        let conversation = conversation
        let store = session.store
        let staged = pictures
        let kind = newTask?.choice.kind ?? .task
        #if DEBUG
        composeTrace?.event("send choice=\(String(describing: newTask?.choice))")
        #endif
        if newWorkPanel?.name.isFirstResponder == true { card.focus() }
        newWorkPanel?.isLocked = true
        Task {
            await store.attentionInput()
            let accepted = await conversation.send(id: id, text: text, attachments: picked)
            acceptingSend = false
            if !accepted, !newWorkPanelGone { newWorkPanel?.isLocked = false }
            if accepted {
                if card.text.trimmingCharacters(in: .whitespacesAndNewlines) == text {
                    card.setText("", selection: NSRange(location: 0, length: 0))
                }
                staged.removeSent(pickedIDs)
            } else {
                let refusal = await conversation.sendRefusal
                let message = refusal.map { Strings.newWorkFailed(kind, $0) } ?? "The message could not be saved. Your text and attachments are still here."
                let alert = UIAlertController(title: Strings.Common.error, message: message, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: Strings.Common.ok, style: .default))
                present(alert, animated: true)
            }
        }
    }

    /// What a card says it opens; nil for any other hit.
    private func cardLabel(_ action: ChatRowAction) -> String? {
        switch action {
        case .openArtifact(let artifact): Strings.open(artifact.title.isEmpty ? Strings.untitledArtifact : artifact.title)
        case .openMedia(let key): media.media(key).flatMap { $0.isVisual ? nil : Strings.open($0.item.name) }
        default: nil
        }
    }

    /// Desktop opens a picture in its Lightbox and plays a recording where
    /// it is; the phone plays it in the system player, and shows a document
    /// or file in Quick Look once its bytes are here.
    private func open(_ key: String) {
        if let file = media.media(key), !file.isVisual {
            let preview = FilePreview(loader: media, media: file)
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
        // A recording plays as soon as its first range is here, streaming.
        let opened = VideoOpening.shared.open(boardKey: media.download(key)?.boardKey, from: self, failed: { [weak self] in self?.showFileUnavailable() }) {
            media.player(key)
        }
        if opened { return }
        // Every picture of the conversation, swiped between in its order.
        var pictures = Picture.all(in: chat.items)
        if !pictures.contains(where: { $0.key == key }) {
            let presented = media.media(key)
            pictures = [presented.map(Picture.init) ?? Picture(key: key, thumbhash: nil, label: Strings.picture)]
        }
        let index = pictures.firstIndex { $0.key == key } ?? 0
        present(PictureViewController(source: media, pictures: pictures, index: index), animated: true)
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

    /// The ask Settings opened this conversation with, once the draft it
    /// already had is in the composer: the words go above that draft, two
    /// lines over it, with the caret after them and the keyboard up, so
    /// the person finishes the sentence and sends it themselves.
    ///
    /// It goes in once. Nothing is sent, and the conversation's stored
    /// draft is not written by opening: only typing does that, as
    /// anywhere else, so an ask left untouched is not kept.
    private func showPrefill() {
        guard let prefill, !prefilled, !previewing else { return }
        prefilled = true
        let shown = prefill.applied(to: card.text)
        showingDraft = true
        card.setText(shown.text, selection: NSRange(location: shown.caret, length: 0), animatesHeight: false)
        showingDraft = false
        updatePrimary()
        // On screen already: the keyboard now. Still arriving: with it.
        if view.window != nil, !focusPending { card.focus() }
    }

    private func showFileUnavailable() {
        let alert = UIAlertController(title: nil, message: Strings.fileUnavailable, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Common.ok, style: .default))
        present(alert, animated: true)
    }

    @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
        // A tap away from the name being edited keeps it, as in the sidebar.
        if titleView.isEditing {
            titleView.finishEditing()
        }
    }

    /// Opens or closes another agent's message, or the person's long one,
    /// where it is, as the conversation grows anywhere: read at the newest,
    /// it stays there.
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
            var artifact = Artifact(id: reference.id, version: reference.version ?? known.latest, type: known.type, title: known.title, followsLatest: reference.version == nil)
            artifact.pinned = reference.version != nil
            navigationController?.pushViewController(ArtifactViewController(session: session, artifact: artifact), animated: true)
            return
        }
        guard let entity = references.entity(reference) else { return }
        // A bot's or task's own conversation opens as its row opens it: renamed in its bar, its mark in the intro.
        let row = sidebarRows.first { $0.kind == .space && $0.agentId == entity.agentId }
        let intro: Intro? = switch row?.mark {
        case .clay(let slug)?: .clay(slug)
        default: nil
        }
        let title = references.view(reference).label
        let chat = ChatViewController(session: session, agentId: entity.agentId, title: title, spaceId: row?.spaceId, intro: intro)
        navigationController?.pushViewController(chat, animated: true)
    }

    private func loadOlder() {
        guard chat.hasMore else { return }
        let conversation = conversation
        Task { await conversation.loadOlder() }
    }

    /// A link in a row: the reference it names, else the web.
    private func open(link: String) {
        if let reference = HappyReferences.reference(link: link) { open(reference) }
        else if let url = URL(string: link) { openBrowser(url, session: session, agentID: media.agentId) }
    }

    /// What a tap on a row's action does, from either transcript.
    func act(_ action: ChatRowAction) {
        switch action {
        case .copyMessage(let id, let text):
            UIPasteboard.general.string = text
            showCopied(id)
        case .retry(let localId):
            // A failure card's action names its service message.
            if let item = chat.items.first(where: { $0.id == localId }), case .failure(let failure) = item.role {
                resolveFailure(failure)
                return
            }
            let conversation = conversation
            Task { await conversation.retry(localId) }
        case .cancelUpload(let messageId, let piece):
            // Telegram's cross: that one is taken out, the rest still goes.
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            let conversation = conversation
            Task { await conversation.removeAttachment(messageId, key: piece) }
        case .openMedia(let key):
            open(key)
        case .toggleDownload(let key):
            // Here already: the ring is gone, so the tap opens it.
            if media.isDownloaded(key) { open(key) } else { media.toggleDownload(key) }
        case .openArtifact(let artifact):
            navigationController?.pushViewController(ArtifactViewController(session: session, artifact: artifact), animated: true)
        case .toggleTool(let messageId):
            toggle(messageId)
        case .toggleTurn(let turn):
            toggleTurn(turn)
        case .questionOption(let questionId, let promptId, let option):
            pick(questionId: questionId, promptId: promptId, option: option)
        case .questionSubmit(let questionId):
            submit(questionId: questionId)
        default:
            break
        }
    }

    /// What a long press on a row does, from either transcript.
    private func hold(_ action: ChatRowAction) {
        switch action {
        case .copyMenu(let text), .selectable(let text):
            UIPasteboard.general.string = text
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .markdownSelectable(_, let markdown):
            navigationController?.pushViewController(TextSelectionViewController(text: markdown), animated: true)
        default:
            break
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

extension ChatViewController: AgentInputCardDelegate {
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
            // The newest row rises with the card's top, not ahead of it.
            insetMotion = insetMotion(easingIn: 0.2)
            defer { insetMotion = nil }
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

    /// The add button opens the "+" menu: the library, the camera and files.
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
        let picker = PickerPresenter(list: chip == .effort ? .effort : .model, card: card, menus: menus, usage: session.models.usage) { [weak self] key in
            self?.choose(key)
        }
        picker.onClose = { [weak self, weak picker] in
            if let self, self.picker === picker { self.picker = nil }
        }
        // Under the navigation bar.
        picker.top = { [weak self] in self?.view.safeAreaInsets.top ?? 0 }
        self.picker = picker
        picker.show(in: view)
        ModelPickers.opened(session.models, mode: mode)
    }

    func agentInputCard(_ card: AgentInputCardView, didOpenMenuIn chip: AgentInputChip) {
        ModelPickers.opened(session.models, mode: mode)
    }

    func agentInputCardDidPressStop(_ card: AgentInputCardView) {
        let conversation = conversation
        Task { await conversation.abort() }
    }
}

extension ChatViewController: ChatMediaProviding {
    var chatMedia: ChatMediaSource? { media }
}

extension ChatViewController: PageHosting {
    var pageClient: AgentClient { session.client }
    func page(open url: URL) { openBrowser(url, session: session, agentID: media.agentId) }

    func page(_ artifactId: String, measured height: CGFloat) {
        let height = min(max(1, height.rounded(.up)), 4000)
        guard pageHeights[artifactId].map({ abs($0 - height) >= 1 }) ?? (height != ChatPlanner.pageHeight) else { return }
        pageHeights[artifactId] = height
        replan()
    }
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

#if DEBUG
extension ChatViewController {
    /// For the UI tests (`V2_CHAT_PROBE`): as the transcript's value after
    /// its timing, how the composer kept to a keyboard a finger held part
    /// way down, how far a swipe back moved, and the sideways scrollers on
    /// screen. With `relayout` the screen is laid out again on every
    /// frame, as a reply streaming in lays it out.
    final class ScrollProbe: NSObject {
        weak var screen: ChatViewController?
        var link: CADisplayLink!
        private let relayout: Bool
        private var keyboardFrames = 0
        private var keyboardGap: CGFloat = 0
        private var edgeSamples = 0
        private var contentSamples = 0
        private var edgeTranslation: CGFloat = 0
        private var contentTranslation: CGFloat = 0

        @MainActor init(_ screen: ChatViewController, relayout: Bool) {
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
            let top = screen.keyboardTracker.frame.minY
            if screen.ownsKeyboard,
               top > screen.keyboardTop + 20, top < screen.view.bounds.maxY - 30 {
                keyboardFrames += 1
                let rest = screen.meter.isHidden ? ChatScreenLayout.Metrics.paddingBottom : ContextMeterLayout.Metrics.height
                keyboardGap = max(keyboardGap, abs(top - screen.card.frame.maxY - rest))
            }
            observePop()
            report()
        }

        /// Public recognizer motion while UIKit has an interactive transition.
        /// A cancelled drag must have entered this state, beyond merely leaving
        /// the chat visible after a gesture that never started.
        @MainActor func observePop() {
            guard let screen, screen.transitionCoordinator?.isInteractive == true,
                  let navigation = screen.navigationController else { return }
            var gestures = [(navigation.interactivePopGestureRecognizer, false)]
            if #available(iOS 26.0, *) { gestures.append((navigation.interactiveContentPopGestureRecognizer, true)) }
            for (gesture, content) in gestures {
                guard let pan = gesture as? UIPanGestureRecognizer, pan.state == .began || pan.state == .changed else { continue }
                let x = pan.translation(in: navigation.view).x
                let leading = navigation.view.effectiveUserInterfaceLayoutDirection == .rightToLeft ? -x : x
                guard leading > 0 else { continue }
                if content { contentSamples += 1; contentTranslation = max(contentTranslation, leading) }
                else { edgeSamples += 1; edgeTranslation = max(edgeTranslation, leading) }
            }
        }

        @MainActor func report() {
            guard let screen else { return }
            let list = screen.ultra.list
            // Inverted: the list's top inset is the composer's end.
            list.accessibilityValue = "\(screen.timing) top=\(Int(list.contentInsets.bottom)) bottom=\(CGFloat(list.contentInsets.top)) keyboardFrames=\(keyboardFrames) keyboardGap=\(keyboardGap) guide=\(screen.keyboardTracker.frame.minY) cardBottom=\(screen.card.frame.maxY) popEdge=\(edgeSamples) popContent=\(contentSamples) popEdgeX=\(edgeTranslation) popContentX=\(contentTranslation)\(horizontalScrollers())"
        }

        @MainActor private func horizontalScrollers() -> String {
            guard let screen, let window = screen.view.window else { return "" }
            let card = screen.card.convert(screen.card.bounds, to: window)
            let top = screen.view.convert(CGPoint(x: 0, y: screen.view.safeAreaInsets.top), to: window).y
            let visible = CGRect(x: 0, y: top, width: window.bounds.width, height: max(0, card.minY - top))
            var fitting: String?
            var wide: String?
            func visit(_ view: UIView) {
                guard !view.isHidden, view.alpha > 0 else { return }
                if let scroller = view as? ChatScrollerView, !scroller.vertical {
                    let frame = scroller.convert(scroller.bounds, to: window).intersection(visible)
                    if !frame.isNull, frame.width > 20, frame.height > 10 {
                        let value = String(format: "%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f", frame.minX, frame.minY, frame.width, frame.height,
                                           scroller.contentOffset.x, scroller.contentSize.width, scroller.bounds.width)
                        if scroller.contentSize.width > scroller.bounds.width + 1 { wide = wide ?? value }
                        else { fitting = fitting ?? value }
                    }
                }
                for child in view.subviews { visit(child) }
            }
            visit(screen.ultra.list)
            return " hFit=\(fitting ?? "none") hWide=\(wide ?? "none")"
        }
    }
}
#endif

#if DEBUG
extension ChatViewController: ComposeTraced {
    var traceResponder: String {
        card.textView.isFirstResponder ? "composer" : newWorkPanel?.name.isFirstResponder == true ? "name" : "none"
    }
    var traceComposer: UIView? { card }
    var tracePanel: UIView? { newWorkPanelGone ? nil : newWorkPanel }
    var traceRoom: (top: CGFloat, bottom: CGFloat) { (view.safeAreaInsets.top, card.frame.minY) }
}
#endif

/// The preview card's own ground, whole and then none of it: the same
/// colour to its own clear, so it draws nothing but the messages going.
final class PreviewFadeView: UIView {
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
#endif

#if canImport(UIKit)
/// The transcript on UltraList (`AgentChatUltraList`) asks the screen for
/// the same things the rows it mounts itself do: what a row shows, and
/// what a tap or a press on one means.
extension ChatViewController: AgentChatTranscriptHost {
    func show(_ plan: ChatRowPlan, in view: ChatPlanView) {
        configure(view, plan)
    }

    func placedChunks(of plan: ChatRowPlan, in view: ChatPlanView) {
        reads(view, plan)
    }

    func transcriptScrolled() {
        #if DEBUG || HAPPY_FIXTURES
        GymFrameMeter.noteScroll()
        #endif
        followsNewest = ultra.followsNewest
        updateHeaderEdge()
        updatePreviewFade()
        updateJump()
        tellReadsNewest(moving: ultra.list.isTracking || ultra.list.isDecelerating)
    }

    func transcriptWillBeginDragging() {
        beginKeyboardDrag()
    }

    func transcriptDidEndDragging() {
        endKeyboardDrag()
    }

    /// The header's scrim, none with nothing under the bar: the
    /// transcript's distance past its oldest row.
    private func updateHeaderEdge() {
        guard !previewing else { return }
        let under = ultra.distanceFromOldest

        transcriptHeaderScrim.presence = HeaderScrim.presence(scrolledUnder: under)
    }

    func transcriptTapped(_ action: ChatRowAction) {
        act(action)
    }

    func transcriptOpened(_ url: String) {
        open(link: url)
    }

    func transcriptHeld(_ action: ChatRowAction, in view: UIView, frame: CGRect, at point: CGPoint) {
        // A message lifts, Telegram's way, with Copy and Select.
        if !previewing, let plan = (view as? ChatPlanView)?.plan, let selection = plan.selection, let window = view.window {
            switch action {
            case .copyMenu, .markdownSelectable:
                let transcript = ultra
                let source = MessageLiftSource(
                    plan: plan, selection: selection,
                    canvas: { [weak transcript] in transcript?.canvas(forPlan: plan.id) },
                    setLifted: { [weak transcript] lifted in transcript?.liftedId = lifted ? plan.id : nil },
                    host: self
                )
                if MessageLiftOverlay.present(source, in: window) != nil { return }
            default:
                break
            }
        }
        hold(action)
    }
}
#endif
