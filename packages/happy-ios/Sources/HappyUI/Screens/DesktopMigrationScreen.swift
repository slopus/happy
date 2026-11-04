#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Which move the Happy CLI home asks for:
///   - `desktop`: no Happy Agent anywhere; install Happy Desktop and
///     connect this phone to it;
///   - `agentConnection`: a Happy Agent machine already reaches this
///     account through the Happy server (`SessionList.hasServerAgent`);
///     only connect to it directly.
enum MigrationPath: String, Hashable, Sendable {
    case desktop
    case agentConnection

    private typealias S = Strings.DesktopMigration

    var title: String { self == .desktop ? S.desktopTitle : S.agentConnectionTitle }
    var body: String { self == .desktop ? S.desktopBody : S.agentConnectionBody }
    var steps: [Strings.DesktopMigration.Step] { self == .desktop ? S.desktopSteps : S.agentConnectionSteps }
    var icon: LineIcon { self == .desktop ? .monitor : .zap }
}

/// Whether the Happy CLI home shows a migration card, and which: none
/// unless PostHog's flag is on for the account (`MigrationNoteFlag`), none
/// once this phone has a direct Happy Agent connection (paired and not
/// revoked), nor once that path's card was closed here, which holds for
/// every account on this phone.
@MainActor
enum DesktopMigrationCard {
    static func path(_ account: AccountController, serverAgent: Bool, flag: Bool, defaults: UserDefaults = .standard) -> MigrationPath? {
        guard flag, !account.agentConnections.accounts.contains(where: { !$0.revoked }) else { return nil }
        let path: MigrationPath = serverAgent ? .agentConnection : .desktop
        return defaults.bool(forKey: closedKey(path)) ? nil : path
    }

    static func close(_ path: MigrationPath, defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: closedKey(path))
    }

    /// The standard defaults' key that holds a closed card.
    nonisolated static func closedKey(_ path: MigrationPath) -> String {
        "\(path.rawValue)-migration-card-closed"
    }
}

/// What the Happy CLI home's card opens, for its path, in the first-run
/// screens' look (`InstallDesktopViewController`): their Grain Gradient
/// under a clear bar, the path's picture, a slide's title and line, the
/// steps in their words (a server's case last), and their Scan QR code (the
/// one Add flow, `AccountAdding`, whose scanner reads the code Happy
/// Desktop shows) with Learn more under it. `MigrationScreenLayout` places
/// it.
final class DesktopMigrationViewController: UIViewController {
    private typealias S = Strings.DesktopMigration

    private let context: AppContext
    private let path: MigrationPath
    private let gradient = GrainGradientView(palette: StartViewController.Colors.grain)
    private let scroll = UIScrollView()
    /// The TV for Happy Desktop, as on the first-run screen; the zap for a
    /// direct connection, which no state picture means.
    private let art: UIView
    private let titleLabel: StyledLabel
    private let bodyLabel: StyledLabel
    private let numbers: [StepNumberView]
    private let steps: [StyledLabel]
    private let links: [SiteLink?]
    /// A step's words under it, in the site's type (`SiteLink`).
    private let details: [StyledLabel?]
    private let scan = RoundButton(title: S.scan)
    private let learnMore = SiteLink(prefix: "", linked: S.learnMore, identifier: "desktop-migration-learn-more")
    private var busy = false {
        didSet { scan.isLoading = busy }
    }

    init(context: AppContext, path: MigrationPath) {
        self.context = context
        self.path = path
        switch path {
        case .desktop:
            art = StateSceneView(scene: .tv, size: MigrationScreenLayout.Metrics.art, replayLabel: Strings.Start.replay(path.title))
        case .agentConnection:
            let zap = LineIconView(.zap, tint: Palette.startText)
            zap.weight = 1
            art = zap
        }
        titleLabel = StartGalleryView.titleLabel(path.title)
        bodyLabel = StartGalleryView.bodyLabel(path.body)
        numbers = path.steps.indices.map { StepNumberView(number: $0 + 1) }
        steps = path.steps.map { step in
            let label = StyledLabel(style: TextStyles.startSlideBody, color: Palette.startText)
            label.string = step.text
            return label
        }
        links = path.steps.map { step in step.link.map { _ in SiteLink() } }
        details = path.steps.map { step in
            step.detail.map { detail in
                let label = StyledLabel(style: TextStyles.secondaryAction, color: Palette.startText)
                label.string = detail
                return label
            }
        }
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "desktop-migration"
        gradient.frame = view.bounds
        gradient.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(gradient)
        // The gradient shows through the bar, as on the first-run screens.
        let bar = UINavigationBarAppearance()
        bar.configureWithTransparentBackground()
        navigationItem.standardAppearance = bar
        navigationItem.scrollEdgeAppearance = bar
        navigationItem.compactAppearance = bar
        minimalBackButton()
        scroll.contentInsetAdjustmentBehavior = .never
        view.addSubview(scroll)
        titleLabel.decoration = StartGalleryView.noOrphan
        scan.accessibilityIdentifier = "desktop-migration-scan"
        scan.onTap = { [weak self] in self?.startScan() }
        learnMore.onTap = { UIApplication.shared.open(S.learnMoreURL) }
        for link in links.compactMap({ $0 }) {
            link.onTap = { UIApplication.shared.open(Strings.Onboarding.desktopURL) }
        }
        for subview in [art, titleLabel, bodyLabel] + numbers + steps + links.compactMap({ $0 }) + details.compactMap({ $0 }) + [scan, learnMore] as [UIView] {
            scroll.addSubview(subview)
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let button = scan.layout(width: MigrationScreenLayout.Metrics.buttonMinWidth).size
        let layout = MigrationScreenLayout(
            size: view.bounds.size,
            safeArea: LayoutInsets(view.safeAreaInsets),
            title: titleLabel.measurable,
            body: bodyLabel.measurable,
            steps: numbers.indices.map { .init(number: numbers[$0].label.measurable, text: steps[$0].measurable, link: links[$0]?.label.measurable, detail: details[$0]?.measurable) },
            button: button,
            learnMore: learnMore.label.measurable
        )
        scroll.frame = view.bounds
        scroll.contentSize = CGSize(width: view.bounds.width, height: layout.contentHeight)
        art.setLayoutFrame(layout.art)
        titleLabel.setLayoutFrame(layout.title)
        bodyLabel.setLayoutFrame(layout.body)
        for (index, frames) in layout.steps.enumerated() {
            numbers[index].setLayoutFrame(frames.number)
            numbers[index].label.setLayoutFrame(frames.numberLabel)
            steps[index].setLayoutFrame(frames.text)
            if let link = frames.link { links[index]?.apply(link) }
            if let detail = frames.detail { details[index]?.setLayoutFrame(detail) }
        }
        scan.setLayoutFrame(layout.button)
        learnMore.apply(layout.learnMore)
    }

    /// The scanner; whatever it reads, `HappyScan` routes. A Happy server
    /// code beside the Happy account here asks first (`ScanIntent.migrate`).
    private func startScan() {
        guard !busy else { return }
        AccountAdding.begin(context: context, from: self, intent: .migrate) { [weak self] in self?.busy = $0 }
    }
}

/// A step's number in a filled dot, in the gradient's text colour.
/// `MigrationScreenLayout` places the dot and the number in it.
final class StepNumberView: UIView {
    let label = StyledLabel(style: TextStyle(.semiBold, size: 13, lineHeight: 16), color: Palette.surface, lines: 1, alignment: .center)

    init(number: Int) {
        super.init(frame: .zero)
        backgroundColor = UIColor(Palette.startText)
        layer.cornerRadius = MigrationScreenLayout.Metrics.numberRadius
        label.string = "\(number)"
        addSubview(label)
        isAccessibilityElement = false
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
}
#endif
