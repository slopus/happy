#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The first screen, shown while the phone has no Happy account and no
/// agent connection; Android's (ui/start). No bar: Grain Gradient fills
/// the window behind the status bar, the logotype centred above Start,
/// Start (48 above the bottom, as wide as its label) scans a code of any kind (`HappyScan` routes it), and ⋯ at the
/// top right has the other ways in: enter a link, restore, the server, and
/// help. There is no Create account: a computer's code makes one. `StartLayout` places it all.
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
        static let text = dynamic(0xFFFFFF, 0x14112E)

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
    private let start = RoundButton(title: Strings.Start.button)
    private let more = UIButton(type: .system)
    private var busy = false {
        didSet { start.isLoading = busy; more.isEnabled = !busy }
    }

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
        start.onTap = { [weak self] in self?.scan() }
        scroll.addSubview(start)
        more.setImage(UIImage(systemName: "ellipsis", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold)), for: .normal)
        more.tintColor = Colors.text
        more.accessibilityLabel = Strings.Start.more
        more.accessibilityIdentifier = "start-more"
        more.showsMenuAsPrimaryAction = true
        more.menu = UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] done in done(self?.menuItems() ?? []) }])
        view.addSubview(more)
        updateLogo()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.updateLogo() }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(true, animated: animated)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // The screens it opens have their bar.
        if navigationController?.topViewController !== self {
            navigationController?.setNavigationBarHidden(false, animated: animated)
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let bounds = view.bounds
        let layout = StartLayout(size: bounds.size, safeArea: LayoutInsets(view.safeAreaInsets), button: start.layout(width: StartLayout.Metrics.buttonMinWidth).size)
        scroll.frame = bounds
        scroll.contentSize = CGSize(width: bounds.width, height: view.safeAreaInsets.top + layout.contentHeight + view.safeAreaInsets.bottom)
        logo.frame = layout.logo
        start.frame = layout.button
        more.frame = layout.more
    }

    /// The light logotype on the dark gradient, the dark one on the light.
    private func updateLogo() {
        logo.image = UIImage.happy(traitCollection.userInterfaceStyle == .dark ? "logotype-light" : "logotype-dark")
    }

    /// The ways in besides scanning (`AccountAdding`), and help.
    private func menuItems() -> [UIMenuElement] {
        let enabled: UIMenuElement.Attributes = busy ? .disabled : []
        let ways = AccountAdding.otherWays(context: context, from: self) { [weak self] in self?.busy = $0 }.map { way in
            let action = UIAction(title: way.title, image: UIImage(systemName: way.symbol), attributes: enabled) { _ in way.run() }
            if way.symbol == "server.rack" { action.subtitle = context.customServerHost ?? Strings.Onboarding.settingsServerDefault }
            return action
        }
        return [
            UIMenu(options: .displayInline, children: ways),
            UIMenu(options: .displayInline, children: [
                UIAction(title: Strings.Onboarding.getHelp, image: UIImage(systemName: "questionmark.circle")) { [weak self] _ in
                    guard let self else { return }
                    Alerts.help(on: self)
                },
            ]),
        ]
    }

    /// The scanner; whatever it reads, `HappyScan` routes.
    private func scan() {
        guard !busy else { return }
        AccountAdding.begin(context: context, from: self) { [weak self] in self?.busy = $0 }
    }
}
#endif
