#if canImport(UIKit)
import UIKit

/// UIKit owns the bottom search field, its glass, keyboard transition and
/// cancellation. Home continues to render its own results over the list.
@MainActor
final class BarSearch: NSObject, UISearchControllerDelegate, UISearchResultsUpdating, UISearchBarDelegate {
    let controller = UISearchController(searchResultsController: nil)
    var bar: UISearchBar { controller.searchBar }
    private weak var host: UIViewController?
    private(set) var isActive = false
    var query: String { bar.text ?? "" }
    var onBegin: (() -> Void)?
    var onChange: ((String) -> Void)?
    var onEnd: (() -> Void)?

    init(host: UIViewController, placeholder: String, fieldIdentifier: String) {
        self.host = host
        super.init()
        controller.delegate = self
        controller.searchResultsUpdater = self
        controller.obscuresBackgroundDuringPresentation = false
        controller.hidesNavigationBarDuringPresentation = false
        controller.automaticallyShowsSearchResultsController = false
        bar.delegate = self
        bar.placeholder = placeholder
        bar.searchTextField.accessibilityIdentifier = fieldIdentifier
    }

    func install() {
        guard let host else { return }
        host.definesPresentationContext = true
        host.navigationItem.searchController = controller
        host.navigationItem.preferredSearchBarPlacement = .integrated
        host.navigationItem.searchBarPlacementAllowsToolbarIntegration = true
    }

    func begin() {
        guard !isActive, let host, host.navigationController?.topViewController === host,
              host.presentedViewController == nil else { return }
        setActive(true)
        controller.isActive = true
        bar.becomeFirstResponder()
    }

    func end() {
        guard isActive else { return }
        controller.isActive = false
        setActive(false)
    }

    private func setActive(_ active: Bool) {
        guard active != isActive else { return }
        isActive = active
        if active { onBegin?() }
        else {
            bar.text = ""
            onEnd?()
        }
    }

    func willPresentSearchController(_ searchController: UISearchController) { setActive(true) }
    func willDismissSearchController(_ searchController: UISearchController) { setActive(false) }

    func updateSearchResults(for searchController: UISearchController) {
        guard isActive else { return }
        onChange?(query)
    }

    func searchBarSearchButtonClicked(_ searchBar: UISearchBar) { searchBar.resignFirstResponder() }
}

@MainActor
enum HomeToolbar {
    static func show(for host: UIViewController, animated: Bool) {
        host.navigationController?.setToolbarHidden(host.toolbarItems?.isEmpty != false, animated: animated)
    }

    static func leave(_ host: UIViewController, animated: Bool) {
        guard let navigation = host.navigationController, let next = navigation.topViewController,
              next !== host else { return }
        navigation.setToolbarHidden(next.toolbarItems?.isEmpty != false, animated: animated)
    }
}
#endif