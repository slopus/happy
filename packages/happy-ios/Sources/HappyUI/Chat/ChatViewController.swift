#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyStore
import UIKit
import HappyWire

/// The session screen: session/[id].tsx → SessionView.tsx with
/// AgentContentView's floating dock (the phone layout).
///
/// ChatHeaderView rides the system navigation bar, made transparent: its
/// title capsule is the bar's title view and the avatar its right item,
/// over a scrim that strengthens once content scrolls under it.
///
/// The list runs under the navigation bar and the dock. The dock (the bars
/// above the composer, then the composer) sits on the keyboard, or on the
/// safe area while the keyboard is down, and follows the keyboard during an
/// interactive dismiss: `keyboardTracker` is pinned to the keyboard layout
/// guide, so every keyboard frame, animated or dragged, lays the screen out
/// again, inside the keyboard's own animation when there is one. Every frame
/// comes from `ChatScreenLayout`.
///
/// Messages go snapshot → display items (ChatDisplay: visibility, turns,
/// work groups, the rendered window) → row inputs → plans → the list's
/// geometry and changes, all off the main thread (`ChatRows` in an
/// `ApplyPipeline`). The main thread hands over what it decides (the width,
/// what the reader opened) and applies only what changed. While a pass
/// runs, newer snapshots merge into the next one.
final class ChatViewController: UIViewController, ChatListViewDelegate, ChatComposerDelegate {
    private let context: AppContext
    private let account: AccountSession
    /// Read by `AppCoordinator` to skip reopening the chat a tapped
    /// notification names when it is already on top.
    let sessionId: String
    /// The session the screen shows: `sessionId`, or for a `pending-chat:`
    /// screen the session it became once the machine answered. The route
    /// keeps the stand-in's id for the screen's whole life.
    private(set) var chatId: String
    private lazy var services = Self.services(account: account, context: context, sessionId: sessionId)

    private lazy var list = ChatListView()
    private lazy var scrim = ChatScrimView()
    private lazy var headerScrim = HeaderScrimView()
    private lazy var titleView = ChatHeaderTitleView()
    private lazy var avatarControl = ChatHeaderAvatarControl()
    private lazy var avatarItem = UIBarButtonItem(customView: avatarControl)
    /// The title on a tablet, without glass.
    private lazy var plainTitleView = ChatPlainHeaderTitleView()
    private lazy var cliWarning = ChatCliWarningPill()
    /// SessionView's `hidesLandscapeHeader`: a phone held sideways drops the
    /// header for a floating back button and a strip behind the status bar.
    private var hidesHeader = false
    private lazy var landscapeBack = ChatLandscapeBackButton()
    private lazy var statusBarStrip = ChatStatusBarStrip()
    /// localSettings' `acknowledgedCliVersions`, read once.
    private lazy var acknowledgedCliVersions = context.account.localSettings.acknowledgedCliVersions
    /// The spinner, an empty chat's EmptyMessages, or the deleted state.
    private lazy var placeholder = ChatPlaceholderView()
    private var headerBackdropVisible = false
    private let gitTask = TaskHolder()
    private var gitStatus: GitStatus?
    private lazy var dock = ChatDockView()
    private lazy var composer: any ChatComposerView = makeComposer()
    /// The composer stays hidden until its draft is restored, its taps
    /// caught meanwhile (`ChatComposerReveal`).
    private lazy var composerReveal = ChatComposerReveal(composer: composer)
    /// The bars above the composer, top to bottom: how to bring back a
    /// session that has stopped, the goal, a request the chat can't show
    /// inline, what a Happy Agent session has running.
    private lazy var inactiveHint = ChatInactiveHintView()
    private var resuming = false
    private lazy var goalBar = ChatGoalBarView()
    private var goalInFlight: SessionGoalAction?
    private lazy var questionBanner = ChatQuestionBannerView()
    private lazy var rigActivity = ChatRigActivityView()
    /// The session's pictures, for the attachments in the list, kept with
    /// this account's.
    private(set) lazy var chatAttachments: ChatAttachmentImages? = makeChatAttachments()
    private weak var questionSheet: AgentQuestionSheetController?
    /// Questions a sent message answers instead, by the message's local
    /// id: dismissed once it is delivered.
    private var questionsToDismiss: [String: [PendingAgentCommunication]] = [:]
    private lazy var scrollButton = ChatScrollButton()
    private lazy var copyCallout = ChatCopyCallout()
    private lazy var keyboardTracker = UIView()
    /// Measures each row once per input and width, for the pipeline.
    private let planner = RowPlanner<ChatRowInput, ChatRowPlan> { ChatRowRenderer.plan($0, width: $1) }
    private var rows: ApplyPipeline<ChatRowsInput, ChatRowsApplied, ChatRowsUpdate>?
    private var rowsObservation: ApplyObservation?
    /// What the rows were last asked for, so an unchanged layout pass asks
    /// for nothing.
    private var sentRowsView = ChatRowsView()
    /// The rows' words, in the language the screens spoke when this one was
    /// built; the screens are built again in another.
    private let words = ChatWords(catalog: AppLocalization.screens)
    /// The next time a waiting user message's status is due to show.
    private var graceEnd: Int64?
    private let graceTask = TaskHolder()
    /// The agent message whose copy button shows its tick.
    private var copiedMessageId: String?
    private let copiedTask = TaskHolder()
    private var observation: ApplyObservation?
    /// Moves each time the screen leaves a chat, so nothing worked out for
    /// that chat is applied after.
    private var chatGeneration = 0
    /// A `pending-chat:` screen's record, and the session it was started
    /// beside.
    private var pendingChat: PendingChat?
    private let pendingTask = TaskHolder()
    private var anchorMetadata: JSONValue?
    private var anchorRecord: SessionRecord?
    private var gitSessionId: String?
    private var anchorObservation: ApplyObservation?
    /// Every chat being opened, for the strip's stand-ins.
    private var pendingChats: [String: PendingChat] = [:]
    /// Grouped by project, the checkout the header speaks for and its chats
    /// as tabs under it (`useProjectWorktreeSummary`, WorktreeTabStrip).
    private var checkout: WorktreeCheckout?
    private var checkoutObservation: ApplyObservation?
    private var checkoutSessionId: String?
    private lazy var tabStrip = ChatWorktreeTabStrip()
    /// The strip's scroll on the screen this one replaced, to start from.
    private var inheritedStripOffset: CGFloat?
    /// Readiness diagnostics for content installed during the transition.
    private var opening: ChatOpening?
    private(set) var openingReport: ChatOpening.Report?
    private var construction: ChatConstruction?
    private var seedTask: Task<ChatServices.Seed?, Never>?
    private var connectionTask: Task<Void, Never>?
    private(set) var contentInstalled = false
    var constructionStageSeconds: [CFTimeInterval] { construction?.stageSeconds ?? [] }
    private var constructionStarted = false
    #if DEBUG || HAPPY_FIXTURES
    /// Separate from ChatOpening's readiness clock, which starts after load.
    var constructionSeconds: CFTimeInterval = 0
    private(set) var loadingSeconds: CFTimeInterval = 0
    private(set) var openingLayoutSeconds: CFTimeInterval = 0
    #endif
    /// Which deferred content pieces have arrived, each in once.
    private var sessionApplied = false
    private var checkoutApplied = false
    private var rowsApplied = false
    /// Derived from the account's newest home snapshot during the
    /// transition (`seed`), for the first observations to start from.
    private var seededSession: ChatSessionState?
    private var seededCheckout: WorktreeCheckout??
    /// How often the store's record changed what the screen drew: none
    /// while it agrees with the seed.
    private(set) var sessionUpdates = 0
    private lazy var sessionActions: HomeSessionActions = {
        let actions = HomeSessionActions(context: context, session: account, host: self)
        actions.onBeforeArchive = { [weak self] id in self?.tabArchiving(id) }
        return actions
    }()

    /// What the screen reads from the latest snapshot besides its rows.
    private var facts: ChatSnapshotFacts?
    private var session = ChatSessionState(record: nil, settings: AccountSettings())
    /// Pages of history, work groups opened or closed, trips to the
    /// background: carried out by the rows' derivation.
    private var windowRequests = ChatWindowRequests()
    /// Pages of history the shown window has taken in, and whether it
    /// holds every message: one page is asked for at a time.
    private var appliedGrows = 0
    private var reachesOldest = false
    /// The chat's history paging (`ChatHistoryPager`): a real chat's, not
    /// a stand-in's or a fixture's.
    private var historyPager: ChatHistoryPager?
    /// How far the oldest rendered row is past the visible area, and what
    /// it is (`ChatOlderPaging.boundary`).
    private var oldestDistance: CGFloat = .greatestFiniteMagnitude
    private var oldestBoundary: String?
    private var inForeground = true
    private var dockDetailsVisible = true
    /// `traitCollection.isTabletLayout`, kept here so the row inputs can be
    /// built off the main thread.
    private var isTabletLayout = false
    /// PermissionFooter's list cap for this window, read on the main thread
    /// and handed to the measure with the rest of the row style.
    private var permissionListMaxHeight = PermissionFooterLayout.Metrics.maxListHeight
    /// Permission buttons whose reply is on its way, by permission id.
    private var permissionBusy: [String: PermissionButton.Kind] = [:]
    /// Tools the reader opened, by message id: for as long as the screen
    /// lives, never stored.
    private var expandedTools: Set<String> = []
    /// The tool just opened or closed, held still by the next update, and
    /// how many have been.
    private var pin: String?
    private var pins = 0
    /// Moves when the grace timer fires.
    private var graceTick = 0
    /// Diff files the reader opened past "Show N more lines": by tool
    /// message id, then by diff in the tool.
    private var diffExpanded: [String: [Int: Set<Int>]] = [:]
    /// Question forms in the chat, by tool message id: the form as the
    /// latest snapshot has it, and what the reader has done to it.
    private var questionForms: [String: ChatQuestionForm] = [:]
    private var questionDrafts: [String: ChatQuestionState] = [:]
    /// How tall each diagram's page said it is: by row id, then by its
    /// place in the row. For as long as the screen lives.
    private var mermaidHeights: [String: [Int: CGFloat]] = [:]

    init(context: AppContext, session account: AccountSession, sessionId: String) {
        self.context = context
        self.account = account
        self.sessionId = sessionId
        chatId = sessionId
        super.init(nibName: nil, bundle: nil)
        hidesBottomBarWhenPushed = true
        // Only a cached name is needed by the navigation bar. No record
        // projection, checkout grouping, SQL, or composer is made on a tap.
        navigationItem.title = account.homeFeed.latest?.sessions.first { $0.id == sessionId }?.title
            ?? Strings.Session.newChat
    }

    private func makeComposer() -> any ChatComposerView {
        // A chat still being started keeps what is typed, and what is sent,
        // on the record standing in for it until the machine answers.
        let pending = PendingChats.isPendingChatId(sessionId)
        return ChatComposerFactory.make(ChatComposerEnvironment(
            sessionId: sessionId, account: account,
            sender: pending ? PendingChatSender(account.pendingChats) : services.sender,
            controls: services.controls,
            draftStorage: pending ? PendingChatComposerStorage(account.pendingChats) : nil
        ))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidLoad() {
        #if DEBUG || HAPPY_FIXTURES
        let loadingStarted = CACurrentMediaTime()
        defer { loadingSeconds = CACurrentMediaTime() - loadingStarted }
        #endif
        super.viewDidLoad()
        isTabletLayout = traitCollection.isTabletLayout
        view.backgroundColor = UIColor(Palette.surface)
        showsBackTitle()
        dropsBackButtonOnTablet() // Tablet (HappyUI/Tablet): ChatHeaderView.tsx
        navigationItem.largeTitleDisplayMode = .never
        configureHeaderAppearance()
    }

    private func installList() {
        let seed = services.seed
        seedTask = Task.detached(priority: .userInitiated) { seed() }
        list.delegate = self
        list.olderEnd.onAction = { [weak self] in self?.historyPager?.olderAction() }
        // The rows are planned at the list's text size (`ChatRowText`); the
        // placeholder, the header, the CLI warning and the bars over the
        // composer each carry the trait and measure their text off main at
        // it; the composer and the worktree tab strip follow on their own
        // (docs/DYNAMIC-TYPE.md).
        list.traitOverrides.followsTextSize = true
        list.registerForTraitChanges(UIView.textSizeTraits + [UITraitDisplayScale.self]) { [weak self] (_: ChatListView, _) in
            self?.scheduleMeasure()
        }
        view.addSubview(list)
        placeholder.traitOverrides.followsTextSize = true
        placeholder.isHidden = true
        placeholder.onAction = { [weak self] in self?.placeholderAction() }
        view.addSubview(placeholder)
    }

    private func installHeader() {
        setUpHeader()
        headerScrim.overlayOpacity = ChatHeaderScrim.restingOpacity
        view.addSubview(headerScrim)
        cliWarning.isHidden = true
        cliWarning.traitOverrides.followsTextSize = true
        cliWarning.onNeedsLayout = { [weak self] in self?.view.setNeedsLayout() }
        cliWarning.addTarget(self, action: #selector(dismissCliWarning), for: .touchUpInside)
        view.addSubview(cliWarning)
        view.addSubview(scrim)
        registerForTraitChanges([TabletLayoutTrait.self]) { (self: Self, _) in
            self.tabletLayoutChanged()
        }
    }

    private func installDock() {
        questionBanner.isHidden = true
        questionBanner.onOpen = { [weak self] in self?.openQuestionSheet() }
        questionBanner.onDismiss = { [weak self] in self?.dismissUnsupportedRequest() }
        inactiveHint.isHidden = true
        inactiveHint.onResume = { [weak self] in self?.resume() }
        goalBar.isHidden = true
        goalBar.onAction = { [weak self] action in self?.performGoalAction(action) }
        rigActivity.isHidden = true
        inactiveHint.onNeedsLayout = { [weak self] in self?.dockBarMeasured() }
        goalBar.onNeedsLayout = { [weak self] in self?.dockBarMeasured() }
        questionBanner.onNeedsLayout = { [weak self] in self?.dockBarMeasured() }
        rigActivity.onNeedsLayout = { [weak self] in self?.dockBarMeasured() }
        for bar in [inactiveHint, goalBar, questionBanner, rigActivity] as [UIView] {
            bar.traitOverrides.followsTextSize = true
        }
        dock.addSubview(inactiveHint)
        dock.addSubview(goalBar)
        dock.addSubview(questionBanner)
        dock.addSubview(rigActivity)
        view.addSubview(dock)
    }

    private func installButtons() {
        scrollButton.alpha = 0
        scrollButton.addTarget(self, action: #selector(scrollToNewest), for: .touchUpInside)
        view.addSubview(scrollButton)
        statusBarStrip.isHidden = !hidesHeader
        view.addSubview(statusBarStrip)
        landscapeBack.isHidden = !hidesHeader
        landscapeBack.addTarget(self, action: #selector(goBack), for: .touchUpInside)
        view.addSubview(landscapeBack)
    }

    private func installTabStrip() {
        tabStrip.isHidden = true
        tabStrip.glass = !isTabletLayout
        tabStrip.names = Self.tabNames(account)
        tabStrip.onSelect = { [weak self] id in self?.selectTab(id) }
        tabStrip.onLongPress = { [weak self] id in self?.sessionActions.present(sessionId: id) }
        tabStrip.onAdd = { [weak self] in self?.newTab() }
        tabStrip.showsAdd = true
        view.insertSubview(tabStrip, belowSubview: statusBarStrip)
    }

    private func installKeyboardTracker() {
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
    }

    private func installComposer() {
        composer.composerDelegate = self
        dock.addSubview(composer)
        dock.addSubview(composerReveal.catcher)
    }

    private func connectContent() {
        contentInstalled = true
        floatingDockChanged()
        updateHeaderVisibility(animated: false)
        view.setNeedsLayout()
        connectionTask = Task { [weak self, seedTask] in
            let seed = await seedTask?.value
            guard let self, !Task.isCancelled, self.parent != nil,
                  self.context.account.session === self.account else { return }
            if let seed { self.seed(seed) }
            self.connectObservations()
        }
    }

    private func connectObservations() {
        observeChat()
        // Every chat being opened: this screen's own record when it is one,
        // and the strip's stand-ins.
        let pendingChats = services.pendingChats
        pendingTask.task = Task { [weak self] in
            for await chats in await pendingChats.observe() {
                guard let self, !Task.isCancelled, self.context.account.session === self.account else { return }
                self.pendingChats = chats
                if PendingChats.isPendingChatId(self.sessionId) {
                    self.pendingChatChanged(chats[self.sessionId])
                }
                self.updateTabStrip()
            }
        }
        NotificationCenter.default.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(willEnterForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
        opening = ChatOpening(missing: { [weak self] in self?.openingMissing() ?? [] }) { [weak self] report in
            self?.openingReport = report
            self?.opening = nil
        }
        opening?.check()
    }

    private func startConstruction() {
        guard !constructionStarted else { return }
        constructionStarted = true
        construction = ChatConstruction(steps: [
            { [weak self] in self?.installList() },
            { [weak self] in self?.installHeader() },
            { [weak self] in self?.installDock() },
            { [weak self] in self?.installButtons() },
            { [weak self] in self?.installTabStrip() },
            { [weak self] in self?.installKeyboardTracker() },
            { [weak self] in self?.installComposer() },
            { [weak self] in self?.connectContent() },
        ], isCurrent: { [weak self] in
            guard let self else { return false }
            return self.parent != nil && self.context.account.session === self.account
        })
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        startConstruction()
        // A store write: never on the main thread.
        let actions = account.actions
        let chatId = self.chatId
        Task.detached(priority: .userInitiated) { actions.markRead(sessionId: chatId) }
        // sync.ts `onSessionVisible`: a session someone has opened is no
        // longer an abandoned start, in this account.
        account.spawnRequests.release(sessionId: chatId)
        if contentInstalled {
            updateHeaderVisibility(animated: animated)
        } else {
            // The shell owns the bar from its first frame too, without
            // constructing the landscape controls before the push.
            hidesHeader = tabletBranches.chatHidesHeaderInLandscape
            navigationController?.setNavigationBarHidden(hidesHeader, animated: animated)
        }
        historyPager?.isActive = true
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        VoiceCoordinator.shared.focus(account: account, sessionId: chatId)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // ChatList's `active`: a chat not shown asks for no older page.
        historyPager?.isActive = false
    }

    /// SessionView's unmount: a stand-in that has settled or failed is done
    /// with once its screen goes. One still starting is left alone; the
    /// person can come back to its tab.
    override func didMove(toParent parent: UIViewController?) {
        super.didMove(toParent: parent)
        if parent == nil {
            construction?.cancel()
            opening?.cancel()
            if contentInstalled { endChat() }
            pendingTask.task?.cancel()
            seedTask?.cancel()
            connectionTask?.cancel()
            gitTask.task?.cancel()
            anchorObservation?.cancel()
        }
        guard parent == nil, let chat = pendingChat, chat.sessionId != nil || chat.status == .failed else { return }
        let chats = services.pendingChats
        Task { await chats.dismiss(id: chat.id) }
    }

    // MARK: Opening

    /// What content is still missing. This never controls navigation.
    private func openingMissing() -> [String] {
        if view.window == nil {
            #if DEBUG || HAPPY_FIXTURES
            let layoutStarted = CACurrentMediaTime()
            defer { openingLayoutSeconds += CACurrentMediaTime() - layoutStarted }
            #endif
            view.layoutIfNeeded()
        }
        var missing: [String] = []
        if !sessionApplied { missing.append("session") }
        if !checkoutApplied { missing.append("checkout") }
        if !rowsApplied { missing.append("rows") }
        let header: UIView = isTabletLayout ? plainTitleView : titleView
        if !hidesHeader && (!(isTabletLayout ? plainTitleView.measure.isSettled : titleView.measure.isSettled)
            || header.window == nil || header.bounds.width <= 1) {
            missing.append("header")
        }
        if !tabStrip.isHidden, !tabStrip.isSettled { missing.append("strip") }
        if !composer.isRestored { missing.append("composer") }
        if !placeholder.isHidden, !placeholder.measure.isSettled { missing.append("placeholder") }
        if !cliWarning.isHidden, !cliWarning.measure.isSettled { missing.append("cliWarning") }
        let bars = [
            inactiveHint.isHidden || inactiveHint.measure.isSettled,
            goalBar.isHidden || goalBar.measure.isSettled,
            questionBanner.isHidden || questionBanner.measure.isSettled,
            rigActivity.isHidden || rigActivity.measure.isSettled,
        ]
        if bars.contains(false) { missing.append("dock") }
        return missing
    }

    /// Whether a change may animate: not before the screen's first frame.
    private var isShown: Bool {
        contentInstalled && openingReport != nil && isViewLoaded && view.window != nil && transitionCoordinator == nil
    }

    private static func services(account: AccountSession, context: AppContext, sessionId: String) -> ChatServices {
        ChatServices.make(account: account, sessionId: sessionId, isCurrent: { [weak context, weak account] in
            account != nil && context?.account.session === account
        })
    }

    private func makeChatAttachments() -> ChatAttachmentImages {
        ChatAttachmentImages(
            pictures: account.attachmentPictures, placeholders: context.account.pictures(for: account.keys.anonID),
            sessionId: chatId, load: services.attachment
        )
    }

    /// Apply the background projection once the views exist. Observations
    /// start from it and change nothing while the store agrees.
    private func seed(_ seed: ChatServices.Seed) {
        seededSession = seed.session
        seededCheckout = .some(seed.checkout)
        // The header was set up before, unseeded: its checkout is observed
        // again, from the seed.
        checkoutObservation?.cancel()
        checkoutObservation = nil
        checkoutSessionId = nil
        sessionChanged(seed.session)
        updateTabStrip()
    }

    /// The session's record, and its rows worked out off the main thread,
    /// for `chatId`: a pipeline of its own for each chat the screen shows,
    /// starting from an empty list and the newest page. Run again when a
    /// pending chat becomes its session, after `endChat`.
    private func observeChat() {
        let generation = chatGeneration
        let chatId = self.chatId
        let seeded = seededSession
        seededSession = nil
        observation = services.observeSession(seeded) { [weak self] state in
            guard let self, self.chatGeneration == generation else { return }
            self.sessionUpdates += 1
            self.sessionChanged(state)
        }
        let planner = self.planner
        let render = RenderServices(account)
        let rows = ApplyPipeline<ChatRowsInput, ChatRowsApplied, ChatRowsUpdate>(
            input: ChatRowsInput(session: session, render: render),
            state: ChatRowsApplied(),
            derive: { input, applied in ChatRows.derive(input, applied: applied, planner: planner) },
            apply: { [weak self] update in
                // Rows worked out for a chat the screen has left, or under an
                // account that is no longer the open one or is stopping (its
                // code drawn plain, its diffs empty), never land.
                guard let self, self.chatGeneration == generation, self.chatId == chatId,
                      self.context.account.session === self.account, !render.isClosed,
                      self.words.language == AppLocalization.language else { return false }
                return self.applyRows(update)
            }
        )
        // Code blocks still being coloured are drawn again when colour comes
        // in. Subscribed before the first rows are planned, so no signal
        // falls between a block's plain answer and the subscription.
        rows.follow(render.codeSyntax.completions()) { input, _ in input.recolour += 1 }
        rows.follow(services.feed.snapshots(sessionId: chatId)) { $0.snapshot = $1 }
        self.rows = rows
        rowsObservation = rows.observation
        pageHistory()
    }

    /// Opens the chat's history: its newest page once, older pages as the
    /// reader nears the oldest row, EmptyMessages' own paging, and Retry
    /// and Load more. A stand-in has no history until it is its session.
    private func pageHistory() {
        guard !PendingChats.isPendingChatId(chatId), !isFixture else { return }
        let generation = chatGeneration
        let pager = ChatHistoryPager(sessionId: chatId, history: account.chatHistory)
        pager.list = { [weak self] in self?.historyList }
        pager.onGrowWindow = { [weak self] in
            guard let self, self.chatGeneration == generation else { return }
            self.growWindow()
        }
        pager.onChange = { [weak self] in
            guard let self, self.chatGeneration == generation, self.context.account.session === self.account else { return }
            self.updatePlaceholder()
            self.updateOlderEnd()
        }
        pager.isActive = view.window != nil
        historyPager = pager
        pager.start()
    }

    /// The list as the history's paging reads it.
    private var historyList: ChatHistoryPager.List {
        ChatHistoryPager.List(
            laidOut: list.bounds.height > 0 && list.measuredWidth > 0,
            nearOldest: oldestDistance < list.bounds.height,
            windowCanGrow: !reachesOldest,
            // Until the grown window has rendered, not just been asked for.
            growthPending: windowRequests.grows != appliedGrows,
            oldestBoundary: oldestBoundary
        )
    }

    private func updateOlderEnd() {
        list.olderEnd.status = historyPager?.olderStatus(windowReachesOldest: reachesOldest) ?? .idle
    }

    /// EmptyMessages' Retry and Load more are older fetches; the loading
    /// placeholder's Retry asks for the newest page again.
    private func placeholderAction() {
        guard let historyPager else { return }
        if placeholder.content == .loadFailed {
            historyPager.retryFirstLoad()
        } else {
            historyPager.olderAction()
        }
    }

    /// Stops everything that reads the chat the screen is leaving, on the
    /// main thread and before `chatId` moves, and forgets what the reader
    /// did in it: the next chat's pipeline starts from nothing. The checkout
    /// is kept on screen until the new observation answers; the header's git
    /// status follows `headerSessionId` by itself.
    private func endChat() {
        chatGeneration += 1
        historyPager?.stop()
        historyPager = nil
        oldestDistance = .greatestFiniteMagnitude
        oldestBoundary = nil
        list.olderEnd.status = .idle
        observation?.cancel()
        observation = nil
        rowsObservation?.cancel()
        rowsObservation = nil
        rows = nil
        checkoutObservation?.cancel()
        checkoutObservation = nil
        checkoutSessionId = nil
        graceTask.task?.cancel()
        graceEnd = nil
        copiedTask.task?.cancel()
        copiedMessageId = nil
        facts = nil
        sentRowsView = ChatRowsView()
        windowRequests = ChatWindowRequests()
        appliedGrows = 0
        reachesOldest = false
        permissionBusy = [:]
        expandedTools = []
        diffExpanded = [:]
        pin = nil
        pins = 0
        graceTick = 0
        questionForms = [:]
        questionDrafts = [:]
        questionsToDismiss = [:]
        mermaidHeights = [:]
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if contentInstalled { keepStripOffset() }
        // Screens pushed from here, and the one under it, have their bar.
        if hidesHeader, navigationController?.topViewController !== self {
            navigationController?.setNavigationBarHidden(false, animated: animated)
        }
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard contentInstalled else { return }
        updateHeaderVisibility(animated: false)
        layoutScreen()
        updatePermissionListMaxHeight()
        if list.bounds.width != sentRowsView.width || list.traitCollection.textEnvironment != sentRowsView.text.environment {
            scheduleMeasure()
        }
    }

    private var maxContentWidth: CGFloat {
        ContentWidth.maxWidth // Tablet (HappyUI/Tablet): layout.ts maxWidth, was 800 by size class.
    }

    private func layoutScreen() {
        let size = view.bounds.size
        let composerHeight = composer.composerHeight(fitting: size.width)
        // Restored while answering: it shows in this frame.
        composerReveal.heightRead()
        let screen = ChatScreenLayout(.init(
            size: size,
            safeArea: LayoutInsets(view.safeAreaInsets),
            // The guide's top is the safe area's bottom while the keyboard
            // is down, and the layout never goes below that.
            keyboardTop: keyboardTracker.frame.minY,
            accessories: dockBars.map { $0.inset ? .inset($0.measurable) : .fullWidth($0.measurable) },
            composerHeight: composerHeight,
            composerCardOffset: composer.cardOffset,
            maxContentWidth: maxContentWidth,
            // TabletBranches: chatFloatingDock and chatInputPaddingH.
            docked: isTabletLayout,
            accessoryPaddingH: isTabletLayout ? TabletBranches.Metrics.tabletInputPaddingH : TabletBranches.Metrics.phoneInputPaddingH,
            hidesHeader: hidesHeader,
            headerAccessory: tabStrip.isHidden ? 0 : WorktreeTabStripLayout.Metrics.height
        ))
        list.setLayoutFrame(screen.list)
        list.setEdgeInsets(newest: screen.newestEdgeInset, oldest: screen.oldestEdgeInset)
        headerScrim.setLayoutFrame(screen.headerScrim)
        if let frame = screen.headerAccessory, !tabStrip.isHidden {
            tabStrip.maxWidth = ContentWidth.headerMaxWidth
            tabStrip.setLayoutFrame(frame)
        }
        if !cliWarning.isHidden, let label = cliWarning.label(width: size.width) {
            cliWarning.place(CliWarningPillLayout(width: size.width, top: screen.headerBottom, label: label))
        }
        // Loading the session and the deleted state take the whole screen;
        // an empty chat sits between the bar and the dock.
        placeholder.setLayoutFrame(dock.isHidden ? view.bounds : screen.placeholder)
        titleView.maxWidth = ChatHeaderTitleLayout.maxWidth(headerWidth: size.width)
        plainTitleView.maxWidth = ContentWidth.headerMaxWidth
        dock.setLayoutFrame(screen.dock)
        for (bar, frame) in zip(dockBars, screen.accessories) { bar.view.setLayoutFrame(frame) }
        composer.setLayoutFrame(screen.composer)
        composerReveal.layout(composerFrame: screen.composer)
        scrollButton.setLayoutFrame(screen.scrollButton)
        scrim.setLayoutFrame(screen.scrim)
        if let back = screen.backButton { landscapeBack.setLayoutFrame(back) }
        if let strip = screen.statusBarShadow { statusBarStrip.setLayoutFrame(strip) }
    }

    /// TabletBranches' `chatFloatingDock`: only the portrait phone floats
    /// the dock over the list, with the fades behind the bar and the dock
    /// and the bars above the composer that hide while the reader is back.
    private var floatingDock: Bool {
        !isTabletLayout && !hidesHeader
    }

    /// TabletBranches' `chatHidesHeaderInLandscape`, as the window is now.
    /// Only the screen on top owns the bar; the ones pushed from here get it
    /// back in `viewWillDisappear`.
    private func updateHeaderVisibility(animated: Bool) {
        let hides = tabletBranches.chatHidesHeaderInLandscape
        if let navigation = navigationController, navigation.topViewController === self, navigation.isNavigationBarHidden != hides {
            navigation.setNavigationBarHidden(hides, animated: animated)
        }
        guard hides != hidesHeader else { return }
        hidesHeader = hides
        landscapeBack.isHidden = !hides
        statusBarStrip.isHidden = !hides
        updateTabStrip()
        floatingDockChanged()
        updateCliWarning()
        view.setNeedsLayout()
    }

    /// The fades come and go with the floating dock, and the bars above the
    /// composer always show without it.
    private func floatingDockChanged() {
        guard contentInstalled else { return }
        headerScrim.isHidden = !floatingDock
        scrim.isHidden = !floatingDock || dock.isHidden
        if !floatingDock && !dockDetailsVisible { setDockDetailsVisible(true) }
    }

    /// SessionView's `router.back()`.
    @objc private func goBack() {
        navigationController?.popViewController(animated: true)
    }

    // MARK: Data

    private func sessionChanged(_ state: ChatSessionState) {
        session = state
        sessionApplied = true
        rows?.update { $0.session = state }
        updateHeader()
        updateCliWarning()
        updatePlaceholder()
        updateDockBars()
        updateComposer()
        scheduleMeasure()
        opening?.check()
    }

    // MARK: Header

    /// ChatHeaderView over a transparent bar: the system back button, the
    /// title capsule, the avatar; the scrim is the screen's own.
    private func setUpHeader() {
        avatarControl.pictures = account.avatarPictures
        avatarControl.isHidden = true
        // ChatHeaderView's text scales; the bar and its controls don't. The
        // bar holds its title view's own text size to XXL, so the header is
        // handed the screen's.
        titleView.traitOverrides.followsTextSize = true
        plainTitleView.traitOverrides.followsTextSize = true
        updateHeaderText()
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.updateHeaderText()
        }
        titleView.onPlanned = { [weak self] in self?.headerPlanned() }
        plainTitleView.onPlanned = { [weak self] in self?.headerPlanned() }
        titleView.addTarget(self, action: #selector(openInfo), for: .touchUpInside)
        plainTitleView.addTarget(self, action: #selector(openInfo), for: .touchUpInside)
        avatarControl.addTarget(self, action: #selector(openInfo), for: .touchUpInside)
        if #available(iOS 26.0, *) {
            // The control is its own glass.
            avatarItem.hidesSharedBackground = true
        }
        applyHeaderBranch()
    }

    private func headerPlanned() {
        navigationItem.titleView = isTabletLayout ? plainTitleView : titleView
        opening?.check()
    }

    /// ChatHeaderView's `glassEnabled` and SessionView's `headerRight`
    /// (`TabletBranches`): a phone's glass capsule and avatar over the
    /// scrim, or a tablet's opaque bar (`header.background`) with the plain
    /// title and no avatar. The back button is `dropsBackButtonOnTablet`'s.
    private func applyHeaderBranch() {
        let tablet = isTabletLayout
        configureHeaderAppearance()
        if sessionApplied { navigationItem.titleView = tablet ? plainTitleView : titleView }
        var items = tablet ? [] : [avatarItem]
        #if DEBUG
        items.append(fixturesMenu())
        #endif
        navigationItem.rightBarButtonItems = items
        if contentInstalled { tabStrip.glass = !tablet } // TabletBranches.worktreeStripGlass
        floatingDockChanged()
    }

    /// The shell uses the chat's bar style from its first frame, before
    /// any glass controls or text plans exist.
    private func configureHeaderAppearance() {
        let appearance = UINavigationBarAppearance()
        if isTabletLayout {
            appearance.configureWithOpaqueBackground()
            appearance.backgroundColor = UIColor(Palette.headerBackground)
            appearance.shadowColor = .clear
        } else {
            appearance.configureWithTransparentBackground()
        }
        appearance.titleTextAttributes = TextStyles.headerTitle.attributes(color: UIColor(Palette.headerTint))
        navigationItem.standardAppearance = appearance
        navigationItem.scrollEdgeAppearance = appearance
        navigationItem.compactAppearance = appearance
        navigationItem.compactScrollEdgeAppearance = appearance

    }

    /// The header's text at the screen's text size (`ChatHeaderTitleView.text`).
    /// The controller's own traits: in its trait change its view's are
    /// still the old ones.
    private func updateHeaderText() {
        let text = TextEnvironment(traitCollection)
        titleView.text = text
        plainTitleView.text = text
    }

    private func updateHeader() {
        updateCheckoutObservation()
        updateGitObservation()
        // A chat that doesn't exist yet can't speak for its checkout: the
        // header reads the chat it was started beside until it can, and
        // a stand-in's title is "New chat" for as long as it stands.
        let pending = PendingChats.isPendingChatId(sessionId)
        let headerRecord = session.record ?? (pending ? anchorRecord : nil)
        var model = ChatHeaderModel(session: headerRecord, dataReady: session.dataReady || isFixture, gitStatus: gitStatus, pending: pending && headerRecord == nil)
        if pending, model.title != .loading { model.title = .name(nil) }
        var title = switch model.title {
        case .loading: ""
        case .deleted: Strings.SessionDetail.sessionDeleted
        case .name(let name): name ?? Strings.Session.newChat
        }
        var subtitle = model.subtitle
        // Grouped by project the header names the checkout, and says how
        // many tabs the strip under it holds.
        if let checkout {
            title = checkout.workspaceName ?? model.subtitle ?? checkout.projectName
            subtitle = Strings.Chat.worktreeTabs(stripTabs(checkout).count)
        }
        navigationItem.title = title
        titleView.update(title: title, subtitle: subtitle, changes: model.changes)
        titleView.isEnabled = session.record != nil
        titleView.sizeToFit()
        plainTitleView.update(title: title, subtitle: subtitle, changes: model.changes)
        plainTitleView.isEnabled = session.record != nil

        let settings = session.settings
        avatarControl.isHidden = session.record == nil
        avatarControl.accessibilityLabel = title
        if let record = session.record {
            let metadata = record.metadata
            avatarControl.content = AvatarView.Content(
                avatar: SessionAvatar(
                    seed: record.avatarSeed,
                    isBot: record.isBot,
                    harness: settings.bool("showHarnessIconInSessionHeader")
                        ? SessionAvatar.harness(flavor: metadata?["flavor"]?.stringValue, clientId: metadata?["client"]?["id"]?.stringValue)
                        : nil,
                    image: session.avatarImage
                ),
                style: settings.avatarStyle,
                monochrome: !model.connected || settings.avatarMonochrome
            )
        }
    }

    // MARK: Worktree tabs

    /// The chat the header speaks for: this one once it exists, the one a
    /// chat being opened was started beside until then.
    private var headerSessionId: String {
        session.record != nil ? chatId : pendingChat?.anchorSessionId ?? chatId
    }

    /// The chip that stands for the open chat: the stand-in while the chat
    /// is unnamed, its session from the moment it is not.
    private var selectedTabId: String {
        pendingChat?.sessionId ?? sessionId
    }

    /// The header's git status: the checkout of the chat it speaks for.
    private func updateGitObservation() {
        guard let git = services.gitStatus else { return }
        let id = headerSessionId
        guard id != gitSessionId else { return }
        gitSessionId = id
        gitStatus = nil
        gitTask.task = Task { [weak self] in
            for await status in await git.observe(sessionId: id) {
                guard let self, !Task.isCancelled else { return }
                self.gitStatus = status
                self.updateHeader()
            }
        }
        Task { await git.refresh(sessionId: id) }
    }

    private func updateCheckoutObservation() {
        let id = headerSessionId
        guard id != checkoutSessionId else { return }
        checkoutSessionId = id
        // The seed is this chat's own checkout.
        let seeded = id == sessionId ? seededCheckout : nil
        seededCheckout = nil
        if let seeded {
            checkout = seeded
            checkoutApplied = true
        }
        checkoutObservation = services.observeCheckout(id, seeded) { [weak self] checkout in
            guard let self else { return }
            self.checkout = checkout
            self.checkoutApplied = true
            self.updateHeader()
            self.updateTabStrip()
            self.opening?.check()
        }
    }

    /// `resolveWorktreeTabs`: the checkout's chats, then the ones still
    /// being opened beside them, each chat once.
    private func stripTabs(_ checkout: WorktreeCheckout) -> [ChatWorktreeTabStrip.Item] {
        let pending = WorktreeTabs.pendingBeside(pendingChats, tabIds: checkout.tabs.map(\.id))
        let resolved = WorktreeTabs.resolve(tabs: checkout.tabs, pending: pending)
        return resolved.tabs.map { tab in
            ChatWorktreeTabStrip.Item(
                id: tab.id, title: tab.title ?? Strings.Session.newChat, shimmers: tab.working,
                blocked: tab.blocked, unread: tab.unread, pending: false
            )
        } + resolved.pending.map { chat in
            ChatWorktreeTabStrip.Item(id: chat.id, title: Strings.Session.newChat, shimmers: true, blocked: false, unread: false, pending: true)
        }
    }

    /// SessionView's `showTabStrip`, inside the header, so not on a phone
    /// held sideways.
    private func updateTabStrip() {
        let shown = checkout != nil && !hidesHeader
        if let checkout {
            if tabStrip.isHidden, shown {
                tabStrip.restore(offset: inheritedStripOffset ?? Self.stripOffsets(account)[checkout.id] ?? 0)
                inheritedStripOffset = nil
            }
            tabStrip.update(items: stripTabs(checkout), selectedId: selectedTabId)
        }
        guard shown == tabStrip.isHidden else { return }
        tabStrip.isHidden = !shown
        view.setNeedsLayout()
        // In place at once, so no animation that runs next (the composer
        // growing, a bar) carries it in from nothing.
        if isShown { UIView.performWithoutAnimation { view.layoutIfNeeded() } }
    }

    /// Switching swaps the chat in place rather than pushing a screen, so
    /// back still returns to the list.
    private func selectTab(_ id: String) {
        guard id != sessionId, id != selectedTabId else { return }
        switchChat(to: id)
    }

    /// Replace the tab immediately, then prepare its content with the
    /// same cancellable construction used by a push.
    private func switchChat(to id: String) {
        guard let navigation = navigationController, navigation.viewControllers.contains(self) else { return }
        keepStripOffset()
        let next = ChatViewController(context: context, session: account, sessionId: id)
        next.inheritedStripOffset = tabStrip.isHidden ? nil : tabStrip.offset
        TabletRoutes.record(.session(id: id), for: next)
        guard let index = navigation.viewControllers.firstIndex(of: self) else { return }
        var stack = navigation.viewControllers
        stack[index] = next
        navigation.setViewControllers(stack, animated: false)
    }

    /// Archiving the open tab moves the screen to its neighbour first, the
    /// tab to its left, so the chat is never seen coming apart; with no tab
    /// left the screen goes back.
    private func tabArchiving(_ archivedId: String) {
        guard let checkout, archivedId == selectedTabId else { return }
        let pending = WorktreeTabs.pendingBeside(pendingChats, tabIds: checkout.tabs.map(\.id))
        let tabs = WorktreeTabs.resolve(tabs: checkout.tabs, pending: pending).tabs
        if let neighbour = WorktreeTabs.neighbour(of: archivedId, in: tabs) {
            switchChat(to: neighbour)
        } else {
            navigationController?.popViewController(animated: true)
        }
    }

    /// Where each checkout's strip was last scrolled to, per account, so a
    /// screen on the same checkout comes back where the finger left it.
    private final class StripOffsets {
        var offsets: [String: CGFloat] = [:]
    }

    private static let stripOffsetTable = NSMapTable<AccountSession, StripOffsets>.weakToStrongObjects()

    private static func stripOffsets(_ account: AccountSession) -> [String: CGFloat] {
        stripOffsetTable.object(forKey: account)?.offsets ?? [:]
    }

    /// The strip's measured names, per account.
    private static let tabNameTable = NSMapTable<AccountSession, WorktreeTabNames>.weakToStrongObjects()

    private static func tabNames(_ account: AccountSession) -> WorktreeTabNames {
        if let names = tabNameTable.object(forKey: account) { return names }
        let names = WorktreeTabNames()
        tabNameTable.setObject(names, forKey: account)
        return names
    }

    private func keepStripOffset() {
        guard let checkout, !tabStrip.isHidden else { return }
        let table = Self.stripOffsetTable.object(forKey: account) ?? StripOffsets()
        table.offsets[checkout.id] = tabStrip.offset
        Self.stripOffsetTable.setObject(table, forKey: account)
    }

    /// Not on a phone held sideways (TabletBranches' `chatShowsCliWarning`).
    private func updateCliWarning() {
        let warning = CliVersionWarning(metadata: session.metadata, acknowledged: acknowledgedCliVersions)
        cliWarning.warning = warning
        let hidden = warning == nil || hidesHeader
        guard hidden != cliWarning.isHidden else { return }
        cliWarning.isHidden = hidden
        view.setNeedsLayout()
    }

    @objc private func dismissCliWarning() {
        guard let acknowledged = cliWarning.warning?.dismissed(in: acknowledgedCliVersions) else { return }
        acknowledgedCliVersions = acknowledged
        context.account.localSettings.acknowledgedCliVersions = acknowledged
        updateCliWarning()
    }

    /// `Math.min(260, Math.round(windowHeight * 0.35))`, as the window is now.
    private func updatePermissionListMaxHeight() {
        guard let window = view.window else { return }
        let height = PermissionFooterLayout.maxListHeight(windowHeight: window.bounds.height)
        guard height != permissionListMaxHeight else { return }
        permissionListMaxHeight = height
        scheduleMeasure()
    }

    /// The window crossed the tablet width: rows plan their tablet
    /// branches again.
    private func tabletLayoutChanged() {
        let tablet = traitCollection.isTabletLayout
        guard tablet != isTabletLayout else { return }
        isTabletLayout = tablet
        applyHeaderBranch()
        view.setNeedsLayout()
        scheduleMeasure()
    }

    @objc private func openInfo() {
        guard session.record != nil else { return }
        push(.sessionInfo(id: chatId), context: context)
    }

    private var isPendingChat: Bool {
        PendingChats.isPendingChatId(sessionId) && session.record == nil
    }

    private func pendingChatChanged(_ chat: PendingChat?) {
        guard chat != pendingChat else { return }
        if chat?.anchorSessionId != pendingChat?.anchorSessionId {
            anchorMetadata = nil
            anchorRecord = nil
            anchorObservation = chat.map { chat in
                services.observeOtherSession(chat.anchorSessionId) { [weak self] state in
                    guard let self, state.record != self.anchorRecord else { return }
                    self.anchorRecord = state.record
                    self.anchorMetadata = state.metadata
                    self.updateHeader()
                    self.updatePlaceholder()
                }
            }
        }
        pendingChat = chat
        if let real = chat?.sessionId, real != chatId {
            becomeChat(real)
        }
        updateHeader()
        updatePlaceholder()
        // The start isn't coming. It has said why, and the writing went back
        // to the chat this was opened beside, which is where the screen goes.
        if let chat, chat.status == .failed, chat.sessionId == nil {
            switchChat(to: chat.anchorSessionId)
        }
    }

    /// The machine answered: the screen becomes the chat in place. The
    /// composer is the same one, retargeted, so its text, caret and keyboard
    /// carry across (SessionView keeps it mounted through the arrival); only
    /// what it reads and sends moves to the session. The handover has written
    /// the session's draft before the record named it.
    ///
    /// The stand-in's list is empty (nothing is stored under its id), so the
    /// new chat's first rows install whole, as on a screen just opened.
    private func becomeChat(_ real: String) {
        endChat()
        chatId = real
        services = Self.services(account: account, context: context, sessionId: real)
        chatAttachments = makeChatAttachments()
        composer.retarget(ChatComposerEnvironment(sessionId: real, account: account, sender: services.sender, controls: services.controls))
        observeChat()
        scheduleMeasure()
        if view.window != nil {
            // A store write: never on the main thread.
            let actions = account.actions
            Task.detached(priority: .userInitiated) { actions.markRead(sessionId: real) }
            account.spawnRequests.release(sessionId: real)
        }
    }

    /// The strip's `+`: a sibling chat, started where the open one runs and
    /// configured like it. Its tab and screen are the person's on the press;
    /// the start runs underneath, behind any other.
    private func newTab() {
        guard let checkout, let openId = session.record?.id ?? pendingChat?.anchorSessionId,
              let launcher = ChatPendingStarts.of(account, context: context)?.launcher else { return }
        let known = checkout.tabs.map(\.id)
        Task { [weak self] in
            let chat = await launcher.open(anchorSessionId: openId, knownSessionIds: known)
            self?.selectTab(chat.id)
        }
    }

    private var isFixture: Bool {
        #if DEBUG || HAPPY_FIXTURES
        FixtureScenarios.isFixture(sessionId)
        #else
        false
        #endif
    }

    /// SessionView's states around the conversation: a spinner until
    /// sessions have been fetched, the deleted state once they have and
    /// this one is gone; in a session, a spinner until its messages are in
    /// and EmptyMessages if there are none.
    private func updatePlaceholder() {
        let content: ChatPlaceholderView.Content?
        var fullScreen = false
        if let record = session.record {
            if let facts, !facts.isEmpty {
                content = nil
            } else if facts?.isLoaded == true {
                content = .empty(
                    ChatEmptyState(metadata: record.metadata, createdAt: record.createdAt, now: Int64(Date().timeIntervalSince1970 * 1000)),
                    historyPager?.emptyStatus ?? .noMessages
                )
            } else {
                content = historyPager?.firstLoadFailed == true ? .loadFailed : .loading
            }
        } else if isPendingChat {
            // The composer stays: it is the one thing on this screen that
            // survives the chat's arrival.
            content = pendingChat.map { .pendingChat(PendingChatPlaceholderModel(queued: $0.queued, anchorMetadata: anchorMetadata)) } ?? .loading
        } else {
            content = session.dataReady ? .deleted : .loading
            fullScreen = true
        }
        if let content { placeholder.show(content) }
        placeholder.isHidden = content == nil
        list.isHidden = fullScreen
        if dock.isHidden != fullScreen {
            dock.isHidden = fullScreen
            scrim.isHidden = fullScreen || !floatingDock
            view.setNeedsLayout()
        }
    }

    /// The bars shown above the composer, in order, with their heights.
    private var dockBars: [(view: UIView, measurable: Measurable, inset: Bool)] {
        var bars: [(view: UIView, measurable: Measurable, inset: Bool)] = []
        if !inactiveHint.isHidden { bars.append((inactiveHint, inactiveHint.barMeasurable, true)) }
        if !goalBar.isHidden { bars.append((goalBar, goalBar.barMeasurable, true)) }
        if !questionBanner.isHidden { bars.append((questionBanner, questionBanner.bannerMeasurable, true)) }
        if !rigActivity.isHidden { bars.append((rigActivity, rigActivity.barMeasurable, false)) }
        return bars
    }

    /// SessionView's input stack: InactiveArchivedHint, AgentGoalBar,
    /// AgentQuestionBanner and RigActivityBar. A bar that comes or goes moves
    /// the composer with an animation; while the reader is scrolled back they
    /// stay faded.
    private func updateDockBars() {
        let before = dockBars.map { $0.view }
        let hint = InactiveSessionHint(session: session.record, machine: session.machine)
        if let hint {
            inactiveHint.show(hint, resuming: resuming)
        }
        inactiveHint.isHidden = hint == nil
        let goal = session.record.flatMap(VisibleAgentGoal.init)
        if let goal {
            goalBar.show(goal, inFlight: goalInFlight)
        }
        goalBar.isHidden = goal == nil
        updateQuestionBanner()
        let indicators = RigActivityIndicator.indicators(session.metadata)
        rigActivity.show(indicators)
        rigActivity.isHidden = indicators.isEmpty

        let bars = dockBars
        for bar in bars { bar.view.alpha = dockDetailsVisible ? 1 : 0 }
        // Contents can change a bar's height without it coming or going.
        guard bars.map({ $0.view }) != before || !bars.isEmpty else { return }
        view.setNeedsLayout()
        if isViewLoaded && isShown {
            UIView.animate(withDuration: 0.25, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
                self.view.layoutIfNeeded()
            }
        }
    }

    /// A bar's plan came in: the dock takes the bars' heights again, moving
    /// the composer as a bar coming or going does. A bar is measured off
    /// main, so one that just came, or a new text size, shows once its plan
    /// is in.
    private func dockBarMeasured() {
        view.setNeedsLayout()
        opening?.check()
        guard isViewLoaded, isShown else { return }
        UIView.animate(withDuration: 0.25, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
            self.view.layoutIfNeeded()
        }
    }

    /// AgentQuestionBanner: the first request the chat can't show inline.
    /// An answer from another device closes the sheet here too.
    private func updateQuestionBanner() {
        let pending = AgentCommunications.pending(session.agentState)
        let fallback = pending.first(where: AgentCommunications.usesFallback)
        if let sheet = questionSheet, !pending.contains(where: { $0.id == sheet.pending.id }) {
            sheet.dismiss(animated: true)
        }
        if let fallback {
            questionBanner.show(fallback)
        }
        questionBanner.isHidden = fallback == nil
    }

    /// agentGoalActionHandler.ts: Edit asks for the new goal first; the
    /// button spins until the request is done.
    private func performGoalAction(_ action: SessionGoalAction) {
        guard goalInFlight == nil, let current = goalBar.goal?.text else { return }
        let goalAction = services.goalAction
        Task { [weak self] in
            var edited: String?
            if action == .edit {
                guard let self else { return }
                edited = await DetailAlerts.prompt(
                    Strings.AgentGoal.editGoal, nil,
                    defaultValue: current,
                    placeholder: Strings.AgentGoal.currentGoal,
                    confirmTitle: Strings.Common.save,
                    on: self
                )
            }
            guard let dispatch = VisibleAgentGoal.dispatch(action, current: current, edited: edited), let self else { return }
            self.goalInFlight = action
            self.updateDockBars()
            // Failures are only logged in happy-app; the bar stays as it was.
            try? await goalAction(dispatch.action, dispatch.objective)
            self.goalInFlight = nil
            self.updateDockBars()
        }
    }

    /// useSessionQuickActions' performResume: one at a time, spinning until
    /// it is done; a failure is an alert. The session reconnects under its
    /// own id, so the hint just goes once it is back.
    private func resume() {
        guard !resuming, let record = session.record else { return }
        let resume = services.resume
        let machine = session.machine
        resuming = true
        updateDockBars()
        Task { [weak self] in
            do {
                let opened = try await resume(record, machine)
                if let self, let opened, opened != self.chatId {
                    self.push(.session(id: opened), context: self.context)
                }
            } catch {
                if let self { DetailActionAlert.show(error, on: self) }
            }
            self?.resuming = false
            self?.updateDockBars()
        }
    }

    private func openQuestionSheet() {
        guard let pending = questionBanner.pending, case .form = pending.kind, presentedViewController == nil else { return }
        let controls = services.controls
        let sessionId = self.chatId
        let sheet = AgentQuestionSheetController(
            pending: pending,
            submit: { answers in
                try await controls.answerQuestion(sessionId: sessionId, id: pending.id, answers: answers, kind: pending.rawKind)
            },
            cancel: {
                // The agent asks again if the dismissal never lands.
                try? await controls.cancelQuestion(sessionId: sessionId, id: pending.id, kind: pending.rawKind)
            }
        )
        questionSheet = sheet
        present(sheet, animated: true)
    }

    private func dismissUnsupportedRequest() {
        guard let pending = questionBanner.pending else { return }
        let controls = services.controls
        let sessionId = self.chatId
        Task { try? await controls.cancelQuestion(sessionId: sessionId, id: pending.id, kind: pending.rawKind) }
    }

    private func updateComposer() {
        composer.update(ChatComposerState(
            session: session,
            usage: facts?.usage,
            delivery: facts?.delivery ?? [:],
            isLoaded: facts?.isLoaded ?? false,
            hasPendingQuestion: facts?.hasPendingQuestion ?? false
        ))
    }

    /// Applies what the rows' derivation worked out. Refused when the list
    /// was planned for another width, layout or text size: the next pass
    /// has the new one.
    private func applyRows(_ update: ChatRowsUpdate) -> Bool {
        if update.list != nil,
           update.width != list.bounds.width || update.tablet != isTabletLayout || update.text != list.traitCollection.textEnvironment {
            return false
        }
        ApplyPerf.measure(.chatList) {
            var touched = 0
            var windowReset = false
            if let facts = update.facts {
                // Before the placeholder reads its status.
                windowReset = historyPager?.receive(.init(facts)) ?? false
                self.facts = facts
                dismissAnsweredQuestions(facts)
                updatePlaceholder()
                updateComposer()
            }
            if let forms = update.questionForms { questionForms = forms }
            scheduleGraceEnd(update.graceEnd, now: update.now)
            // Before the list, which reports its scroll position as it
            // applies, and may ask for the next page.
            appliedGrows = update.grows
            reachesOldest = update.reachesOldest
            if let rows = update.list {
                oldestBoundary = update.oldestBoundary
                touched += list.apply(rows, animated: rowsApplied)
                rowsApplied = true
            }
            if windowReset {
                // History W3: the window dropped rows it showed; it is back
                // at the newest, and so is the reader.
                list.scrollToNewest(animated: false)
            }
            updateOlderEnd()
            // Each settlement checks again, once its rows are in.
            if facts?.isLoaded == true { historyPager?.check() }
            return touched
        }
        opening?.check()
        return true
    }

    /// Measures again when the first waiting message's quiet spell ends,
    /// so its status shows.
    private func scheduleGraceEnd(_ end: Int64?, now: Int64) {
        guard end != graceEnd else { return }
        graceEnd = end
        graceTask.task?.cancel()
        guard let end else { return }
        graceTask.task = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(end - now))
            guard !Task.isCancelled, let self else { return }
            self.graceEnd = nil
            self.graceTick += 1
            self.scheduleMeasure()
        }
    }

    /// Hands what the main thread decides to the rows' derivation, if it
    /// changed: the list's width and layout, and what the reader did.
    private func scheduleMeasure() {
        guard let rows else { return }
        let view = ChatRowsView(
            width: list.bounds.width,
            maxContentWidth: maxContentWidth,
            tablet: isTabletLayout,
            text: ChatRowText(environment: list.traitCollection.textEnvironment, words: words),
            permissionListMaxHeight: permissionListMaxHeight,
            inForeground: inForeground,
            permissionBusy: permissionBusy,
            expandedTools: expandedTools,
            diffExpanded: diffExpanded,
            copiedMessageId: copiedMessageId,
            questionDrafts: questionDrafts,
            requests: windowRequests,
            pin: pin,
            pins: pins,
            tick: graceTick,
            mermaidHeights: mermaidHeights
        )
        guard view != sentRowsView else { return }
        sentRowsView = view
        rows.update { $0.view = view }
    }

    /// Adds a page of history once the reader is within a screen of it,
    /// one page at a time.
    private func growWindow() {
        guard !list.plans.isEmpty, !reachesOldest, windowRequests.grows == appliedGrows else { return }
        windowRequests.grows += 1
        scheduleMeasure()
    }

    // MARK: ChatListViewDelegate

    func chatList(_ list: ChatListView, didScroll distanceFromNewest: CGFloat, distanceFromOldest: CGFloat) {
        let backdrop = ChatScreenLayout.headerBackdropVisible(distanceFromOldest: distanceFromOldest)
        if backdrop != headerBackdropVisible {
            headerBackdropVisible = backdrop
            CATransaction.begin()
            CATransaction.setAnimationDuration(ChatHeaderScrim.fadeDuration)
            headerScrim.overlayOpacity = backdrop ? ChatHeaderScrim.underlapOpacity : ChatHeaderScrim.restingOpacity
            CATransaction.commit()
        }
        let showButton = ChatScreenLayout.showsScrollButton(distanceFromNewest: distanceFromNewest)
        if (scrollButton.alpha > 0) != showButton {
            UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
                self.scrollButton.alpha = showButton ? 1 : 0
            }
        }
        let details = !floatingDock || ChatScreenLayout.dockDetailsVisible(distanceFromNewest: distanceFromNewest, currentlyVisible: dockDetailsVisible)
        if details != dockDetailsVisible { setDockDetailsVisible(details) }
        oldestDistance = distanceFromOldest
        if let historyPager, facts?.isLoaded == true {
            historyPager.check()
        } else if distanceFromOldest < list.bounds.height {
            growWindow()
        }
    }

    /// The composer's status rows and the bars above it fade, but keep
    /// their space.
    private func setDockDetailsVisible(_ visible: Bool) {
        dockDetailsVisible = visible
        composer.setDetailsVisible(visible, animated: true)
        let bars = dockBars.map { $0.view }
        UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
            for bar in bars { bar.alpha = visible ? 1 : 0 }
        }
    }

    func chatList(_ list: ChatListView, perform action: ChatRowAction) {
        switch action {
        case .copyMessage(let id, let text):
            UIPasteboard.general.string = text
            // MessageCopyButton: a tick for 1.5 s.
            copiedMessageId = id
            copiedTask.task?.cancel()
            copiedTask.task = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(1500))
                guard !Task.isCancelled, let self else { return }
                self.copiedMessageId = nil
                self.scheduleMeasure()
            }
            scheduleMeasure()
        case .toggleGroup(let id):
            windowRequests.toggles.append(id)
            scheduleMeasure()
        case .toggleTool(let id):
            if expandedTools.remove(id) == nil { expandedTools.insert(id) }
            pin = id
            pins += 1
            scheduleMeasure()
        case .openMessage(let messageId):
            push(.sessionMessage(id: chatId, messageId: messageId), context: context)
        case .openMessageFile(let messageId, let file):
            push(.sessionMessage(id: chatId, messageId: messageId, file: file), context: context)
        case .openFile(let path):
            push(.sessionFile(id: chatId, path: path), context: context)
        case .permission(let tap):
            answer(tap)
        case .questionOption(let toolId, let questionId, let option):
            guard let form = questionForms[toolId]?.form, let question = form.questions.first(where: { $0.id == questionId }) else { return }
            var state = questionDrafts[toolId] ?? ChatQuestionState(form: form)
            guard state.canInteract, !state.submitting else { return }
            state.selections.toggle(question, option: option)
            questionDrafts[toolId] = state
            scheduleMeasure()
        case .questionSubmit(let toolId):
            submitQuestion(toolId)
        case .mermaidHeight(let row, let index, let height):
            // Planned again off the main thread, only if the box grows.
            guard let kept = MarkdownLayout.mermaidHeightToKeep(
                reported: height, kept: mermaidHeights[row]?[index], scale: traitCollection.displayScale
            ) else { return }
            mermaidHeights[row, default: [:]][index] = kept
            scheduleMeasure()
        case .diffShowMore(let toolId, let chunk, let file):
            diffExpanded[toolId, default: [:]][chunk, default: []].insert(file)
            pin = toolId
            pins += 1
            scheduleMeasure()
        case .option(let title):
            let sender = services.sender
            let sessionId = self.chatId
            Task { _ = try? await sender.send(OutgoingMessage(text: title), sessionId: sessionId) }
        case .retry(let localId):
            let sender = services.sender
            Task { try? await sender.retry(localId: localId) }
        case .copyMenu, .selectable, .markdownSelectable:
            // Long presses; see `chatList(_:hold:frame:at:)`.
            break
        }
    }

    func chatList(_ list: ChatListView, hold action: ChatRowAction, frame: CGRect, at point: CGPoint) {
        switch action {
        case .copyMenu(let text):
            ChatCopyMenu.present(copying: text, anchor: frame, in: list)
        case .selectable(let text):
            copyCallout.present(copying: text, at: point, in: list)
        case .markdownSelectable(let paragraph, let markdown):
            if context.account.localSettings.markdownCopyV2 {
                push(.textSelection(text: markdown), context: context)
            } else {
                copyCallout.present(copying: paragraph, at: point, in: list)
            }
        default:
            chatList(list, perform: action)
        }
    }

    func chatList(_ list: ChatListView, openLink url: String) {
        guard let url = URL(string: url) else { return }
        UIApplication.shared.open(url)
    }

    /// Sends a permission answer; the button pulses until it has gone.
    private func answer(_ tap: ChatPermissionTap) {
        guard permissionBusy[tap.permissionId] == nil else { return }
        permissionBusy[tap.permissionId] = tap.kind
        scheduleMeasure()
        let controls = services.controls
        let setPermissionMode = services.setPermissionMode
        let sessionId = self.chatId
        let reply = tap.reply
        Task { [weak self] in
            do {
                if reply.allow {
                    try await controls.allow(sessionId: sessionId, permissionId: tap.permissionId, mode: reply.mode, allowedTools: reply.allowedTools, decision: reply.decision, updatedInput: nil)
                } else {
                    try await controls.deny(sessionId: sessionId, permissionId: tap.permissionId, mode: reply.mode, allowedTools: reply.allowedTools, decision: reply.decision)
                }
                if let mode = reply.permissionMode { await setPermissionMode(mode) }
            } catch {
                // The buttons stay as they were, so the reader can try again.
            }
            guard let self else { return }
            self.permissionBusy[tap.permissionId] = nil
            self.scheduleMeasure()
        }
    }

    /// Sends a question form's answers. The summary shows at once; if the
    /// answer fails, the form comes back as it was.
    private func submitQuestion(_ toolId: String) {
        guard let entry = questionForms[toolId], let reply = entry.form.reply else { return }
        let (tool, form) = (entry.tool, entry.form)
        var state = questionDrafts[toolId] ?? ChatQuestionState(form: form)
        state.form = form
        guard state.canInteract, !state.submitting, state.selections.allAnswered(form.questions) else { return }
        let answers = state.selections.answers(form.questions)
        state.sent = answers
        state.submitting = true
        questionDrafts[toolId] = state
        scheduleMeasure()
        let controls = services.controls
        let sessionId = self.chatId
        Task { [weak self] in
            var failed = false
            do {
                switch reply {
                case .permission(let id):
                    let input = InlineQuestionForm.askUserQuestionInput(tool, answers: answers)
                    try await controls.allow(sessionId: sessionId, permissionId: id, mode: nil, allowedTools: nil, decision: .approved, updatedInput: input)
                case .communication(let id, let kind):
                    try await controls.answerQuestion(sessionId: sessionId, id: id, answers: InlineQuestionForm.communicationAnswers(form.questions, answers: answers), kind: kind)
                }
            } catch {
                failed = true
            }
            guard let self, var state = self.questionDrafts[toolId] else { return }
            state.submitting = false
            if failed { state.sent = nil }
            self.questionDrafts[toolId] = state
            self.scheduleMeasure()
        }
    }

    // MARK: ChatComposerDelegate

    /// Inside the composer's animation when its text grew or shrank; never
    /// animated before the screen's first frame.
    func composerDidInvalidateHeight(_ composer: any ChatComposerView) {
        view.setNeedsLayout()
        if isShown {
            view.layoutIfNeeded()
        } else {
            UIView.performWithoutAnimation { view.layoutIfNeeded() }
        }
    }

    func composerDidChangeFocus(_ composer: any ChatComposerView) {}

    /// The draft is restored: the composer shows at the height laid out
    /// for it, now. A report for the chat before a retarget isn't this
    /// one's.
    func composerDidRestore(_ composer: any ChatComposerView, generation: Int) {
        guard generation == composer.restoreGeneration else { return }
        view.layoutIfNeeded()
        composerReveal.restored(generation: generation)
        opening?.check()
    }

    func composer(_ composer: any ChatComposerView, didSend localId: String) {
        list.scrollToNewest(animated: true)
        // A message sent while the agent waits on questions answers them:
        // once it is delivered, the forms are dismissed (SessionView's
        // handleSend), so the agent reads the text as the reply.
        let pending = AgentCommunications.pending(session.agentState)
        if !pending.isEmpty {
            questionsToDismiss[localId] = pending
        }
    }

    private func dismissAnsweredQuestions(_ facts: ChatSnapshotFacts) {
        guard !questionsToDismiss.isEmpty else { return }
        let controls = services.controls
        let sessionId = self.chatId
        for (localId, communications) in questionsToDismiss {
            if case .failed = facts.delivery[localId] {
                questionsToDismiss[localId] = nil
                continue
            }
            let delivered = facts.delivery[localId] == nil && facts.storedLocalIds.contains(localId)
            guard delivered else { continue }
            questionsToDismiss[localId] = nil
            Task {
                for communication in communications {
                    try? await controls.cancelQuestion(sessionId: sessionId, id: communication.id, kind: communication.rawKind)
                }
            }
        }
    }

    // MARK: Actions

    @objc private func scrollToNewest() {
        list.scrollToNewest(animated: true)
    }

    @objc private func didEnterBackground() {
        inForeground = false
        // Coming back to an idle session should not land on a wall of
        // expanded tool calls.
        windowRequests.backgrounds += 1
        scheduleMeasure()
    }

    @objc private func willEnterForeground() {
        inForeground = true
        scheduleMeasure()
    }
}

extension ChatViewController: ChatAttachmentProviding {}

#if DEBUG
extension ChatViewController {
    /// Debug builds: open any fixture chat from any chat.
    private func fixturesMenu() -> UIBarButtonItem {
        let context = self.context
        let actions = FixtureScenario.allCases.map { scenario in
            UIAction(title: scenario.title) { [weak self] _ in
                self?.push(.session(id: FixtureScenarios.prefix + scenario.rawValue), context: context)
            }
        }
        return UIBarButtonItem(image: .icon(.ionicons("construct-outline"), size: 20), menu: UIMenu(title: "Fixture chats", children: actions))
    }
}
#endif

/// Cancels the feed when the screen goes away.
private final class TaskHolder {
    var task: Task<Void, Never>?

    deinit {
        task?.cancel()
    }
}

/// The fade behind the dock that lets messages scroll under it
/// (AgentContentView's LinearGradient).
final class ChatScrimView: UIView {
    override class var layerClass: AnyClass { CAGradientLayer.self }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        update()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.update()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func update() {
        guard let gradient = layer as? CAGradientLayer else { return }
        let dark = traitCollection.userInterfaceStyle == .dark
        let base: UIColor = dark ? .black : .white
        let stops: [CGFloat] = dark ? [0, 0.20, 0.66] : [0, 0.18, 0.74]
        gradient.colors = stops.map { base.withAlphaComponent($0).cgColor }
        gradient.locations = [0, 0.42, 1]
    }
}

/// ChatList's jump-to-newest button: a 32 pt circle with a hairline ring.
final class ChatScrollButton: UIControl {
    private let icon = UIImageView(image: .icon(.octicons("arrow-down"), size: 14))

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.surface).withAlphaComponent(0.9)
        layer.borderWidth = 1
        layer.shadowOffset = CGSize(width: 0, height: 1)
        layer.shadowRadius = 2
        layer.shadowOpacity = 0.1
        icon.tintColor = UIColor(Palette.text)
        icon.contentMode = .center
        addSubview(icon)
        accessibilityLabel = "Scroll to bottom"
        accessibilityTraits = .button
        updateColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.updateColors()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.cornerRadius = bounds.height / 2
        icon.setLayoutFrame(bounds)
    }

    override var isHighlighted: Bool {
        didSet { backgroundColor = UIColor(Palette.surface).withAlphaComponent(isHighlighted ? 0.7 : 0.9) }
    }

    private func updateColors() {
        layer.borderColor = UIColor(Palette.divider).resolvedColor(with: traitCollection).cgColor
        layer.shadowColor = UIColor(Palette.shadow).resolvedColor(with: traitCollection).cgColor
    }
}
#endif
