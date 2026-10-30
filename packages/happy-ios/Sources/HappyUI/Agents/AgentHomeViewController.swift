#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Home for an agent connection: its V2 under a clear navigation bar, the
/// list running under it with iOS 26's soft scroll edge as the bar's shade.
/// At the left, alone, the account switcher (`AccountSwitcher`): the active
/// account's picture and name, with the connection under it while it isn't
/// live. At the right, `HeaderBar.Trailing`'s order: search, compose,
/// settings. Search is the bar's own field (`BarSearch`); what it finds
/// shows over home, which stays where it was.
final class AgentHomeViewController: UIViewController, DockHosting {
    private let context: AppContext
    private let id: String
    private let v2: HomeViewController
    private(set) lazy var search = BarSearch(host: self, placeholder: Strings.search, fieldIdentifier: "search-field")
    private var observation: AccountsObservation?
    private var switcher: AccountSwitcher?
    private var live = true

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
        search.onActiveChanged = { [weak self] in self?.updateBar() }
        v2.onSearchEnded = { [weak self] in self?.search.end() }
        v2.onSnapshot = { [weak self] snapshot in
            guard let self, snapshot.live != live else { return }
            live = snapshot.live
            updateTitle()
        }
        switcher = AccountSwitcher(context: context, controller: self)
        observation = context.account.observeAccounts { [weak self] _ in self?.updateTitle() }
        updateTitle()
        updateBar()
    }

    /// The connection, under the account's name until it is live.
    private func updateTitle() {
        switcher?.subtitle = live ? nil : Strings.Home.connectionStatus(.connecting)
    }

    /// The switcher at the left and the actions at the right, or the search
    /// field while it is open.
    private func updateBar() {
        guard !search.applies(to: navigationItem), let switcher else { return }
        navigationItem.leftBarButtonItem = switcher.barItem
        var items: [HeaderBar.Trailing: UIBarButtonItem] = [
            .search: HeaderBar.searchItem { [weak self] in self?.search.begin() },
            .settings: HeaderBar.settingsItem { [weak self] in self?.openSettings() },
        ]
        if let host = self as UIViewController as? ComposeHosting {
            items[.compose] = HeaderBar.composeItem { [weak host] in host?.compose() }
        }
        navigationItem.rightBarButtonItems = HeaderBar.trailing(items)
    }

    /// The bar shades whichever list is under it: the results while they
    /// cover home, home's own otherwise.
    private func updateEdge() {
        HeaderBar.edge(v2.resultsList ?? v2.list, in: self)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        v2.contentInsets = HomeContentInsets(underBar: LayoutInsets(view.safeAreaInsets), dock: HomeDockLayout.Metrics.contentInset)
    }

    var newWorkDock: UIView { v2.newWorkDock }

    /// Search is open: compose and the like close it first.
    var isSearching: Bool { search.isActive }

    func endSearch() { search.end() }

    private func openSettings() {
        SettingsViewController.open(context: context, computer: id, from: self)
    }
}
#endif
