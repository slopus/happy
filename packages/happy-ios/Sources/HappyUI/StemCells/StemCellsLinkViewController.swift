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
/// centred over them, chooses the way: Relay,
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
    /// Relay screens already holding the room of Direct's steps.
    private var reservesSteps: Set<ObjectIdentifier> = []
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
        let layout = StemCellsLinkSwitchLayout(accessory: screen.convert(frame, to: switchClip), tag: tag.intrinsicContentSize)
        control.frame = layout.control
        tag.frame = layout.tag
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
        // Direct's steps are the tallest: Relay's screens hold their room
        // too, so the switch and the buttons stay put as the two cross.
        if method == .relay, let screen, reservesSteps.insert(ObjectIdentifier(screen)).inserted {
            screen.reserve(StemCellsLinkContentView())
        }
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
        content.onOpenWebsite = { UIApplication.shared.open(Strings.Onboarding.desktopURL) }
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

/// The title, centred, then what to do on the computer in numbered steps: the relay checklist's two (install, open Link Mobile
/// App), then the scan.
final class StemCellsLinkContentView: UIView {
    /// The install step's happy.engineering, tapped.
    var onOpenWebsite: (() -> Void)?
    private let title = StyledLabel(style: TextStyles.onboardingTitle, color: Palette.text, alignment: .center)
    private let numbers: [UILabel] = (1...3).map { _ in UILabel() }
    private let stepTitles: [StyledLabel] = (1...3).map { _ in StyledLabel(style: TextStyles.checklistTitle, color: Palette.text) }
    private let bodies: [StyledLabel] = (1...3).map { _ in StyledLabel(style: TextStyles.checklistBody, color: Palette.textSecondary) }

    override init(frame: CGRect) {
        super.init(frame: frame)
        title.string = Strings.StemCells.linkTitle
        title.accessibilityTraits = .header
        addSubview(title)
        let steps = [
            (Strings.Onboarding.installStep, Strings.Onboarding.installBodyPrefix + Strings.Onboarding.installBodyLink + Strings.Onboarding.installBodySuffix),
            (Strings.Onboarding.openStep, Strings.Onboarding.openBody),
            (Strings.StemCells.linkScanStep, Strings.StemCells.linkScanBody),
        ]
        for (index, step) in steps.enumerated() {
            let number = numbers[index]
            number.text = "\(index + 1)"
            number.font = StemCellsFonts.ui(.semiBold, size: 14)
            number.textColor = UIColor(Palette.text)
            number.textAlignment = .center
            number.layer.borderWidth = 1.5
            number.layer.cornerRadius = ChecklistRowLayout.Metrics.boxSize / 2
            number.isAccessibilityElement = false
            stepTitles[index].string = step.0
            stepTitles[index].accessibilityLabel = "\(index + 1). \(step.0)"
            stepTitles[index].accessibilityIdentifier = "stem-link-step-\(index + 1)"
            bodies[index].string = step.1
            for view in [number, stepTitles[index], bodies[index]] as [UIView] { addSubview(view) }
        }
        bodies[0].decoration = { text in
            let range = (text.string as NSString).range(of: Strings.Onboarding.installBodyLink)
            guard range.location != NSNotFound else { return }
            text.addAttributes([.underlineStyle: NSUnderlineStyle.single.rawValue, .foregroundColor: UIColor(Palette.text)], range: range)
        }
        bodies[0].isUserInteractionEnabled = true
        bodies[0].accessibilityTraits.insert(.link)
        bodies[0].addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(openWebsite)))
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    @objc private func openWebsite() { onOpenWebsite?() }

    private func applyColors() {
        for number in numbers { number.layer.borderColor = UIColor(Palette.textSecondary).resolvedColor(with: traitCollection).cgColor }
    }

    private func layout(width: CGFloat) -> StemCellsLinkContentLayout {
        StemCellsLinkContentLayout(width: width, title: title.measurable, steps: stepTitles.indices.map {
            .init(title: stepTitles[$0].measurable, body: bodies[$0].measurable)
        })
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize { layout(width: size.width).size }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        title.setLayoutFrame(layout.title)
        for (index, step) in layout.steps.enumerated() {
            numbers[index].frame = step.box
            stepTitles[index].setLayoutFrame(step.title)
            if let body = step.body { bodies[index].setLayoutFrame(body) }
        }
    }
}
#endif
