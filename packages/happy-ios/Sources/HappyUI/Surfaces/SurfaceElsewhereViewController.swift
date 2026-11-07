#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A kind of Surface the phone doesn't open: its name in the bar and the
/// seedling with a line saying to open it on the computer.
final class SurfaceElsewhereViewController: UIViewController {
    private let empty = EmptyView()
    private let message: String
    private let identifier: String

    /// `message`: why it shows nothing here; by default, that it opens on
    /// a computer.
    init(surface: AgentWire.Surface, message: String = Strings.Todos.openOnComputer, identifier: String = "surface-elsewhere") {
        self.message = message
        self.identifier = identifier
        super.init(nibName: nil, bundle: nil)
        title = surface.name
        navigationItem.largeTitleDisplayMode = .never
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.surface)
        minimalBackButton()
        empty.message = message
        empty.showsPair = false
        empty.accessibilityIdentifier = identifier
        view.addSubview(empty)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        empty.frame = view.bounds.inset(by: view.safeAreaInsets)
    }
}
#endif
