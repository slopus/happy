#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Every screen's bar but Start's: UIKit's own navigation bar, clear over the
/// screen's own background, with the content running under it and iOS 26's
/// soft scroll edge as its shade. Home's buttons are the same on both homes:
/// search (or the legacy filter), compose and settings at the right, in
/// `Trailing`'s order.
@MainActor
enum HeaderBar {
    /// The right group as it reads from the left. One place, so the order
    /// is a one-line change. A legacy home has its filter menu where an
    /// agent connection's home has search.
    enum Trailing: CaseIterable {
        case filter, search, compose, more, settings
    }

    /// Every bar's look, set once on the navigation bar
    /// (`AppCoordinator.applyAppearance`): no ground and no line, so the bar
    /// is the screen's own background, whatever that is, with nothing to
    /// seam against it. The same at the scroll edge and scrolled, so nothing
    /// changes as a list moves under it; iOS 26's scroll edge is its shade.
    static var appearance: UINavigationBarAppearance {
        let appearance = UINavigationBarAppearance()
        appearance.configureWithTransparentBackground()
        appearance.titleTextAttributes = AppCoordinator.nativeTitleAttributes
        return appearance
    }

    static func apply(to bar: UINavigationBar) {
        let appearance = appearance
        bar.standardAppearance = appearance
        bar.scrollEdgeAppearance = appearance
        bar.compactAppearance = appearance
        bar.compactScrollEdgeAppearance = appearance
        bar.tintColor = UIColor(Palette.headerTint)
    }

    /// Tells the bar which scroll view runs under it, so iOS 26 shades its
    /// top edge softly. Screens whose scroll view is a child's need it said.
    static func edge(_ scrollView: UIScrollView, in controller: UIViewController) {
        if #available(iOS 26.0, *) { scrollView.topEdgeEffect.style = .soft }
        controller.setContentScrollView(scrollView, for: .top)
    }

    /// `items` in `Trailing`'s order, as `rightBarButtonItems` wants them:
    /// the first is the outermost.
    static func trailing(_ items: [Trailing: UIBarButtonItem]) -> [UIBarButtonItem] {
        Trailing.allCases.compactMap { items[$0] }.reversed()
    }

    static func searchItem(_ action: @escaping () -> Void) -> UIBarButtonItem {
        let item = UIBarButtonItem(image: .icon(.ionicons("search-outline"), size: 22), primaryAction: UIAction { _ in action() })
        item.accessibilityLabel = Strings.search
        item.accessibilityIdentifier = "search"
        return item
    }

    static func composeItem(_ action: @escaping () -> Void) -> UIBarButtonItem {
        let item = UIBarButtonItem(image: .icon(.ionicons("create-outline"), size: 22), primaryAction: UIAction { _ in action() })
        item.accessibilityLabel = Strings.newWork
        item.accessibilityIdentifier = "compose"
        return item
    }

    static func settingsItem(_ action: @escaping () -> Void) -> UIBarButtonItem {
        let item = UIBarButtonItem(image: .icon(.ionicons("settings-outline"), size: 22), primaryAction: UIAction { _ in action() })
        item.accessibilityLabel = Strings.openSettings
        item.accessibilityIdentifier = "settings"
        return item
    }

    static func chatMenuItem(_ action: @escaping () -> Void) -> UIBarButtonItem {
        let image = UIImage(systemName: "ellipsis", withConfiguration: UIImage.SymbolConfiguration(pointSize: 22))
        let item = UIBarButtonItem(image: image, primaryAction: UIAction { _ in action() })
        item.accessibilityLabel = Strings.ChatActions.more
        item.accessibilityIdentifier = "chat-more"
        return item
    }

    /// The public navigation bar's bounds, in the menu's host view.
    static func menuAnchor(in controller: UIViewController) -> CGRect {
        guard let bar = controller.navigationController?.navigationBar else { return .zero }
        return bar.convert(bar.bounds, to: controller.view)
    }
}

/// Search that opens from the screen's own bar button: a field takes the
/// bar, with Cancel, and the bar's other items step aside until it closes.
/// It is a plain `UISearchBar`, not the navigation item's search controller:
/// UIKit's search button (`searchBarPlacementBarButtonItem`) raises when
/// moved, and a presented search controller changes the bar and the
/// screen's insets, which moved the list under it. This changes nothing
/// but the bar's own items.
@MainActor
final class BarSearch: NSObject, UISearchBarDelegate {
    let bar = UISearchBar()
    private weak var host: UIViewController?
    /// The field is open.
    private(set) var isActive = false
    var query: String { bar.text ?? "" }
    var onBegin: (() -> Void)?
    var onChange: ((String) -> Void)?
    var onEnd: (() -> Void)?
    /// The bar's items are to be set again for `isActive`.
    var onActiveChanged: (() -> Void)?

    init(host: UIViewController, placeholder: String, fieldIdentifier: String) {
        self.host = host
        super.init()
        bar.delegate = self
        bar.placeholder = placeholder
        bar.searchBarStyle = .minimal
        bar.showsCancelButton = true
        bar.searchTextField.accessibilityIdentifier = fieldIdentifier
    }

    func begin() {
        guard !isActive, let host, host.navigationController?.topViewController === host, host.presentedViewController == nil else { return }
        isActive = true
        bar.text = ""
        onBegin?()
        onActiveChanged?()
        bar.becomeFirstResponder()
    }

    func end() {
        guard isActive else { return }
        isActive = false
        bar.resignFirstResponder()
        bar.text = ""
        onEnd?()
        onActiveChanged?()
    }

    /// The field in the bar while it is open; the screen calls this where it
    /// sets its items, and sets its own only when it returns false.
    func applies(to item: UINavigationItem) -> Bool {
        guard isActive else {
            if item.titleView === bar { item.titleView = nil }
            return false
        }
        item.leftBarButtonItems = nil
        item.rightBarButtonItems = nil
        item.titleView = bar
        return true
    }

    func searchBar(_ searchBar: UISearchBar, textDidChange searchText: String) {
        guard isActive else { return }
        onChange?(searchText)
    }

    func searchBarSearchButtonClicked(_ searchBar: UISearchBar) {
        searchBar.resignFirstResponder()
    }

    func searchBarCancelButtonClicked(_ searchBar: UISearchBar) {
        end()
    }
}
#endif
