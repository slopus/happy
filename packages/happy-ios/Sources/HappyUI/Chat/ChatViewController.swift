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
    private let services: ChatServices

    private let list = ChatListView()
    private let scrim = ChatScrimView()
    private let headerScrim = HeaderScrimView()
    private let titleView = ChatHeaderTitleView()
    private let avatarControl = ChatHeaderAvatarControl()
    private lazy var avatarItem = UIBarButtonItem(customView: avatarControl)
    /// The title on a tablet, without glass.
    private let plainTitleView = ChatPlainHeaderTitleView()
    private let cliWarning = ChatCliWarningPill()
    /// SessionView's `hidesLandscapeHeader`: a phone held sideways drops the
    /// header for a floating back button and a strip behind the status bar.
    private var hidesHeader = false
    private let landscapeBack = ChatLandscapeBackButton()
    private let statusBarStrip = ChatStatusBarStrip()
    /// localSettings' `acknowledgedCliVersions`, read once.
    private lazy var acknowledgedCliVersions = context.account.localSettings.acknowledgedCliVersions
    /// The spinner, an empty chat's EmptyMessages, or the deleted state.
    private let placeholder = ChatPlaceholderView()
    private var headerBackdropVisible = false
    private let gitTask = TaskHolder()
    private var gitStatus: GitStatus?
    private let dock = ChatDockView()
    private let composer: any ChatComposerView
    /// The bars above the composer, top to bottom: how to bring back a
    /// session that has stopped, the goal, a request the chat can't show
    /// inline, what a Happy Agent session has running.
    private let inactiveHint = ChatInactiveHintView()
    private var resuming = false
    private let goalBar = ChatGoalBarView()
    private var goalInFlight: SessionGoalAction?
    private let questionBanner = ChatQuestionBannerView()
    private let rigActivity = ChatRigActivityView()
    /// The session's pictures, for the attachments in the list, kept with
    /// this account's.
    private(set) lazy var chatAttachments: ChatAttachmentImages? = ChatAttachmentImages(
        pictures: account.attachmentPictures, placeholders: context.account.pictures(for: account.keys.anonID),
        sessionId: sessionId, load: services.attachment
    )
    private weak var questionSheet: AgentQuestionSheetController?
    /// Questions a sent message answers instead, by the message's local
    /// id: dismissed once it is delivered.
    private var questionsToDismiss: [String: [PendingAgentCommunication]] = [:]
    private let scrollButton = ChatScrollButton()
    private let copyCallout = ChatCopyCallout()
    private let keyboardTracker = UIView()
    /// Measures each row once per input and width, for the pipeline.
    private let planner = RowPlanner<ChatRowInput, ChatRowPlan> { ChatRowRenderer.plan($0, width: $1) }
    private var rows: ApplyPipeline<ChatRowsInput, ChatRowsApplied, ChatRowsUpdate>?
    private var rowsObservation: ApplyObservation?
    /// What the rows were last asked for, so an unchanged layout pass asks
    /// for nothing.
    private var sentRowsView = ChatRowsView()
    /// The next time a waiting user message's status is due to show.
    private var graceEnd: Int64?
    private let graceTask = TaskHolder()
    /// The agent message whose copy button shows its tick.
    private var copiedMessageId: String?
    private let copiedTask = TaskHolder()
    private var observation: ApplyObservation?
    /// A `pending-chat:` screen's record, and the session it was started
    /// beside.
    private var pendingChat: PendingChat?
    private let pendingTask = TaskHolder()
    private var anchorMetadata: JSONValue?
    private var anchorObservation: ApplyObservation?

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

    init(context: AppContext, session account: AccountSession, sessionId: String) {
        self.context = context
        self.account = account
        self.sessionId = sessionId
        let services = ChatServices.make(account: account, sessionId: sessionId, isCurrent: { [weak context, weak account] in account != nil && context?.account.session === account })
        self.services = services
        composer = ChatComposerFactory.make(ChatComposerEnvironment(
            sessionId: sessionId, account: account, sender: services.sender, controls: services.controls
        ))
        super.init(nibName: nil, bundle: nil)
        hidesBottomBarWhenPushed = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        isTabletLayout = traitCollection.isTabletLayout
        view.backgroundColor = UIColor(Palette.surface)
        showsBackTitle()
        dropsBackButtonOnTablet() // Tablet (HappyUI/Tablet): ChatHeaderView.tsx
        navigationItem.largeTitleDisplayMode = .never
        setUpHeader()

        list.delegate = self
        view.addSubview(list)
        placeholder.isHidden = true
        view.addSubview(placeholder)
        headerScrim.overlayOpacity = ChatHeaderScrim.restingOpacity
        view.addSubview(headerScrim)
        cliWarning.isHidden = true
        cliWarning.addTarget(self, action: #selector(dismissCliWarning), for: .touchUpInside)
        view.addSubview(cliWarning)
        view.addSubview(scrim)
        registerForTraitChanges([TabletLayoutTrait.self]) { (self: Self, _) in
            self.tabletLayoutChanged()
        }
        composer.composerDelegate = self
        questionBanner.isHidden = true
        questionBanner.onOpen = { [weak self] in self?.openQuestionSheet() }
        questionBanner.onDismiss = { [weak self] in self?.dismissUnsupportedRequest() }
        inactiveHint.isHidden = true
        inactiveHint.onResume = { [weak self] in self?.resume() }
        goalBar.isHidden = true
        goalBar.onAction = { [weak self] action in self?.performGoalAction(action) }
        rigActivity.isHidden = true
        dock.addSubview(inactiveHint)
        dock.addSubview(goalBar)
        dock.addSubview(questionBanner)
        dock.addSubview(rigActivity)
        dock.addSubview(composer)
        view.addSubview(dock)
        scrollButton.alpha = 0
        scrollButton.addTarget(self, action: #selector(scrollToNewest), for: .touchUpInside)
        view.addSubview(scrollButton)
        statusBarStrip.isHidden = true
        view.addSubview(statusBarStrip)
        landscapeBack.isHidden = true
        landscapeBack.addTarget(self, action: #selector(goBack), for: .touchUpInside)
        view.addSubview(landscapeBack)

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

        observation = services.observeSession { [weak self] state in
            self?.sessionChanged(state)
        }
        if PendingChats.isPendingChatId(sessionId) {
            let pendingChats = services.pendingChats
            let sessionId = self.sessionId
            pendingTask.task = Task { [weak self] in
                for await chats in await pendingChats.observe() {
                    guard let self, !Task.isCancelled else { return }
                    self.pendingChatChanged(chats[sessionId])
                }
            }
        }
        if let git = services.gitStatus {
            let sessionId = self.sessionId
            gitTask.task = Task { [weak self] in
                for await status in await git.observe(sessionId: sessionId) {
                    guard let self, !Task.isCancelled else { return }
                    self.gitStatus = status
                    self.updateHeader()
                }
            }
            Task { await git.refresh(sessionId: sessionId) }
        }
        let planner = self.planner
        let rows = ApplyPipeline<ChatRowsInput, ChatRowsApplied, ChatRowsUpdate>(
            input: ChatRowsInput(session: session),
            state: ChatRowsApplied(),
            derive: { input, applied in ChatRows.derive(input, applied: applied, planner: planner) },
            apply: { [weak self] update in
                guard let self, self.context.account.session === self.account else { return false }
                return self.applyRows(update)
            }
        )
        rows.follow(services.feed.snapshots(sessionId: sessionId)) { $0.snapshot = $1 }
        self.rows = rows
        rowsObservation = rows.observation

        NotificationCenter.default.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(willEnterForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // A store write: never on the main thread.
        let actions = account.actions
        let sessionId = self.sessionId
        Task.detached(priority: .userInitiated) { actions.markRead(sessionId: sessionId) }
        // sync.ts `onSessionVisible`: a session someone has opened is no
        // longer an abandoned start, in this account.
        account.spawnRequests.release(sessionId: sessionId)
        updateHeaderVisibility(animated: animated)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // Screens pushed from here, and the one under it, have their bar.
        if hidesHeader, navigationController?.topViewController !== self {
            navigationController?.setNavigationBarHidden(false, animated: animated)
        }
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        updateHeaderVisibility(animated: false)
        layoutScreen()
        updatePermissionListMaxHeight()
        if list.bounds.width != sentRowsView.width {
            scheduleMeasure()
        }
    }

    private var maxContentWidth: CGFloat {
        ContentWidth.maxWidth // Tablet (HappyUI/Tablet): layout.ts maxWidth, was 800 by size class.
    }

    private func layoutScreen() {
        let size = view.bounds.size
        let screen = ChatScreenLayout(.init(
            size: size,
            safeArea: LayoutInsets(view.safeAreaInsets),
            // The guide's top is the safe area's bottom while the keyboard
            // is down, and the layout never goes below that.
            keyboardTop: keyboardTracker.frame.minY,
            accessories: dockBars.map { $0.inset ? .inset($0.measurable) : .fullWidth($0.measurable) },
            composerHeight: composer.composerHeight(fitting: size.width),
            composerCardOffset: composer.cardOffset,
            maxContentWidth: maxContentWidth,
            // TabletBranches: chatFloatingDock and chatInputPaddingH.
            docked: isTabletLayout,
            accessoryPaddingH: isTabletLayout ? TabletBranches.Metrics.tabletInputPaddingH : TabletBranches.Metrics.phoneInputPaddingH,
            hidesHeader: hidesHeader
        ))
        list.setLayoutFrame(screen.list)
        list.setEdgeInsets(newest: screen.newestEdgeInset, oldest: screen.oldestEdgeInset)
        headerScrim.setLayoutFrame(screen.headerScrim)
        if !cliWarning.isHidden {
            cliWarning.place(CliWarningPillLayout(width: size.width, top: view.safeAreaInsets.top, label: cliWarning.labelMeasurable))
        }
        // Loading the session and the deleted state take the whole screen;
        // an empty chat sits between the bar and the dock.
        placeholder.setLayoutFrame(dock.isHidden ? view.bounds : screen.placeholder)
        titleView.maxWidth = ChatHeaderTitleLayout.maxWidth(headerWidth: size.width)
        plainTitleView.maxWidth = ContentWidth.headerMaxWidth
        dock.setLayoutFrame(screen.dock)
        for (bar, frame) in zip(dockBars, screen.accessories) { bar.view.setLayoutFrame(frame) }
        composer.setLayoutFrame(screen.composer)
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
        floatingDockChanged()
        updateCliWarning()
        view.setNeedsLayout()
    }

    /// The fades come and go with the floating dock, and the bars above the
    /// composer always show without it.
    private func floatingDockChanged() {
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
        rows?.update { $0.session = state }
        updateHeader()
        updateCliWarning()
        updatePlaceholder()
        updateDockBars()
        updateComposer()
        scheduleMeasure()
    }

    // MARK: Header

    /// ChatHeaderView over a transparent bar: the system back button, the
    /// title capsule, the avatar; the scrim is the screen's own.
    private func setUpHeader() {
        titleView.addTarget(self, action: #selector(openInfo), for: .touchUpInside)
        plainTitleView.addTarget(self, action: #selector(openInfo), for: .touchUpInside)
        avatarControl.addTarget(self, action: #selector(openInfo), for: .touchUpInside)
        if #available(iOS 26.0, *) {
            // The control is its own glass.
            avatarItem.hidesSharedBackground = true
        }
        applyHeaderBranch()
        updateHeader()
    }

    /// ChatHeaderView's `glassEnabled` and SessionView's `headerRight`
    /// (`TabletBranches`): a phone's glass capsule and avatar over the
    /// scrim, or a tablet's opaque bar (`header.background`) with the plain
    /// title and no avatar. The back button is `dropsBackButtonOnTablet`'s.
    private func applyHeaderBranch() {
        let tablet = isTabletLayout
        let appearance = UINavigationBarAppearance()
        if tablet {
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

        navigationItem.titleView = tablet ? plainTitleView : titleView
        var items = tablet ? [] : [avatarItem]
        #if DEBUG
        items.append(fixturesMenu())
        #endif
        navigationItem.rightBarButtonItems = items
        floatingDockChanged()
    }

    private func updateHeader() {
        let model = ChatHeaderModel(session: session.record, dataReady: session.dataReady || isFixture, gitStatus: gitStatus, pending: isPendingChat)
        let title = switch model.title {
        case .loading: ""
        case .deleted: Strings.SessionDetail.sessionDeleted
        case .name(let name): name ?? Strings.Session.newChat
        }
        navigationItem.title = title
        titleView.update(title: title, subtitle: model.subtitle, changes: model.changes)
        titleView.isEnabled = session.record != nil
        titleView.sizeToFit()
        plainTitleView.update(title: title, subtitle: model.subtitle, changes: model.changes)
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
                        : nil
                ),
                style: settings.avatarStyle,
                monochrome: !model.connected || settings.avatarMonochrome
            )
        }
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
        push(.sessionInfo(id: sessionId), context: context)
    }

    private var isPendingChat: Bool {
        PendingChats.isPendingChatId(sessionId) && session.record == nil
    }

    private func pendingChatChanged(_ chat: PendingChat?) {
        guard chat != pendingChat else { return }
        if chat?.anchorSessionId != pendingChat?.anchorSessionId {
            anchorMetadata = nil
            anchorObservation = chat.map { chat in
                services.observeOtherSession(chat.anchorSessionId) { [weak self] state in
                    guard let self, state.metadata != self.anchorMetadata else { return }
                    self.anchorMetadata = state.metadata
                    self.updatePlaceholder()
                }
            }
        }
        pendingChat = chat
        updatePlaceholder()
    }

    private var isFixture: Bool {
        #if DEBUG
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
                content = .empty(ChatEmptyState(metadata: record.metadata, createdAt: record.createdAt, now: Int64(Date().timeIntervalSince1970 * 1000)))
            } else {
                content = .loading
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
        if isViewLoaded && view.window != nil {
            UIView.animate(withDuration: 0.25, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
                self.view.layoutIfNeeded()
            }
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
                if let self, let opened, opened != self.sessionId {
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
        let sessionId = self.sessionId
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
        let sessionId = self.sessionId
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
    /// was planned for another width or layout: the next pass has the new
    /// one.
    private func applyRows(_ update: ChatRowsUpdate) -> Bool {
        if update.list != nil, update.width != list.bounds.width || update.tablet != isTabletLayout {
            return false
        }
        ApplyPerf.measure(.chatList) {
            var touched = 0
            if let facts = update.facts {
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
                touched += list.apply(rows, animated: true)
            }
            return touched
        }
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
            tick: graceTick
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
        if distanceFromOldest < list.bounds.height { growWindow() }
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
            push(.sessionMessage(id: sessionId, messageId: messageId), context: context)
        case .openMessageFile(let messageId, let file):
            push(.sessionMessage(id: sessionId, messageId: messageId, file: file), context: context)
        case .openFile(let path):
            push(.sessionFile(id: sessionId, path: path), context: context)
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
        case .diffShowMore(let toolId, let chunk, let file):
            diffExpanded[toolId, default: [:]][chunk, default: []].insert(file)
            pin = toolId
            pins += 1
            scheduleMeasure()
        case .option(let title):
            let sender = services.sender
            let sessionId = self.sessionId
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
        let sessionId = self.sessionId
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
        let sessionId = self.sessionId
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

    func composerDidInvalidateHeight(_ composer: any ChatComposerView) {
        view.setNeedsLayout()
        view.layoutIfNeeded()
    }

    func composerDidChangeFocus(_ composer: any ChatComposerView) {}

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
        let sessionId = self.sessionId
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
