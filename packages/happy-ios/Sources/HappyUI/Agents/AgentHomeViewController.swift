#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Home for an agent connection: its V2 under a clear navigation bar, the
/// list running under it with iOS 26's soft scroll edge as the bar's shade.
/// At the left, alone, the account switcher (`AccountSwitcher`): the active
/// account's picture and name, the name giving way to the link's status
/// while the computer isn't live. Settings stays at the right. Search and compose are in UIKit's
/// bottom toolbar; what search finds
/// shows over home, which stays where it was.
final class AgentHomeViewController: UIViewController, ComposeHosting {
    private let context: AppContext
    private let id: String
    private let v2: HomeViewController
    private(set) lazy var search = BarSearch(host: self, placeholder: Strings.search, fieldIdentifier: "search-field")
    private var switcher: AccountSwitcher?
    private var headerWatch: Watch?
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
        // The conversation's own ground, light and dark.
        view.backgroundColor = UIColor(Palette.surface)
        addChild(v2)
        v2.view.frame = view.bounds
        v2.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(v2.view)
        v2.didMove(toParent: self)
        navigationItem.largeTitleDisplayMode = .never
        search.install()
        let compose = HeaderBar.composeItem { [weak self] in self?.compose() }
        compose.sharesBackground = false
        toolbarItems = [navigationItem.searchBarPlacementBarButtonItem, .flexibleSpace(), compose]
        HeaderBar.edge(v2.list, in: self)
        search.onBegin = { [weak self] in self?.v2.beginSearch() }
        search.onChange = { [weak self] query in
            self?.v2.search(query)
            self?.updateEdge()
        }
        search.onEnd = { [weak self] in
            self?.v2.endSearch()
            self?.updateEdge()
        }
        v2.onSearchEnded = { [weak self] in self?.search.end() }
        switcher = AccountSwitcher(context: context, controller: self)
        headerWatch = Session.session(for: id, context: context)?.watchHeader { [weak self] in self?.headerState = $0 }
        updateTitle()
        updateBar()
    }

    /// The link's status in the account's name's place while it isn't live.
    private func updateTitle() {
        switcher?.link = headerState
    }

    /// Account and settings stay in the header while search lives below:
    /// the header never changes for it.
    private func updateBar() {
        guard let switcher else { return }
        navigationItem.leftBarButtonItem = switcher.barItem
        navigationItem.rightBarButtonItems = HeaderBar.trailing([
            .settings: HeaderBar.settingsItem { [weak self] in self?.openSettings() },
        ])
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        HomeToolbar.show(for: self, animated: animated)
    }

    /// The bar shades whichever list is under it: the results while they
    /// cover home, home's own otherwise.
    private func updateEdge() {
        HeaderBar.edge(v2.resultsList ?? v2.list, in: self)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        standing = true
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
        let field = search.bar.searchTextField
        let control = field.window == view.window && field.bounds.height > 0 ? field.convert(field.bounds, to: view) : nil
        let room = HomeListRoom(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets), control: control, standing: standing, kept: room)
        self.room = room
        if !search.isActive { v2.contentInsets = room.insets }
        v2.searchContentInsets = room.insets
    }

    /// The bar's compose: new work, over home.
    func compose() {
        if search.isActive { search.end() }
        v2.compose()
    }

    /// Search is open: compose and the like close it first.
    var isSearching: Bool { search.isActive }

    func endSearch() { search.end() }

    private func openSettings() {
        SettingsViewController.open(context: context, computer: id, from: self)
    }
}
#endif
