#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Every screen's bar but Start's: UIKit's own navigation bar, clear over the
/// screen's own background, with the content running under it and iOS 26's
/// soft scroll edge as its shade. Home keeps account and settings here;
/// search and compose live in its native bottom toolbar.
@MainActor
enum HeaderBar {
    /// The right group as it reads from the left, shared across screens.
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
        let item = UIBarButtonItem(image: .composeIcon(), primaryAction: UIAction { _ in action() })
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

    static func chatMenuItem(_ elements: @escaping @MainActor () -> [UIMenuElement]) -> UIBarButtonItem {
        let image = UIImage(systemName: "ellipsis", withConfiguration: UIImage.SymbolConfiguration(pointSize: 22))
        let deferred = UIDeferredMenuElement.uncached { completion in completion(elements()) }
        let item = UIBarButtonItem(image: image, primaryAction: nil, menu: UIMenu(children: [deferred]))
        item.accessibilityLabel = Strings.ChatActions.more
        item.accessibilityIdentifier = "chat-more"
        return item
    }

}

#endif
