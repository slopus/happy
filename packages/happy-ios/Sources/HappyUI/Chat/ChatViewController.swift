#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyStore
import UIKit

/// The session screen: session/[id].tsx → SessionView.tsx with
/// AgentContentView's floating dock (the phone layout).
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
    private let sessionId: String
    private let services: ChatServices

    private let list = ChatListView()
    private let scrim = ChatScrimView()
    private let dock = UIView()
    private let composer: any ChatComposerView
    private let scrollButton = ChatScrollButton()
    private let keyboardTracker = UIView()
    private let measurer = ChatRowMeasurer()
    private let feedTask = TaskHolder()
    private var observation: StoreObservation?

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
    /// Permission buttons whose reply is on its way, by permission id.
    private var permissionBusy: [String: PermissionButton.Kind] = [:]
    /// Tools the reader opened, by message id: for as long as the screen
    /// lives, never stored.
    private var expandedTools: Set<String> = []
    /// The tool just opened or closed, held still by the next update.
    private var pendingPin: String?

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
        view.backgroundColor = UIColor(Palette.surface)
        showsBackTitle()
        navigationItem.largeTitleDisplayMode = .never
        #if DEBUG
        navigationItem.rightBarButtonItem = fixturesMenu()
        #endif

        list.delegate = self
        view.addSubview(list)
        view.addSubview(scrim)
        composer.composerDelegate = self
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
        traitCollection.horizontalSizeClass == .regular ? ChatScreenLayout.Metrics.regularMaxContentWidth : .greatestFiniteMagnitude
    }

    private func layoutScreen() {
        let size = view.bounds.size
        let screen = ChatScreenLayout(.init(
            size: size,
            safeArea: LayoutInsets(view.safeAreaInsets),
            // The guide's top is the safe area's bottom while the keyboard
            // is down, and the layout never goes below that.
            keyboardTop: keyboardTracker.frame.minY,
            composerHeight: composer.composerHeight(fitting: size.width),
            composerCardOffset: composer.cardOffset,
            maxContentWidth: maxContentWidth
        ))
        list.setLayoutFrame(screen.list)
        list.setEdgeInsets(newest: screen.newestEdgeInset, oldest: screen.oldestEdgeInset)
        dock.setLayoutFrame(screen.dock)
        composer.setLayoutFrame(screen.composer)
        scrollButton.setLayoutFrame(screen.scrollButton)
        scrim.setLayoutFrame(screen.scrim)
    }

    // MARK: Data

    private func sessionChanged(_ state: ChatSessionState) {
        session = state
        navigationItem.title = Self.title(state)
        updateComposer()
        scheduleMeasure()
    }

    /// getSessionName: the bot's name, the summary, or "New chat".
    static func title(_ state: ChatSessionState) -> String {
        if let bot = state.metadata?["bot"]?["name"]?.stringValue { return bot }
        if let summary = state.metadata?["summary"]?["text"]?.stringValue { return summary }
        return Strings.Session.newChat
    }

    private func receive(_ snapshot: ChatSnapshot) {
        guard snapshot != self.snapshot else { return }
        self.snapshot = snapshot
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
            flavor: flavor
        )
        let permissionBusy = self.permissionBusy
        let expandedTools = self.expandedTools
        return items.filter { ChatRowRenderer.isShown($0, style: style) }.map { item in
            var delivery: OutboxDelivery?
            if case .message(.userText(let message)) = item, let localId = message.localId {
                delivery = snapshot.delivery[localId]
            }
            var expanded = false
            if case .workHeader(let group, _) = item {
                expanded = groups.isExpanded(group, inForeground: inForeground)
            }
            var busy: PermissionButton.Kind?
            if case .message(.toolCall(let call)) = item {
                expanded = expandedTools.contains(call.id)
                busy = call.tool.permission.flatMap { permissionBusy[$0.id] }
            }
            return ChatRowInput(item: item, delivery: delivery, expanded: expanded, permissionBusy: busy, style: style)
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
        Task { [weak self] in
            let plans = await measurer.plans(inputs, width: width)
            guard let self else { return }
            self.measuring = false
            if self.list.bounds.width == width {
                self.list.apply(plans, animated: true, pinning: pin)
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

    func chatList(_ list: ChatListView, didScroll distanceFromNewest: CGFloat, nearOldest: Bool) {
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
        }
        if nearOldest && !measuring { growWindow() }
    }

    func chatList(_ list: ChatListView, perform action: ChatRowAction) {
        switch action {
        case .copy(let text):
            UIPasteboard.general.string = text
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
        case .openFile(let path):
            push(.sessionFile(id: sessionId, path: path), context: context)
        case .permission(let tap):
            answer(tap)
        case .option(let title):
            let sender = services.sender
            let sessionId = self.sessionId
            Task { _ = try? await sender.send(OutgoingMessage(text: title), sessionId: sessionId) }
        case .retry(let localId):
            let sender = services.sender
            Task { try? await sender.retry(localId: localId) }
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

    // MARK: ChatComposerDelegate

    func composerDidInvalidateHeight(_ composer: any ChatComposerView) {
        view.setNeedsLayout()
        view.layoutIfNeeded()
    }

    func composerDidChangeFocus(_ composer: any ChatComposerView) {}

    func composer(_ composer: any ChatComposerView, didSend localId: String) {
        list.scrollToNewest(animated: true)
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
