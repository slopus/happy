#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The first screen, shown while the phone has no Happy account and no
/// agent connection; Android's (ui/start). No bar: Grain Gradient fills
/// the window behind the status bar. ? at the top right is Get help, with
/// the logotype, small, on its row; desktop's welcome slides
/// (`StartGalleryView`) are in the middle; Start (48 above the bottom, as
/// wide as its label) opens `InstallDesktopViewController`, which says to
/// get Happy for the computer and scans its code, and whose ⋯ has the other
/// self-hosted ways in; Use Happy Cloud, a text action under Start where
/// Happy Cloud is offered, opens Happy Cloud's welcome. There is no Create
/// account: a computer's code makes one. `StartLayout` places it all.
///
/// The palette is Android's: deep blue and violet over near-black in dark
/// mode, their pale tints over lavender white in light; every colour behind
/// the text keeps it at WCAG AA or better.
final class StartViewController: UIViewController {
    enum Colors {
        static let grain = GrainPalette(
            back: dynamic(0x06050F, 0xF4F2FF),
            colors: [dynamic(0x4338CA, 0x818CF8), dynamic(0x7C3AED, 0xC4B5FD), dynamic(0x1D4ED8, 0x93C5FD), dynamic(0x2A00FF, 0xA78BFA)]
        )
        static let text = UIColor(Palette.startText)

        private static func dynamic(_ dark: UInt32, _ light: UInt32) -> UIColor {
            UIColor { $0.userInterfaceStyle == .dark ? rgb(dark) : rgb(light) }
        }

        private static func rgb(_ value: UInt32) -> UIColor {
            UIColor(red: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255, blue: CGFloat(value & 0xFF) / 255, alpha: 1)
        }
    }

    private let context: AppContext
    private let gradient = GrainGradientView(palette: Colors.grain)
    private let scroll = UIScrollView()
    private let logo = UIImageView()
    private let gallery = StartGalleryView()
    private let start = RoundButton(title: Strings.Start.button)
    /// Happy Cloud, a text action under Start rather than in ⋯, where it is
    /// offered: a phone needs no computer for it.
    private let cloud = StartViewController.cloudButton()
    /// ?, Get help, where ⋯ was: the other ways in are on the next screens.
    private let help = UIButton(type: .system)
    private var offersCloud: Bool { HappyCloud.isOffered(in: context.variant) }

    init(context: AppContext) {
        self.context = context
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "start"
        gradient.frame = view.bounds
        gradient.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(gradient)
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.showsVerticalScrollIndicator = false
        scroll.alwaysBounceVertical = false
        view.addSubview(scroll)
        logo.contentMode = .scaleAspectFit
        logo.isAccessibilityElement = true
        logo.accessibilityLabel = Strings.Start.logo
        logo.accessibilityTraits = .header
        scroll.addSubview(logo)
        start.accessibilityIdentifier = "start-button"
        start.onTap = { [weak self] in self?.next() }
        scroll.addSubview(gallery)
        scroll.addSubview(start)
        cloud.accessibilityIdentifier = "start-cloud"
        cloud.onTap = { [weak self] in
            guard let self else { return }
            AccountAdding.connectToCloud(context: context, from: self)
        }
        cloud.isHidden = !offersCloud
        scroll.addSubview(cloud)
        help.setImage(UIImage(systemName: "questionmark.circle", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold)), for: .normal)
        help.tintColor = Colors.text
        help.accessibilityLabel = Strings.Onboarding.getHelp
        help.accessibilityIdentifier = "start-help"
        help.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            Alerts.help(on: self)
        }, for: .touchUpInside)
        view.addSubview(help)
        updateLogo()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.updateLogo() }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(true, animated: animated)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        gallery.isRunning = true
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        gallery.isRunning = false
        // The screens it opens have their bar.
        if navigationController?.topViewController !== self {
            navigationController?.setNavigationBarHidden(false, animated: animated)
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let bounds = view.bounds
        let layout = StartLayout(
            size: bounds.size,
            safeArea: LayoutInsets(view.safeAreaInsets),
            button: start.layout(width: StartLayout.Metrics.buttonMinWidth).size,
            cloud: offersCloud ? cloud.layout(width: StartLayout.Metrics.buttonMinWidth).size : .zero,
            slides: gallery.slides,
            dots: gallery.dotsSize
        )
        scroll.frame = bounds
        scroll.contentSize = CGSize(width: bounds.width, height: view.safeAreaInsets.top + layout.contentHeight + view.safeAreaInsets.bottom)
        logo.frame = layout.logo
        gallery.setLayoutFrame(layout.gallery)
        gallery.apply(layout)
        start.frame = layout.button
        cloud.frame = layout.cloud
        help.frame = layout.help
    }

    /// Use Happy Cloud: a text action in the slides' secondary colour, so
    /// Start stays the one filled button. The screen after Start measures
    /// one too, so its button rises as Start does.
    static func cloudButton() -> RoundButton {
        let button = RoundButton(title: Strings.Start.cloud, size: .normal, display: .inverted)
        button.label.color = Palette.startTextSecondary
        button.spinner.color = UIColor(Palette.startTextSecondary)
        return button
    }

    /// The light logotype on the dark gradient, the dark one on the light.
    private func updateLogo() {
        logo.image = UIImage.happy(traitCollection.userInterfaceStyle == .dark ? "logotype-light" : "logotype-dark")
    }

    /// Getting Happy for the computer, then its code.
    private func next() {
        navigationController?.pushViewController(InstallDesktopViewController(context: context), animated: true)
    }
}

/// ⋯'s menu on the screen after Start: the self-hosted ways in besides
/// scanning (`AccountAdding`), and help. The first screen has no ⋯.
@MainActor
enum StartMenu {
    static func items(context: AppContext, from controller: UIViewController, busy: Bool, setBusy: @escaping (Bool) -> Void) -> [UIMenuElement] {
        let enabled: UIMenuElement.Attributes = busy ? .disabled : []
        let ways = AccountAdding.otherWays(context: context, from: controller, busy: setBusy).map { way in
            let action = UIAction(title: way.title, image: UIImage(systemName: way.symbol), attributes: enabled) { _ in way.run() }
            if way.symbol == "server.rack" { action.subtitle = context.customServerHost ?? Strings.Onboarding.settingsServerDefault }
            return action
        }
        return [
            UIMenu(options: .displayInline, children: ways),
            UIMenu(options: .displayInline, children: [
                UIAction(title: Strings.Onboarding.getHelp, image: UIImage(systemName: "questionmark.circle")) { [weak controller] _ in
                    guard let controller else { return }
                    Alerts.help(on: controller)
                },
            ]),
        ]
    }
}
#endif
