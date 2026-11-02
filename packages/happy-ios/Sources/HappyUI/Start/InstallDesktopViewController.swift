#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// After the first screen's Start: get Happy for the computer, whose setup
/// ends by offering this phone a code, then scan it. happy-app's Link Your
/// Computer checklist in its own words, on one page: the animated laptop,
/// "Install Happy on your computer", what to choose there and
/// happy.engineering (a link, opening the site), with Scan QR code
/// (`AccountAdding.begin`, the scanner as ever) at the bottom where Start
/// was. On the first screen's Grain Gradient, so the two read
/// as one flow, under the standard bar (clear over it) with the first
/// screen's ⋯ (`StartMenu`), so the other ways in are still a tap away.
/// `InstallDesktopLayout` places it.
final class InstallDesktopViewController: UIViewController {
    private let context: AppContext
    private let gradient = GrainGradientView(palette: StartViewController.Colors.grain)
    private let scroll = UIScrollView()
    private let art = StateSceneView(scene: .laptop, size: InstallDesktopLayout.Metrics.art, replayLabel: Strings.Start.replay(Strings.Onboarding.installStep))
    private let titleLabel = StyledLabel(style: TextStyles.emptyStateTitle, color: Palette.startText, alignment: .center)
    private let site = SiteLink()
    private let descriptionLabel = StyledLabel(style: TextStyles.emptyStateDescription, color: Palette.startTextSecondary, alignment: .center)
    private let scan = RoundButton(title: Strings.Onboarding.scanButton)
    private lazy var more = UIBarButtonItem(
        image: UIImage(systemName: "ellipsis"),
        menu: UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] done in
            guard let self else { return done([]) }
            done(StartMenu.items(context: context, from: self, busy: busy) { [weak self] in self?.busy = $0 })
        }])
    )
    private var busy = false {
        didSet { scan.isLoading = busy; more.isEnabled = !busy }
    }

    init(context: AppContext) {
        self.context = context
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "install-desktop"
        gradient.frame = view.bounds
        gradient.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(gradient)
        // The gradient shows through the bar.
        let bar = UINavigationBarAppearance()
        bar.configureWithTransparentBackground()
        navigationItem.standardAppearance = bar
        navigationItem.scrollEdgeAppearance = bar
        navigationItem.compactAppearance = bar
        minimalBackButton()
        more.accessibilityLabel = Strings.Start.more
        more.accessibilityIdentifier = "install-desktop-more"
        navigationItem.rightBarButtonItem = more
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.alwaysBounceVertical = false
        view.addSubview(scroll)
        titleLabel.string = Strings.Onboarding.installStep
        titleLabel.accessibilityTraits = .header
        // The checklist's second step: setup there offers this phone its code.
        descriptionLabel.string = "\(Strings.Onboarding.openStep)."
        site.onTap = { UIApplication.shared.open(Strings.Onboarding.desktopURL) }
        scan.accessibilityIdentifier = "install-desktop-scan"
        scan.onTap = { [weak self] in self?.startScan() }
        for subview in [art, titleLabel, site, descriptionLabel, scan] {
            scroll.addSubview(subview)
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let layout = InstallDesktopLayout(
            size: view.bounds.size,
            safeArea: LayoutInsets(view.safeAreaInsets),
            title: titleLabel.measurable,
            link: site.label.measurable,
            description: descriptionLabel.measurable,
            button: scan.layout(width: StartLayout.Metrics.buttonMinWidth).size
        )
        scroll.frame = view.bounds
        scroll.contentSize = CGSize(width: view.bounds.width, height: layout.contentHeight)
        art.setLayoutFrame(layout.art)
        titleLabel.setLayoutFrame(layout.title)
        site.setLayoutFrame(layout.link)
        site.apply(layout)
        descriptionLabel.setLayoutFrame(layout.description)
        scan.setLayoutFrame(layout.button)
    }

    /// The scanner; whatever it reads, `HappyScan` routes.
    private func startScan() {
        guard !busy else { return }
        AccountAdding.begin(context: context, from: self) { [weak self] in self?.busy = $0 }
    }
}

/// happy.engineering underlined behind a globe, a 40 tall target, in the
/// gradient's text colour (the link colour is under AA on its light
/// tints): read out as "Download Happy from happy.engineering", a link.
private final class SiteLink: UIControl {
    let label = StyledLabel(style: TextStyles.secondaryAction, color: Palette.startText, lines: 1)
    private let globe = IconView(.ionicons("globe-outline"), size: InstallDesktopLayout.Metrics.linkIcon, tint: Palette.startText)
    var onTap: (() -> Void)?

    init() {
        super.init(frame: .zero)
        label.string = Strings.Onboarding.installBodyLink
        label.decoration = { $0.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: NSRange(location: 0, length: $0.length)) }
        label.isUserInteractionEnabled = false
        addSubview(globe)
        addSubview(label)
        layer.cornerRadius = TextActionLayout.Metrics.cornerRadius
        isAccessibilityElement = true
        accessibilityLabel = Strings.Onboarding.installBodyPrefix + Strings.Onboarding.installBodyLink
        accessibilityTraits = .link
        accessibilityIdentifier = "install-desktop-site"
        addTarget(self, action: #selector(tapped), for: .touchUpInside)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func apply(_ layout: InstallDesktopLayout) {
        globe.setLayoutFrame(layout.linkIcon)
        label.setLayoutFrame(layout.linkLabel)
    }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? UIColor(Palette.surfacePressedOverlay) : nil }
    }

    @objc private func tapped() {
        onTap?()
    }
}
#endif
