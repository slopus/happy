#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// After the first screen's Start: get Happy for the computer, whose setup
/// ends by offering this phone a code, then scan it. happy-app's Link Your
/// Computer checklist on one page, in Kirill's words: the animated TV,
/// "Open Happy on your computer", where it offers this phone its code
/// (Link Mobile App in its onboarding, or Settings › Mobile Access) and
/// "Download from happy.engineering" (a link, opening the site), with Scan QR code
/// (`AccountAdding.begin`, the scanner as ever) at the bottom where Start
/// was. On the first screen's Grain Gradient, so the two read
/// as one flow, under the standard bar (clear over it) with the first
/// screen's ⋯ (`StartMenu`), so the other ways in are still a tap away.
/// `InstallDesktopLayout` places it.
final class InstallDesktopViewController: UIViewController {
    private let context: AppContext
    private let gradient = GrainGradientView(palette: StartViewController.Colors.grain)
    private let scroll = UIScrollView()
    /// The first screen's slides, measured and never shown, so this one lines up with it.
    private let slides = StartGalleryView.Measure()
    private let art = StateSceneView(scene: .tv, size: StartLayout.Metrics.art, replayLabel: Strings.Start.replay(Strings.Onboarding.offlineOpenStep))
    /// A slide's title and line, as the first screen draws them.
    private let titleLabel = StartGalleryView.titleLabel(Strings.Onboarding.offlineOpenStep)
    private let site = SiteLink()
    private let descriptionLabel = StartGalleryView.bodyLabel("\(Strings.Start.installChoose)\n\(Strings.Start.installSettings)")
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
        titleLabel.decoration = StartGalleryView.noOrphan
        site.onTap = { UIApplication.shared.open(Strings.Onboarding.desktopURL) }
        scan.accessibilityIdentifier = "install-desktop-scan"
        scan.onTap = { [weak self] in self?.startScan() }
        for subview in [art, titleLabel, site, descriptionLabel, scan] {
            scroll.addSubview(subview)
        }
        for label in slides.labels.flatMap({ [$0.title, $0.body] }) {
            label.isHidden = true
            view.addSubview(label)
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // The first screen's safe area: without this one's bar, which sits over its top row.
        var insets = view.safeAreaInsets
        if let bar = navigationController?.navigationBar, !bar.isHidden {
            insets.top = max(0, insets.top - bar.frame.height)
        }
        let safeArea = LayoutInsets(insets)
        let button = scan.layout(width: StartLayout.Metrics.buttonMinWidth).size
        let layout = InstallDesktopLayout(
            size: view.bounds.size,
            safeArea: safeArea,
            start: StartLayout(size: view.bounds.size, safeArea: safeArea, button: button, slides: slides.slides, dots: slides.dotsSize),
            title: titleLabel.measurable,
            link: site.label.measurable,
            description: descriptionLabel.measurable,
            button: button
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

/// "Download from happy.engineering", the domain underlined, a 40 tall
/// target in the gradient's text colour (the link colour is under AA on
/// its light tints), read out as it reads, a link.
private final class SiteLink: UIControl {
    let label = StyledLabel(style: TextStyles.secondaryAction, color: Palette.startText, lines: 1)
    var onTap: (() -> Void)?

    init() {
        super.init(frame: .zero)
        let prefix = Strings.Start.installDownloadPrefix
        label.string = prefix + Strings.Onboarding.installBodyLink
        label.decoration = { text in
            let domain = NSRange(location: (prefix as NSString).length, length: text.length - (prefix as NSString).length)
            text.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: domain)
        }
        label.isUserInteractionEnabled = false
        addSubview(label)
        layer.cornerRadius = TextActionLayout.Metrics.cornerRadius
        isAccessibilityElement = true
        accessibilityLabel = label.string
        accessibilityTraits = .link
        accessibilityIdentifier = "install-desktop-site"
        addTarget(self, action: #selector(tapped), for: .touchUpInside)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func apply(_ layout: InstallDesktopLayout) {
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
