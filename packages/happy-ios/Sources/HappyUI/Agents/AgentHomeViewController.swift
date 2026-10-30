#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Home for a paired computer in development and preview builds: that
/// computer's V2 under the navigation bar. The bar has the active
/// account's picture at the left (`HomeAccountControl`), the computer's
/// name as its title with its connection under it while it isn't live,
/// and search (the bar's own, which grows into a field) and settings at
/// the right.
final class AgentHomeViewController: UIViewController, DockHosting, UISearchResultsUpdating, UISearchControllerDelegate {
    private let context: AppContext
    private let id: String
    private let titleView = NavigationTitleView()
    private let v2: HomeViewController
    private lazy var searchController = UISearchController(searchResultsController: nil)
    private var observation: AccountsObservation?
    private var accountControl: HomeAccountControl?
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
        setScaledTitleView(titleView)
        let settings = UIBarButtonItem(image: .icon(.ionicons("settings-outline"), size: 22), primaryAction: UIAction { [weak self] _ in self?.openSettings() })
        settings.accessibilityLabel = Strings.openSettings
        settings.accessibilityIdentifier = "settings"
        navigationItem.rightBarButtonItem = settings
        searchController.searchResultsUpdater = self
        searchController.delegate = self
        searchController.obscuresBackgroundDuringPresentation = false
        searchController.searchBar.placeholder = Strings.search
        searchController.searchBar.searchTextField.accessibilityIdentifier = "search-field"
        navigationItem.searchController = searchController
        navigationItem.hidesSearchBarWhenScrolling = false
        navigationItem.preferredSearchBarPlacement = .integratedButton
        // In the bar at the top, not iOS 26's toolbar at the bottom.
        if #available(iOS 26.0, *) { navigationItem.searchBarPlacementAllowsToolbarIntegration = false }
        definesPresentationContext = true
        v2.onSearchEnded = { [weak self] in
            guard let self, searchController.isActive else { return }
            searchController.isActive = false
        }
        v2.onSnapshot = { [weak self] snapshot in
            guard let self, snapshot.live != live else { return }
            live = snapshot.live
            updateTitle()
        }
        accountControl = HomeAccountControl(context: context, controller: self)
        observation = context.account.observeAccounts { [weak self] _ in self?.updateTitle() }
        updateTitle()
    }

    /// The computer's name, with "connecting" under it until it is live.
    private func updateTitle() {
        guard let account = context.account.agentConnections.accounts.first(where: { $0.id == id }) else { return }
        titleView.title = account.name
        titleView.subtitle = live ? nil : Strings.Home.connectionStatus(.connecting)
        titleView.frame.size = titleView.intrinsicContentSize
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        v2.contentInsets = HomeContentInsets(underBar: LayoutInsets(view.safeAreaInsets), dock: HomeDockLayout.Metrics.contentInset)
    }

    var newWorkDock: UIView { v2.newWorkDock }

    // MARK: Search

    func willPresentSearchController(_ searchController: UISearchController) {
        v2.beginSearch()
    }

    func updateSearchResults(for searchController: UISearchController) {
        v2.search(searchController.searchBar.text ?? "")
    }

    func willDismissSearchController(_ searchController: UISearchController) {
        v2.endSearch()
    }

    @objc private func openSettings() {
        SettingsViewController.open(context: context, computer: id, from: self)
    }
}
#endif
