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
/// work groups, the rendered window) → row inputs → plans measured off the
/// main thread (ChatRowMeasurer) → the list. While a plan set is being
/// measured, newer snapshots wait; only the latest is measured next, so a
/// fast stream is coalesced to as many updates as measuring can keep up with.
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
        pictures: account.attachmentPictures, sessionId: sessionId, load: services.attachment
    )
    private weak var questionSheet: AgentQuestionSheetController?
    /// Questions a sent message answers instead, by the message's local
    /// id: dismissed once it is delivered.
    private var questionsToDismiss: [String: [PendingAgentCommunication]] = [:]
    private let scrollButton = ChatScrollButton()
    private let copyCallout = ChatCopyCallout()
    private let keyboardTracker = UIView()
    private let measurer = ChatRowMeasurer()
    private let feedTask = TaskHolder()
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

    private var snapshot: ChatSnapshot?
    private var session = ChatSessionState(record: nil, settings: AccountSettings())
    private var display: [ChatDisplayItem] = []
    private var groups = ChatWorkGroupState()
    /// The oldest message rendered; newer messages are always rendered, older
    /// ones join a page at a time as the reader nears them.
    private var oldestRenderedId: String?
    private var windowCount = 0
    private var measuring = false
    private var needsMeasure = false
    private var inForeground = true
    private var dockDetailsVisible = true
    private var lastLayoutWidth: CGFloat = 0
    /// `traitCollection.isTabletLayout`, kept here so the row inputs can be
    /// built off the main thread.
    private var isTabletLayout = false
    /// Permission buttons whose reply is on its way, by permission id.
    private var permissionBusy: [String: PermissionButton.Kind] = [:]
    /// Tools the reader opened, by message id: for as long as the screen
    /// lives, never stored.
    private var expandedTools: Set<String> = []
    /// The tool just opened or closed, held still by the next update.
    private var pendingPin: String?
    /// Diff files the reader opened past "Show N more lines": by tool
    /// message id, then by diff in the tool.
    private var diffExpanded: [String: [Int: Set<Int>]] = [:]
    /// Question forms in the chat, by tool message id: the form as the
    /// latest snapshot has it, and what the reader has done to it.
    private var questionForms: [String: (tool: ToolCall, form: InlineQuestionForm)] = [:]
    private var questionDrafts: [String: ChatQuestionState] = [:]

    init(context: AppContext, session account: AccountSession, sessionId: String) {
        self.context = context
        self.account = account
        self.sessionId = sessionId
        let services = ChatServices.make(account: account, sessionId: sessionId)
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
        registerForTraitChanges([UITraitVerticalSizeClass.self]) { (self: Self, _) in
            self.updateCliWarning()
        }
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
        let stream = services.feed.snapshots(sessionId: sessionId)
        feedTask.task = Task { [weak self] in
            for await snapshot in stream {
                guard let self else { return }
                self.receive(snapshot)
            }
        }

        NotificationCenter.default.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(willEnterForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        account.actions.markRead(sessionId: sessionId)
        // sync.ts `onSessionVisible`: a session someone has opened is no
        // longer an abandoned start.
        SpawnRequests.shared.release(sessionId: sessionId)
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        layoutScreen()
        if view.bounds.width != lastLayoutWidth {
            lastLayoutWidth = view.bounds.width
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
            accessoryPaddingH: isTabletLayout ? TabletBranches.Metrics.tabletInputPaddingH : TabletBranches.Metrics.phoneInputPaddingH
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
    }

    // MARK: Data

    private func sessionChanged(_ state: ChatSessionState) {
        session = state
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
        headerScrim.isHidden = tablet
        scrim.isHidden = tablet || dock.isHidden
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

    /// Not on a phone held sideways, as in happy-app.
    private func updateCliWarning() {
        let warning = CliVersionWarning(metadata: session.metadata, acknowledged: acknowledgedCliVersions)
        cliWarning.warning = warning
        let hidden = warning == nil || traitCollection.verticalSizeClass == .compact
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
            if let snapshot, !snapshot.messages.isEmpty {
                content = nil
            } else if snapshot?.isLoaded == true {
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
            scrim.isHidden = fullScreen || isTabletLayout
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

    private func receive(_ snapshot: ChatSnapshot) {
        guard snapshot != self.snapshot else { return }
        self.snapshot = snapshot
        dismissAnsweredQuestions(snapshot)
        updatePlaceholder()
        updateComposer()
        scheduleMeasure()
    }

    private func updateComposer() {
        let hasPendingQuestion = snapshot?.messages.contains { message in
            guard case .toolCall(let call) = message else { return false }
            return ChatToolDisplay.isInteractiveQuestion(call.tool.name) && call.tool.state == .running
        } ?? false
        composer.update(ChatComposerState(
            session: session,
            usage: snapshot?.usage,
            delivery: snapshot?.delivery ?? [:],
            isLoaded: snapshot?.isLoaded ?? false,
            hasPendingQuestion: hasPendingQuestion
        ))
    }

    /// The rows to show, from the latest snapshot.
    private func makeInputs() -> [ChatRowInput] {
        guard let snapshot else { return [] }
        let messages = Array(snapshot.messages.reversed())
        var desiredEnd = max(ChatDisplay.initialWindow, windowCount)
        if let oldest = oldestRenderedId, let index = messages.firstIndex(where: { $0.id == oldest }) {
            desiredEnd = index + 1
        }
        let end = ChatDisplay.windowEnd(messages, desiredEnd: desiredEnd)
        let window = Array(messages[..<end])
        windowCount = end
        // Pin the oldest rendered message, so new messages extend the window
        // rather than push history out from under the reader.
        if oldestRenderedId == nil, let last = window.last { oldestRenderedId = last.id }

        let currentTurnComplete = !session.thinking && !session.hasPendingPermission
        groups.watch(window, currentTurnComplete: currentTurnComplete, inForeground: inForeground)
        display = ChatDisplay.group(window, enabled: session.groupToolCalls, collapseCurrentTurn: currentTurnComplete)
        let inForeground = self.inForeground
        let groups = self.groups
        let items = ChatDisplay.listItems(display) { groups.isExpanded($0, inForeground: inForeground) }

        let flavor = session.flavor
        let style = ChatRowStyle(
            bubble: session.settings.userMessageBubbleColor,
            compactTools: session.compactToolCalls,
            claudeFlavor: flavor == nil || flavor == "" || flavor == "claude",
            maxContentWidth: maxContentWidth,
            root: session.metadata?["path"]?.stringValue,
            flavor: flavor,
            showLineNumbers: session.settings.bool("showLineNumbersInToolViews"),
            tablet: isTabletLayout
        )
        let permissionBusy = self.permissionBusy
        let expandedTools = self.expandedTools
        let diffExpanded = self.diffExpanded
        let copiedMessageId = self.copiedMessageId
        let agentState = session.agentState
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        var graceEnd: Int64?
        questionForms = [:]
        defer { scheduleGraceEnd(graceEnd, now: now) }
        return items.filter { ChatRowRenderer.isShown($0, style: style) }.map { item in
            var delivery: OutboxDelivery?
            var userStatus: UserMessageStatus?
            if case .message(.userText(let message)) = item {
                if let localId = message.localId { delivery = snapshot.delivery[localId] }
                userStatus = ChatRowRenderer.userStatus(message, delivery: delivery, now: now)
                if let end = UserMessageStatus.graceEnds(
                    pending: message.pending, undelivered: delivery != nil, queuedWhileBusy: message.meta?.queuedWhileBusy == true,
                    createdAt: message.createdAt, now: now
                ) {
                    graceEnd = min(graceEnd ?? end, end)
                }
            }
            var copied = false
            if case .message(.agentText(let message)) = item { copied = message.id == copiedMessageId }
            var expanded = false
            if case .workHeader(let group, _) = item {
                expanded = groups.isExpanded(group, inForeground: inForeground)
            }
            var busy: PermissionButton.Kind?
            var question: ChatQuestionState?
            var diffs: [Int: Set<Int>] = [:]
            if case .message(.toolCall(let call)) = item {
                diffs = diffExpanded[call.id] ?? [:]
                expanded = expandedTools.contains(call.id)
                busy = call.tool.permission.flatMap { permissionBusy[$0.id] }
                if let form = Self.questionForm(call.tool, agentState: agentState) {
                    questionForms[call.id] = (call.tool, form)
                    var state = questionDrafts[call.id] ?? ChatQuestionState(form: form)
                    state.form = form
                    question = state
                }
            }
            return ChatRowInput(
                item: item, delivery: delivery, expanded: expanded, permissionBusy: busy, question: question, diffExpanded: diffs,
                userStatus: userStatus, copied: copied, style: style
            )
        }
    }

    /// AskUserQuestion answers through its permission; request_user_input
    /// through the communication it raised.
    static func questionForm(_ tool: ToolCall, agentState: JSONValue?) -> InlineQuestionForm? {
        switch tool.name {
        case "AskUserQuestion": InlineQuestionForm.askUserQuestion(tool)
        case "request_user_input": InlineQuestionForm.requestUserInput(tool, communication: AgentCommunications.form(agentState, toolUseId: tool.callId))
        default: nil
        }
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
            self.scheduleMeasure()
        }
    }

    private func scheduleMeasure() {
        guard isViewLoaded, list.bounds.width > 0, snapshot != nil else { return }
        guard !measuring else {
            needsMeasure = true
            return
        }
        measuring = true
        let inputs = makeInputs()
        let width = list.bounds.width
        let measurer = self.measurer
        let pin = pendingPin
        pendingPin = nil
        let controlledByUser = session.controlledByUser
        Task { [weak self] in
            let plans = await measurer.plans(inputs, width: width)
            let footer = await measurer.footer(controlledByUser: controlledByUser, width: width)
            guard let self else { return }
            self.measuring = false
            if self.list.bounds.width == width {
                self.list.apply(plans, footer: footer, animated: true, pinning: pin)
            } else {
                self.pendingPin = self.pendingPin ?? pin
                self.needsMeasure = true
            }
            if self.needsMeasure {
                self.needsMeasure = false
                self.scheduleMeasure()
            }
        }
    }

    /// Adds a page of history once the reader is within a screen of it.
    private func growWindow() {
        guard let snapshot, windowCount < snapshot.messages.count else { return }
        let messages = Array(snapshot.messages.reversed())
        let next = ChatDisplay.windowEnd(messages, desiredEnd: windowCount + ChatDisplay.windowPage)
        guard next > windowCount else { return }
        oldestRenderedId = messages[next - 1].id
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
        let details = ChatScreenLayout.dockDetailsVisible(distanceFromNewest: distanceFromNewest, currentlyVisible: dockDetailsVisible)
        if details != dockDetailsVisible {
            dockDetailsVisible = details
            composer.setDetailsVisible(details, animated: true)
            // The bars above the composer fade but keep their space.
            let bars = dockBars.map { $0.view }
            UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
                for bar in bars { bar.alpha = details ? 1 : 0 }
            }
        }
        if distanceFromOldest < list.bounds.height && !measuring { growWindow() }
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
            for case .workGroup(let group) in display where group.id == id {
                groups.toggle(group, inForeground: inForeground)
            }
            scheduleMeasure()
        case .toggleTool(let id):
            if expandedTools.remove(id) == nil { expandedTools.insert(id) }
            pendingPin = id
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
            pendingPin = toolId
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
        guard let (tool, form) = questionForms[toolId], let reply = form.reply else { return }
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

    private func dismissAnsweredQuestions(_ snapshot: ChatSnapshot) {
        guard !questionsToDismiss.isEmpty else { return }
        let controls = services.controls
        let sessionId = self.sessionId
        for (localId, communications) in questionsToDismiss {
            if case .failed = snapshot.delivery[localId] {
                questionsToDismiss[localId] = nil
                continue
            }
            let delivered = snapshot.delivery[localId] == nil && snapshot.messages.contains {
                if case .userText(let message) = $0 { return message.localId == localId }
                return false
            }
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
        groups.enterBackground(display)
        scheduleMeasure()
    }

    @objc private func willEnterForeground() {
        inForeground = true
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
