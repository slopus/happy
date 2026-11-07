#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Home for an agent connection: its V2 under a clear navigation bar, the
/// list running under it with iOS 26's soft scroll edge as the bar's shade.
/// At the left, alone, the account switcher (`AccountSwitcher`): the active
/// account's picture and name, the name giving way to the link's status
/// while the computer isn't live. Settings stays at the right. Search, the
/// call, compose and the microphone are in UIKit's bottom toolbar; what search finds
/// shows over home, which stays where it was.
///
/// As the iPad's sidebar (`SidebarColumnTrait`) the header keeps the
/// switcher alone: search is a field at the top of the list
/// (`SidebarSearchField`), and settings and compose are the sidebar's own
/// bar at its foot (`SidebarBottomBar`).
final class AgentHomeViewController: UIViewController, ComposeHosting {
    private let context: AppContext
    private let id: String
    private let v2: HomeViewController
    private(set) lazy var search = BarSearch(host: self, placeholder: Strings.search, fieldIdentifier: "search-field")
    /// Search and the bar at the foot, as the iPad's sidebar has them.
    private(set) lazy var sidebarSearch = SidebarSearchField(placeholder: Strings.search)
    private(set) lazy var bottomBar = SidebarBottomBar(
        composeTitle: Strings.newWork,
        onSettings: { [weak self] in self?.openSettings() },
        onCompose: { [weak self] in self?.compose() }
    )
    private lazy var composeItem: UIBarButtonItem = {
        let item = HeaderBar.composeItem { [weak self] in self?.compose() }
        item.sharesBackground = false
        return item
    }()
    /// A voice call with this connection's agents, just left of compose
    /// (`CallController`).
    private lazy var voiceItem: UIBarButtonItem = {
        let item = UIBarButtonItem(image: .voiceIcon(), primaryAction: UIAction { [weak self] _ in self?.startCall() })
        item.accessibilityLabel = Strings.Call.start
        item.accessibilityIdentifier = "voice-call"
        item.sharesBackground = false
        return item
    }()
    /// Telegram's microphone, the toolbar's last and primary button: hold
    /// to say what a new task should do, and it starts with those words;
    /// stopped while locked, its composer opens with them as a draft.
    private lazy var record: RecordButton = {
        let button = RecordButton(style: .toolbar)
        button.bar = { [weak self, weak button] in
            guard let self, let button, button.window != nil else { return nil }
            let frame = button.convert(button.bounds, to: nil)
            let field = search.bar.searchTextField
            let leading = field.window == button.window && field.bounds.height > 0 ? field.convert(field.bounds, to: nil).minX : view.convert(CGPoint(x: view.safeAreaInsets.left + 16, y: 0), to: nil).x
            return RecordBar(frame: RecordOverlayLayout.capsule(button: frame, leading: leading), cornerRadius: frame.height / 2)
        }
        // The toolbar's other buttons stand a little taller than the
        // bar: they fade while it is up (the microphone's glyph is gone
        // then too).
        button.onRecording = { [weak self] recording in
            UIView.animate(withDuration: recording ? 0.15 : RecordMotion.Metrics.disappearDuration) {
                self?.navigationController?.toolbar.alpha = recording ? 0 : 1
            }
        }
        button.onResult = { [weak self] result in
            guard let self else { return }
            endSearch()
            switch result {
            case .send(let words): v2.startWork(saying: words)
            case .draft(let words): v2.makeNewWork(draft: words)
            }
        }
        return button
    }()
    private lazy var recordItem: UIBarButtonItem = {
        let item = UIBarButtonItem(customView: record)
        item.sharesBackground = false
        return item
    }()
    private var switcher: AccountSwitcher?
    private var headerWatch: Watch?
    private var accessWatch: Watch?
    private var onboardingWatch: Watch?
    /// "What's your name?" was offered on this screen: once a launch, so
    /// "Not Now" holds until the next.
    private var askedName = false
    /// The person's role may start work here (`RoleGate`): else no compose,
    /// microphone or call. A computer always may.
    private var mayWrite: Bool { Session.session(for: id, context: context)?.gate.allows(.contentWrite) ?? true }
    private var shownMayWrite: Bool?
    /// The list's room under the bar and above the toolbar, as home last
    /// stood with it.
    private var room: HomeListRoom?
    /// On top of the stack, neither coming nor going.
    private var standing = false
    /// What the title says of the link (`Session.watchHeader`). Not
    /// private, so a test can flip it.
    var headerState: Strings.HeaderStatus.State = .online {
        didSet { if headerState != oldValue { updateTitle() } }
    }

    init(context: AppContext, id: String) {
        self.context = context
        self.id = id
        v2 = HomeViewController(context: context, computer: id)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        // The conversation's own ground, light and dark; none as the iPad's
        // sidebar, where the system's sidebar shows.
        applyGround()
        registerForTraitChanges([SidebarColumnTrait.self]) { (self: Self, _) in
            self.applyGround()
            self.applyChrome()
        }
        addChild(v2)
        v2.view.frame = view.bounds
        v2.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(v2.view)
        v2.didMove(toParent: self)
        view.addSubview(sidebarSearch)
        view.addSubview(bottomBar)
        navigationItem.largeTitleDisplayMode = .never
        HeaderBar.edge(v2.list, in: self)
        search.onBegin = { [weak self] in self?.v2.beginSearch() }
        search.onChange = { [weak self] query in self?.searched(query) }
        search.onEnd = { [weak self] in self?.searchEnded() }
        sidebarSearch.onBegin = { [weak self] in
            self?.v2.beginSearch()
            self?.updateEdge()
        }
        sidebarSearch.onChange = { [weak self] query in self?.searched(query) }
        sidebarSearch.onEnd = { [weak self] in self?.searchEnded() }
        sidebarSearch.onLayoutChange = { [weak self] in self?.view.setNeedsLayout() }
        v2.onSearchEnded = { [weak self] in
            self?.search.end()
            self?.sidebarSearch.end()
        }
        v2.onListScroll = { [weak self] in self?.placeSearchField() }
        switcher = AccountSwitcher(context: context, controller: self)
        headerWatch = Session.session(for: id, context: context)?.watchHeader { [weak self] in self?.headerState = $0 }
        accessWatch = Session.session(for: id, context: context)?.watchAccess { [weak self] in
            guard let self, shownMayWrite != mayWrite else { return }
            applyChrome()
        }
        onboardingWatch = Session.session(for: id, context: context)?.watchOnboarding { [weak self] _ in self?.askNameIfNeeded() }
        updateTitle()
        applyChrome()
    }

    /// A Happy Cloud member whose profile onboarding says isn't saved
    /// (`Onboarding.needsName`) is asked their name over home, with the
    /// name Apple gave this sign-in offered, else the server's suggestion;
    /// saved as the profile's name (`PATCH /v0/profile`).
    private func askNameIfNeeded() {
        guard !askedName, let session = Session.session(for: id, context: context), session.isCloud,
              let onboarding = session.onboarding, view.window != nil, presentedViewController == nil else { return }
        guard onboarding.needsName == true else { return }
        askedName = true
        let client = session.client
        Task { [weak self] in
            // Apple's name from this sign-in, else the server's suggestion.
            let suggested = (try? await client.profile())?.name
            guard let self else { return }
            guard view.window != nil, presentedViewController == nil else { askedName = false; return }
            guard let name = await NamePrompt.ask(on: self, message: Strings.ServerSignIn.nameCloudMessage, prefill: CloudScreens.appleName ?? suggested, cancel: Strings.ServerSignIn.nameLater) else { return }
            do {
                let profile = try await client.profile()
                _ = try await client.renameProfile(name, version: profile.version)
                CloudScreens.appleName = nil
            } catch {
                askedName = false
                Alerts.show(Strings.Common.error, Store.describe(error), on: self)
            }
        }
    }

    private func searched(_ query: String) {
        v2.search(query)
        updateEdge()
    }

    private func searchEnded() {
        v2.endSearch()
        updateEdge()
    }

    /// Where search, settings and compose are: the phone's toolbar and
    /// header, or, as the iPad's sidebar, the field in the list and the bar
    /// at the foot. Moving between them closes an open search.
    private func applyChrome() {
        let sidebar = traitCollection.isSidebarColumn
        search.end()
        sidebarSearch.end()
        sidebarSearch.isHidden = !sidebar
        bottomBar.isHidden = !sidebar
        let mayWrite = mayWrite
        shownMayWrite = mayWrite
        bottomBar.showsCompose = mayWrite
        if sidebar {
            navigationItem.searchController = nil
            toolbarItems = nil
            bottomBar.follow(v2.list)
        } else {
            search.install()
            toolbarItems = [navigationItem.searchBarPlacementBarButtonItem, .flexibleSpace()] + (mayWrite ? [voiceItem, composeItem, recordItem] : [])
            bottomBar.follow(nil)
        }
        updateBar()
        if navigationController?.topViewController === self { HomeToolbar.show(for: self, animated: false) }
        view.setNeedsLayout()
    }

    private func applyGround() {
        view.backgroundColor = traitCollection.isSidebarColumn ? .clear : UIColor(Palette.surface)
    }

    /// The link's status in the account's name's place while it isn't live.
    private func updateTitle() {
        switcher?.link = headerState
    }

    /// Account and settings stay in the header while search lives below:
    /// the header never changes for it. As the sidebar, settings is at the
    /// foot and the switcher is alone.
    private func updateBar() {
        guard let switcher else { return }
        navigationItem.leftBarButtonItem = switcher.barItem
        navigationItem.rightBarButtonItems = traitCollection.isSidebarColumn ? [] : HeaderBar.trailing([
            .settings: settingsItem,
        ])
    }

    private lazy var settingsItem = HeaderBar.settingsItem { [weak self] in self?.openSettings() }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        HomeToolbar.show(for: self, animated: animated)
    }

    /// The bar shades whichever list is under it: the results while they
    /// cover home, home's own otherwise.
    private func updateEdge() {
        HeaderBar.edge(v2.resultsList ?? v2.list, in: self)
    }

    private func startCall() {
        guard let session = Session.session(for: id, context: context) else { return }
        CallController.shared.start(session: session, from: self)
    }

    #if DEBUG
    /// Screenshots: `HAPPY_CALL_FIXTURE` draws the bar from a script (no
    /// call), `HAPPY_CALL_TAP` presses the voice button once, for real;
    /// `HAPPY_CALL_STEPS` and the rest, as `applyTestEnvironment` says.
    private static var launchedCall = false
    private func launchCall() {
        guard !Self.launchedCall else { return }
        defer { Self.launchedCall = true }
        let environment = ProcessInfo.processInfo.environment
        CallController.shared.applyTestEnvironment { [weak self] in self?.startCall() }
        let delay = environment["HAPPY_CALL_DELAY"].flatMap(Double.init) ?? 0
        if let fixture = environment["HAPPY_CALL_FIXTURE"] {
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(delay))
                guard let self else { return }
                CallController.shared.showFixture(fixture, from: self)
            }
        } else if environment["HAPPY_CALL_TAP"] == "1" {
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(delay))
                self?.startCall()
            }
        }
    }
    #endif

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        #if DEBUG
        launchCall()
        #endif
        standing = true
        askNameIfNeeded()
        // The bar and the toolbar are where home rests: the list's room is
        // read from them again (`HomeListRoom`).
        view.setNeedsLayout()
        view.layoutIfNeeded()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        standing = false
        HomeToolbar.leave(self, animated: animated)
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        // UIKit doesn't always lay home out after the toolbar's return.
        view.setNeedsLayout()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        switcher?.layout()
        let safeArea = LayoutInsets(view.safeAreaInsets)
        let control: CGRect?
        if traitCollection.isSidebarColumn {
            let bar = bottomBar.layout(size: view.bounds.size, safeArea: safeArea)
            bottomBar.apply(bar, in: view.bounds)
            control = bar.bar
        } else {
            let field = search.bar.searchTextField
            control = field.window == view.window && field.bounds.height > 0 ? field.convert(field.bounds, to: view) : nil
        }
        let room = HomeListRoom(size: view.bounds.size, safeArea: safeArea, control: control, standing: standing, kept: room)
        self.room = room
        var insets = room.insets
        var searchInsets = room.insets
        if traitCollection.isSidebarColumn {
            // The list starts under the field; what search finds, under
            // the field held at its rest.
            let rest = SidebarSearchLayout(width: view.bounds.width, chromeTop: insets.chromeTop, scrolled: 0, pinned: true, cancelWidth: nil)
            insets.contentTop = rest.listTop
            searchInsets.chromeTop = rest.listTop
        }
        if !isSearching { v2.contentInsets = insets }
        v2.searchContentInsets = searchInsets
        placeSearchField()
    }

    /// The sidebar's field where the list has taken it, or at its rest
    /// while search is open.
    private func placeSearchField() {
        guard traitCollection.isSidebarColumn else { return }
        let list = v2.homeList
        sidebarSearch.isHidden = list.isHidden && !sidebarSearch.isActive
        let layout = SidebarSearchLayout(
            width: view.bounds.width, chromeTop: v2.contentInsets.chromeTop,
            scrolled: list.contentOffsetY + list.contentInsets.top,
            pinned: sidebarSearch.isActive, cancelWidth: sidebarSearch.cancelWidth
        )
        sidebarSearch.apply(layout)
    }

    /// The bar's compose: new work, over home.
    func compose() {
        guard mayWrite else { return }
        endSearch()
        v2.compose()
    }

    /// Search is open: compose and the like close it first.
    var isSearching: Bool { search.isActive || sidebarSearch.isActive }

    func endSearch() {
        search.end()
        sidebarSearch.end()
    }

    private func openSettings() {
        SettingsViewController.open(context: context, computer: id, from: self)
    }
}

// MARK: Voice touch

extension AgentHomeViewController {
    /// Home as the person sees it now: on screen, its list in the window.
    var isInSight: Bool {
        guard let window = view.window, !view.isHidden else { return false }
        let list = v2.homeList
        return !list.isHidden && list.window != nil && list.convert(list.bounds, to: window).intersects(window.bounds)
    }

    /// The row of home's list that opens `agentId` (`VoiceTouch`), scrolled
    /// to the middle first if it isn't wholly on screen: gliding 0.3 to
    /// 0.6 s by the distance, at once if asked for less motion.
    func voiceTouchRow(_ agentId: String) async -> VoiceTouch.Mark? {
        guard isInSight, !isSearching else { return nil }
        return await v2.homeList.reveal(agentId: agentId, glides: !VoiceTouch.reducesMotion)?.view.voiceTouch
    }

    /// Compose as home shows it: the sidebar's foot on an iPad, else the
    /// toolbar's last glass button.
    func voiceTouchCompose() -> VoiceTouch.Mark? {
        guard isInSight else { return nil }
        if traitCollection.isSidebarColumn {
            let button = bottomBar.compose
            guard button.window != nil, !button.isHidden else { return nil }
            return VoiceTouch.glassMark(button)
        }
        guard let bar = navigationController?.view else { return nil }
        let bottom = VoiceTouch.glassButtons(in: bar).filter { VoiceTouch.inFloatingBar($0) }
        let leftToRight = view.effectiveUserInterfaceLayoutDirection == .leftToRight
        let last = leftToRight ? bottom.max { $0.convert($0.bounds, to: nil).midX < $1.convert($1.bounds, to: nil).midX }
            : bottom.min { $0.convert($0.bounds, to: nil).midX < $1.convert($1.bounds, to: nil).midX }
        return last.map(VoiceTouch.glassMark)
    }
}

extension AgentHomeViewController: MainPanelFollowing {
    func mainPanelDidShow(_ root: UIViewController?) {
        v2.shownBeside = root
    }
}
#endif
