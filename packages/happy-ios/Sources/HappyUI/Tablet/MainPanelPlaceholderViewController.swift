#if canImport(UIKit)
import HappyLayout
import UIKit

/// The main panel beside the sidebar with nothing open: the seedling and a
/// line pointing at the sidebar, centred in the panel (`EmptyLayout`), in
/// place of a stretched home.
final class MainPanelPlaceholderViewController: UIViewController {
    private let empty = EmptyView()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.surface)
        navigationItem.largeTitleDisplayMode = .never
        empty.message = Strings.Tablet.nothingOpen
        empty.showsPair = false
        empty.accessibilityIdentifier = "main-panel-placeholder"
        view.addSubview(empty)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        empty.frame = view.bounds.inset(by: view.safeAreaInsets)
    }
}
#endif
