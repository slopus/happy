#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// What a relay account's home shows in place of the list while it has
/// nothing to list, under home's own bar (title, connection, account menu,
/// settings): never a screen of its own, never onboarding.
///   - before the computers are known: nothing, the bar saying it connects;
///   - no computer: scan one's code to connect it to this account;
///   - every computer offline: their state, and Troubleshoot.
/// It is `NoSessionsView` with other words and buttons.
final class HomeNoticeViewController: UIViewController {
    enum Kind: Equatable {
        case connecting
        case noComputer
        case offline([MachineChoice], hasArchived: Bool)
    }

    var kind: Kind {
        didSet { if kind != oldValue, isViewLoaded { update() } }
    }

    private let context: AppContext
    private let session: AccountSession
    private let content = NoSessionsView()
    private var scanning = false

    init(context: AppContext, session: AccountSession, kind: Kind) {
        self.context = context
        self.session = session
        self.kind = kind
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func loadView() {
        view = content
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "home-notice"
        // As wide as its words, as the first screen's Start.
        content.fitsButtonToLabel = true
        content.startNewSession.onTap = { [weak self] in self?.primary() }
        content.showArchived.onTap = { [weak self] in
            self?.session.updateSettings(["hideInactiveSessions": .bool(false)])
        }
        update()
    }

    private func update() {
        content.scrollView.alpha = kind == .connecting ? 0 : 1
        content.isAccessibilityElement = kind == .connecting
        content.accessibilityLabel = kind == .connecting ? Strings.Home.connectionStatus(.connecting) : nil
        switch kind {
        case .connecting:
            content.showsArchivedAction = false
            scene(.snail)
        case .noComputer:
            // Empty with the thing that fills it right there: desktop's wand.
            scene(.wand)
            content.titleLabel.string = Strings.Home.noComputerTitle
            content.descriptionLabel.string = Strings.Home.noComputerDescription
            content.startNewSession.title = Strings.scanQRCode
            content.showsArchivedAction = false
        case .offline(let choices, let hasArchived):
            // Desktop deliberately has no art for offline: the glyph stays.
            content.artwork = nil
            content.titleLabel.string = choices.count == 1 ? Strings.Onboarding.offlineTitleOne(name: choices[0].name) : Strings.Onboarding.offlineTitleMany
            content.descriptionLabel.string = Strings.Home.offlineDescription
            content.startNewSession.title = Strings.Troubleshoot.title
            content.showsArchivedAction = hasArchived
        }
        content.setNeedsLayout()
    }

    /// The desktop picture for this notice, in the glyph's box; one is
    /// kept and re-pointed rather than rebuilt, so changing kind in
    /// place does not restart a play that is already resting.
    private func scene(_ wanted: StateScene) {
        if let showing = content.artwork as? StateSceneView {
            showing.scene = wanted
            return
        }
        content.artwork = StateSceneView(
            scene: wanted,
            size: NoSessionsLayout.Metrics.iconSize,
            replayLabel: Strings.Home.noComputerTitle
        )
    }

    private func primary() {
        switch kind {
        case .connecting:
            break
        case .noComputer:
            // A computer's code connects it to this account.
            guard !scanning else { return }
            scanning = true
            Task { [weak self] in
                guard let self else { return }
                await HappyScan.scan(intent: .connect, context: context, on: self) { [weak self] in self?.content.startNewSession.isLoading = $0 }
                scanning = false
            }
        case .offline:
            navigationController?.pushViewController(TroubleshootViewController(context: context, session: session), animated: true)
        }
    }
}
#endif
