#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The link sheet's own stack: adding a computer over settings, with the
/// screens it opens pushed inside it. Swiping it down ends the whole of it,
/// wherever it is; a Happy account half added is no longer being added.
final class StemCellsLinkNavigationController: UINavigationController {
    private var context: AppContext?

    static func present(context: AppContext, from controller: UIViewController) {
        let navigation = StemCellsLinkNavigationController(rootViewController: StemCellsLinkViewController(context: context, inSheet: true))
        navigation.context = context
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        navigation.modalPresentationStyle = .pageSheet
        controller.present(navigation, animated: true)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed, context?.account.isAddingAccount == true { context?.account.cancelAddingAccount() }
    }
}

/// Linking a computer, as Telegram adds an account (its techniques, none
/// of its code): the first screen when nothing is paired, and the sheet
/// "+" opens over settings. A switch just above the screen's buttons,
/// across them, chooses the way: Relay,
/// the default, through a Happy account (Welcome, or Link Your Computer
/// once one is signed in); or Direct, the experiment (tagged Beta), whose code scanned
/// or link pasted connects this phone straight to the computer. Choosing
/// Direct turns the experiment on (`StemCellsExperiments`), and the
/// switch shows it as it stands; choosing Relay turns it off too, unless
/// computers are paired, which only Settings hides. Nothing of a profile
/// shows; the first screen keeps its gear, to the server and the
/// experiment. Bars and buttons are liquid glass, and so are those of the
/// screens it opens.
final class StemCellsLinkViewController: UIViewController {
    private let context: AppContext
    private let inSheet: Bool
    private let bar = StemCellsGlassBar()
    private let control = UISegmentedControl(items: [Strings.StemCells.relay, Strings.StemCells.direct])
    private let tag = StemCellsBetaTag()
    /// Holds the switch and its tag clipped to the shown screen's scroll
    /// area, under the glass bar: they scroll with the screen, never over
    /// the bar or Get help. Touches off them go through.
    private let switchClip = PassthroughView()
    private var scrollWatch: NSKeyValueObservation?
    private var method: PairingMethod
    private var shown: UIViewController?
    private lazy var directScreen = StemCellsDirectLinkViewController(context: context)
    private var relayScreen: UIViewController?
    private var loggedShown = false

    private var surface: PairingSurface { inSheet ? .addComputer : .onboarding }

    /// `inSheet`: over settings, with a close button; otherwise the
    /// window's root.
    init(context: AppContext, inSheet: Bool) {
        self.context = context
        self.inSheet = inSheet
        method = StemCellsPreference(variant: context.variant).directConnection ? .direct : .relay
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.groupedBackground)
        view.accessibilityIdentifier = "stem-link"
        control.accessibilityIdentifier = "stem-link-method"
        control.addAction(UIAction { [weak self] _ in self?.chosen() }, for: .valueChanged)
        switchClip.clipsToBounds = true
        switchClip.addSubview(control)
        switchClip.addSubview(tag)
        view.addSubview(switchClip)
        if inSheet {
            bar.closes = true
            bar.onClose = { [weak self] in self?.dismiss(animated: true) }
        } else {
            bar.actions = [StemCellsGlassBar.Action(image: .icon(.ionicons("settings-outline"), size: 22), label: Strings.Onboarding.settingsTitle, id: "stem-link-settings") { [weak self] in self?.openSettings() }]
        }
        StemCellsGlassChrome.install(bar, on: self)
        show(method, animated: false)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Back from settings, where the experiment may have changed.
        let now: PairingMethod = StemCellsPreference(variant: context.variant).directConnection ? .direct : .relay
        if now != method {
            method = now
            show(now, animated: false)
        }
        syncAddingAccount()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !loggedShown else { return }
        loggedShown = true
        PairingAnalytics.shared.log(.optionsShown(options: [.relay, .direct], selected: method, surface: surface))
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        shown?.view.frame = view.bounds
        placeSwitch()
    }

    /// Where the shown screen keeps room for it, as that screen scrolls.
    private func placeSwitch() {
        guard let screen = shown?.view as? OnboardingScreenView, let frame = screen.accessoryFrame else { return }
        switchClip.frame = screen.convert(screen.scrollView.frame, to: view)
        control.frame = screen.convert(frame, to: switchClip)
        tag.frame = StemCellsLinkSwitchLayout(control: control.frame, tag: tag.intrinsicContentSize).tag
    }

    private func chosen() {
        let to: PairingMethod = control.selectedSegmentIndex == 1 ? .direct : .relay
        guard to != method else { return }
        PairingAnalytics.shared.log(.optionSelected(from: method, to: to, surface: surface))
        method = to
        let preference = StemCellsPreference(variant: context.variant)
        // One preference with Settings' switch; Relay leaves paired
        // computers where they are.
        if (to == .direct) != preference.directConnection, to == .direct || context.account.direct.accounts.isEmpty {
            StemCellsExperiments.turn(to == .direct, context: context, surface: surface)
        }
        show(to, animated: true)
        syncAddingAccount()
    }

    /// The chosen way's screen, in place under the switch.
    private func show(_ method: PairingMethod, animated: Bool) {
        control.selectedSegmentIndex = method == .direct ? 1 : 0
        let next: UIViewController
        if method == .direct {
            next = directScreen
        } else {
            if relayScreen == nil { relayScreen = Self.relayScreen(context: context, inSheet: inSheet) }
            next = relayScreen!
        }
        guard next !== shown else { return }
        let previous = shown
        shown = next
        addChild(next)
        let screen = next.view as? OnboardingScreenView
        screen?.usesGlass = true
        screen?.accessoryHeight = StemCellsLinkSwitchLayout.Metrics.height
        screen?.onLayout = { [weak self, weak next] in
            guard let self, let next, next === shown else { return }
            placeSwitch()
        }
        scrollWatch = screen?.scrollView.observe(\.contentOffset) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.placeSwitch() }
        }
        let from = view.convert(control.frame, from: switchClip)
        view.insertSubview(next.view, belowSubview: switchClip)
        // Laid out through this view, so the new screen has its safe area
        // (the bar's row included) before the switch is placed on it.
        view.setNeedsLayout()
        view.layoutIfNeeded()
        next.didMove(toParent: self)
        previous?.willMove(toParent: nil)
        let finish = { [weak self, weak previous] in
            // Chosen again while it faded out: it stays.
            guard let previous, previous !== self?.shown else { return }
            previous.view.removeFromSuperview()
            previous.removeFromParent()
        }
        guard animated, let previous else { return finish() }
        next.view.alpha = 0
        // The switch moves to where this screen keeps it as the screens cross.
        let to = (control.frame, tag.frame)
        let start = switchClip.convert(from, from: view)
        control.frame = start
        tag.frame = StemCellsLinkSwitchLayout(control: start, tag: tag.intrinsicContentSize).tag
        UIView.animate(withDuration: 0.25, animations: {
            next.view.alpha = 1
            previous.view.alpha = 0
            self.control.frame = to.0
            self.tag.frame = to.1
        }, completion: { [weak self] _ in
            if previous !== self?.shown { previous.view.alpha = 1 }
            finish()
        })
    }

    /// Signing up or in from the sheet adds an account beside the profiles
    /// there are; from the first screen it is the first.
    private func syncAddingAccount() {
        let adding = inSheet && method == .relay && context.account.session == nil
        if adding, !context.account.isAddingAccount { context.account.beginAddingAccount() }
        if !adding, context.account.isAddingAccount { context.account.cancelAddingAccount() }
    }

    private func openSettings() {
        guard navigationController?.topViewController === self, navigationController?.transitionCoordinator == nil else { return }
        let settings = OnboardingSettingsViewController(context: context)
        StemCellsGlassChrome.dress(settings, over: self)
        navigationController?.pushViewController(settings, animated: true)
    }

    /// Linking through the relay: a signed-in account links the computer;
    /// otherwise one is made or restored first. In the sheet, nothing of
    /// settings: no gear to the server.
    static func relayScreen(context: AppContext, inSheet: Bool) -> UIViewController {
        if let session = context.account.session {
            let link = LinkComputerViewController(context: context, session: session)
            if inSheet { link.onLinked = { [weak link] in link?.navigationController?.dismiss(animated: true) } }
            return link
        }
        return WelcomeViewController(context: context, offersPairing: false, offersServer: false)
    }
}

/// Direct's way: the computer's code scanned, or its link pasted.
final class StemCellsDirectLinkViewController: UIViewController {
    private let context: AppContext
    private let content = StemCellsLinkContentView()
    private lazy var screen = OnboardingScreenView(
        content: content,
        primary: RoundButton(title: Strings.Onboarding.scanButton),
        secondary: RoundButton(title: Strings.Onboarding.pasteLink, size: .normal, display: .inverted)
    )

    init(context: AppContext) {
        self.context = context
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func loadView() { view = screen }

    override func viewDidLoad() {
        super.viewDidLoad()
        screen.usesGlass = true
        screen.primary.onTap = { [weak self] in self?.scan() }
        screen.secondary.onTap = { [weak self] in self?.paste() }
        screen.secondary.accessibilityIdentifier = "stem-link-paste"
        screen.help.onTap = { [weak self] in
            guard let self else { return }
            Alerts.help(on: self)
        }
    }

    private func scan() {
        Task { @MainActor in
            guard let text = await PairingFlow.scan(.terminal, from: self) else {
                return PairingAnalytics.shared.log(.cancelled(method: .direct, start: .scan))
            }
            StemCellsScan.open(text, context: context, on: self, start: .scan)
        }
    }

    private func paste() {
        Task { @MainActor in
            let text = await Alerts.prompt(
                Strings.Onboarding.pasteLinkTitle,
                Strings.Onboarding.pasteLinkMessage,
                placeholder: "happy://…",
                confirmTitle: Strings.Onboarding.pasteLinkConfirm,
                on: self
            )
            guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
                return PairingAnalytics.shared.log(.cancelled(method: .direct, start: .pasteLink))
            }
            StemCellsScan.open(text, context: context, on: self, start: .pasteLink)
        }
    }
}

/// Direct's "Beta" tag on the switch: small capitals in a capsule.
final class StemCellsBetaTag: UILabel {
    override init(frame: CGRect) {
        super.init(frame: frame)
        text = Strings.StemCells.beta.uppercased()
        font = StemCellsFonts.ui(.semiBold, size: 10)
        textColor = .white
        textAlignment = .center
        backgroundColor = UIColor(Palette.stemCellsSettingsTilePurple)
        layer.cornerRadius = 9
        layer.cornerCurve = .continuous
        clipsToBounds = true
        accessibilityLabel = Strings.StemCells.beta
        accessibilityIdentifier = "stem-link-beta"
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var intrinsicContentSize: CGSize {
        let text = super.intrinsicContentSize
        return CGSize(width: text.width + 14, height: 18)
    }
}

/// Happy's mark, the title and what to do on the computer, centred.
final class StemCellsLinkContentView: UIView {
    private let mark = UIImageView(image: UIImage.happy("logo-black")?.withRenderingMode(.alwaysTemplate))
    private let title = StyledLabel(style: TextStyles.onboardingTitle, color: Palette.text, alignment: .center)
    private let body = StyledLabel(style: TextStyles.checklistBody, color: Palette.textSecondary, alignment: .center)

    override init(frame: CGRect) {
        super.init(frame: frame)
        mark.tintColor = UIColor(Palette.text)
        mark.contentMode = .scaleAspectFit
        title.string = Strings.StemCells.linkTitle
        title.accessibilityTraits = .header
        body.string = Strings.StemCells.linkBody
        for view in [mark, title, body] as [UIView] { addSubview(view) }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func layout(width: CGFloat) -> StemCellsLinkContentLayout {
        StemCellsLinkContentLayout(width: width, title: title.measurable, body: body.measurable)
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize { layout(width: size.width).size }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        mark.frame = layout.mark
        title.setLayoutFrame(layout.title)
        body.setLayoutFrame(layout.body)
    }
}
#endif
