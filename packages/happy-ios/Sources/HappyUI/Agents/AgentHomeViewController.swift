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
    /// A voice call with this connection's agents, before Settings in the
    /// header (`CallController`).
    private lazy var callItem = HeaderBar.callItem { [weak self] in self?.startCall() }
    /// Telegram's microphone, between search and compose: hold to say
    /// what a new task should do, and it starts with those words; stopped
    /// while locked, its composer opens with them as a draft.
    private lazy var record: RecordButton = {
        let button = RecordButton(style: .toolbar)
        // The toolbar becomes the bar: search's glass morphs into one item
        // the clock is written over, and back when the recording ends
        // (`RecordToolbarLayout`).
        button.bar = { [weak self] in
            guard let self, let toolbar = navigationController?.toolbar, let layout = recordingLayout(in: toolbar) else { return nil }
            return RecordBar(frame: toolbar.convert(layout.bar, to: nil), cornerRadius: layout.bar.height / 2, ground: .host)
        }
        button.onRecording = { [weak self] recording in self?.morphToolbar(recording: recording) }
        button.multilingual = { [weak self] in self?.context.account.localSettings.multilingualDictation ?? true }
        // A cancel's bin stands in for search's magnifier, as Telegram's
        // stands in for the attach button: the dot is right over it.
        button.binSpot = { [weak self] in
            guard let bar = self?.navigationItem.searchController?.searchBar,
                  let magnifier = (bar.searchTextField.leftView as? UIImageView)?.image
            else { return nil }
            // The magnifier, clear: the placeholder keeps its place.
            let clear = magnifier.withTintColor(.clear, renderingMode: .alwaysOriginal)
            return RecordBinSpot(hide: { hidden in
                bar.setImage(hidden ? clear : nil, for: .search, state: .normal)
            })
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
    /// The toolbar's bar while the microphone records: room for the clock,
    /// in glass search's field morphs into.
    private let recordBarSpace = RecordBarSpace()
    private lazy var recordBarItem: UIBarButtonItem = {
        let item = UIBarButtonItem(customView: recordBarSpace)
        item.sharesBackground = false
        item.identifier = Self.searchIdentifier
        return item
    }()
    /// Compose's room while the microphone records, so it doesn't move.
    private let composeRoom = UIBarButtonItem.fixedSpace(RecordToolbarLayout.buttonRoom)
    private static let searchIdentifier = "home-search"
    /// The toolbar's frames while the microphone records; nil at rest.
    private var recordingToolbar: RecordToolbarLayout?
    private var switcher: AccountSwitcher?
    private var headerWatch: Watch?
    private var accessWatch: Watch?
    private var onboardingWatch: Watch?
    private var accountsWatch: AccountsObservation?
    /// The server's session ended: only the way to sign in again shows
    /// (`ServerSignedOutView`).
    private var signedOutView: ServerSignedOutView?
    var showsSignedOut: Bool { signedOutView != nil }
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
        accountsWatch = context.account.observeAccounts { [weak self] _ in self?.followSignIn() }
    }

    /// A server whose session ended shows nothing but the way back in: its
    /// lists, chats, search and composer go, and what was kept of it on
    /// this phone (`Session.forget`). Signed in again, home starts afresh.
    private func followSignIn() {
        let out = context.account.agentConnections.signedOut(id)
        guard out != showsSignedOut else { return }
        guard out else { return restart() }
        Session.forget(id)
        headerWatch = nil; accessWatch = nil; onboardingWatch = nil
        search.end()
        sidebarSearch.end()
        presentedViewController?.dismiss(animated: false)
        if let navigation = navigationController, navigation.viewControllers.contains(self), navigation.topViewController !== self {
            navigation.popToViewController(self, animated: false)
        }
        let name = context.account.agentConnections.accounts.first { $0.id == id }.flatMap { account in
            HappyCloud.handle(server: account.server) ?? account.name
        } ?? Strings.agentConnection
        let signedOut = ServerSignedOutView(server: name) { [weak self] in self?.signIn() }
        signedOut.frame = view.bounds
        signedOut.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(signedOut)
        signedOutView = signedOut
        v2.view.isHidden = true
        applyChrome()
    }

    private func signIn() {
        guard let server = context.account.agentConnections.server(for: id) else { return }
        if HappyCloud.isCloud(server) { return AccountAdding.connectToCloud(context: context, from: self) }
        let instanceId = context.account.agentConnections.accounts.first { $0.id == id }?.instanceId
        AccountAdding.signInToServer(context: context, from: self, server: server, instanceId: instanceId)
    }

    /// Signed in again: a new home, synced from scratch, in this one's place.
    private func restart() {
        guard let navigation = navigationController, let index = navigation.viewControllers.firstIndex(of: self) else { return }
        var stack = navigation.viewControllers
        stack[index] = AgentHomeViewController(context: context, id: id)
        navigation.setViewControllers(stack, animated: false)
    }

    /// A Happy Cloud member whose profile onboarding says isn't saved
    /// (`Onboarding.needsName`) gets Create your profile over home, the name
    /// Apple gave this sign-in offered, else the server's suggestion; saved
    /// as the profile's name (`PATCH /v0/profile`, with the suggested
    /// email), then any picture. Not Now leaves it unsaved, and this home
    /// doesn't ask again.
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
            let screen = CloudProfileViewController(
                context: context, handle: HappyCloud.handle(server: session.server) ?? session.computerName,
                prefill: CloudScreens.appleName ?? suggested, seed: context.account.agentConnections.placeholderSeed(for: id) ?? id
            ) { name, photo in
                let profile = try await client.profile()
                _ = try await client.renameProfile(name, email: profile.email, version: profile.version)
                CloudScreens.appleName = nil
                guard let photo else { return true }
                return (try? await client.setProfilePhoto(photo, contentType: "image/jpeg")) != nil
            }
            screen.navigationItem.leftBarButtonItem = UIBarButtonItem(title: Strings.ServerSignIn.nameLater, primaryAction: UIAction { [weak screen] _ in
                screen?.dismiss(animated: true)
            })
            let navigation = UINavigationController(rootViewController: screen)
            navigation.modalPresentationStyle = .fullScreen
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            screen.finished = { [weak self, weak navigation] photoSaved in
                guard let photoSaved else { return }
                navigation?.dismiss(animated: true) {
                    guard let self, !photoSaved else { return }
                    Alerts.show(Strings.CloudConnect.photoFailed, on: self)
                }
            }
            present(navigation, animated: true)
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
        if showsSignedOut {
            sidebarSearch.isHidden = true
            bottomBar.isHidden = true
            navigationItem.searchController = nil
            toolbarItems = nil
            updateBar()
            navigationController?.setToolbarHidden(true, animated: false)
            return
        }
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
            toolbarItems = recordingToolbar == nil ? restingToolbarItems : recordingToolbarItems
            bottomBar.follow(nil)
        }
        updateBar()
        if navigationController?.topViewController === self { HomeToolbar.show(for: self, animated: false) }
        view.setNeedsLayout()
    }

    /// Search, then the microphone and compose, if this person may start
    /// work.
    private var restingToolbarItems: [UIBarButtonItem] {
        let search = navigationItem.searchBarPlacementBarButtonItem
        search.identifier = Self.searchIdentifier
        return [search, .flexibleSpace()] + (mayWrite ? [recordItem, composeItem] : [])
    }

    /// The bar's room, the microphone, and compose's room.
    private var recordingToolbarItems: [UIBarButtonItem] { [recordBarItem, .flexibleSpace(), recordItem, composeRoom] }

    /// The toolbar morphs into the recording bar and back
    /// (`setToolbarItems(_:animated:)`): the bar's glass grows from
    /// search's field, the microphone stays, compose goes.
    private func morphToolbar(recording: Bool) {
        guard let toolbar = navigationController?.toolbar else { return }
        if recording {
            guard let layout = recordingLayout(in: toolbar) else { return }
            recordingToolbar = layout
            recordBarSpace.size = layout.barView
        } else {
            guard recordingToolbar != nil else { return }
            recordingToolbar = nil
        }
        // The recording screen's animations reach the screen first: the
        // toolbar's morph lays its bar out in a transaction of its own, so
        // the circles never wait on it.
        CATransaction.flush()
        setToolbarItems(recording ? recordingToolbarItems : restingToolbarItems, animated: true)
    }


    /// The toolbar's frames while the microphone records; nil as the
    /// iPad's sidebar, whose toolbar has no microphone.
    private func recordingLayout(in toolbar: UIToolbar) -> RecordToolbarLayout? {
        guard !traitCollection.isSidebarColumn, record.window != nil else { return nil }
        return RecordToolbarLayout(width: toolbar.bounds.width, microphone: record.convert(record.bounds, to: toolbar), after: 1)
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
            .call: mayWrite ? callItem : nil,
            .settings: settingsItem,
        ].compactMapValues { $0 })
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
        // A picture Create your profile couldn't upload, said once landed.
        if presentedViewController == nil, let note = CloudScreens.takePhotoNote() { Alerts.show(note, on: self) }
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

/// The recording bar's item: empty, its glass is the bar.
private final class RecordBarSpace: UIView {
    var size: CGSize = .zero {
        didSet {
            frame.size = size
            invalidateIntrinsicContentSize()
        }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var intrinsicContentSize: CGSize { size }
    override func sizeThatFits(_ size: CGSize) -> CGSize { self.size }
}

extension AgentHomeViewController: MainPanelFollowing {
    func mainPanelDidShow(_ root: UIViewController?) {
        v2.shownBeside = root
    }
}
#endif
