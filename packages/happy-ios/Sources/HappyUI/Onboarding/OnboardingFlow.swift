#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A Happy Cloud server's onboarding over its home: full screen, on Happy
/// Cloud's gradient, one screen per gate in the server's order
/// (`OnboardingPlan`). Each screen takes the place of the last once the
/// server says its gate is seen to, with no Back into a finished step; a
/// progress bar under the status bar fills as gates are done.
///
/// It shows while onboarding isn't complete, and again whenever it stops
/// being so (a gate made required later). Not Now puts it away while
/// nothing blocks the person; it comes back on the next home. Finishing
/// completes onboarding (`completeOnboarding`) and opens the Chief of
/// Staff's conversation for those who may talk to it.
@MainActor
final class OnboardingFlow {
    private let session: Session
    private let context: AppContext
    /// The server's connection.
    private let id: String
    private weak var home: UIViewController?
    private var watch: Watch?
    private weak var navigation: OnboardingNavigationController?
    /// What the screen on top shows.
    private var shown: Shown?
    /// Not Now: not shown again on this home while nothing blocks.
    private var later = false
    /// Finishing: the flow ends over the Chief of Staff, whatever arrives meanwhile.
    private var finishing = false

    enum Shown: Equatable { case gate(String), update, waiting, finish }

    init(session: Session, context: AppContext, id: String, home: UIViewController) {
        self.session = session
        self.context = context
        self.id = id
        self.home = home
        watch = session.watchOnboarding { [weak self] in self?.follow($0) }
    }

    /// Home came back on screen: a flow it couldn't show then shows now.
    func homeAppeared() { follow(session.onboarding) }

    private func follow(_ onboarding: Onboarding?) {
        guard let onboarding, !finishing else { return }
        let plan = OnboardingPlan(onboarding)
        // The finish completes onboarding, where the Chief of Staff's first
        // conversation starts (`OnboardingPlan.step(showing:)`).
        guard let step = plan.step(showing: navigation != nil) else { return close() }
        // Legacy: the name could always wait.
        let blocks = !onboarding.legacy && onboarding.gates.contains(where: \.blocking)
        if navigation == nil {
            guard !later || blocks, let home, home.view.window != nil, home.presentedViewController == nil else { return }
            present(first: dressed(screen(for: step, onboarding: onboarding), blocks: blocks), shown: Self.shown(step), over: home)
        } else if Self.shown(step) != shown {
            replace(with: dressed(screen(for: step, onboarding: onboarding), blocks: blocks), shown: Self.shown(step))
        } else {
            if case .waiting(let gates) = step, let notice = navigation?.topViewController as? OnboardingNoticeViewController { notice.show(Self.waiting(gates)) }
            if let top = navigation?.topViewController { dressed(top, blocks: blocks) }
        }
        navigation?.progress.set(plan.count > 1 ? plan.progress : nil, animated: true)
    }

    /// Not Now while nothing blocks the person.
    @discardableResult
    private func dressed(_ screen: UIViewController, blocks: Bool) -> UIViewController {
        if blocks { screen.navigationItem.leftBarButtonItem = nil }
        else if screen.navigationItem.leftBarButtonItem == nil { screen.navigationItem.leftBarButtonItem = notNow }
        screen.navigationItem.hidesBackButton = true
        return screen
    }

    private static func shown(_ step: OnboardingPlan.Step) -> Shown {
        switch step {
        case .gate(let gate): .gate(gate.id)
        case .update: .update
        case .waiting: .waiting
        case .finish: .finish
        }
    }

    private var notNow: UIBarButtonItem {
        UIBarButtonItem(title: Strings.CloudOnboarding.notNow, primaryAction: UIAction { [weak self] _ in
            guard let self else { return }
            later = true
            close()
        })
    }

    // MARK: Moving between screens

    private func present(first screen: UIViewController, shown: Shown, over home: UIViewController) {
        let navigation = OnboardingNavigationController(rootViewController: screen)
        navigation.modalPresentationStyle = .fullScreen
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        self.navigation = navigation
        self.shown = shown
        home.present(navigation, animated: true)
    }

    /// `screen` in the place of the one on top, coming in as a push; a
    /// sheet over the flow (the photo picker, a sign-in) or a move under
    /// way is let finish first.
    private func replace(with screen: UIViewController, shown: Shown) {
        guard let navigation else { return }
        self.shown = shown
        screen.loadViewIfNeeded()
        Task { @MainActor in
            var waited = 0
            while navigation.presentedViewController != nil || navigation.transitionCoordinator != nil, waited < 40 {
                try? await Task.sleep(for: .milliseconds(50))
                waited += 1
            }
            navigation.view.window?.endEditing(true)
            navigation.setViewControllers([screen], animated: true)
        }
    }

    private func close(then: (() -> Void)? = nil) {
        guard let navigation else { then?(); return }
        self.navigation = nil
        shown = nil
        navigation.dismiss(animated: true, completion: then)
    }

    // MARK: Screens

    private func screen(for step: OnboardingPlan.Step, onboarding: Onboarding) -> UIViewController {
        switch step {
        case .gate(let gate): screen(for: gate)
        case .update: notice(Self.update) { _ in UIApplication.shared.open(Self.appStore(onboarding)) }
        case .waiting(let gates): notice(Self.waiting(gates)) { [weak self] notice in await self?.checkAgain(notice) }
        case .finish: finishScreen(onboarding)
        }
    }

    private func screen(for gate: OnboardingGate) -> UIViewController {
        switch gate.kind {
        case .profile:
            return profileScreen()
        default:
            // Done on desktop or the web for now; a gate's own screen
            // takes this one's place as it comes.
            let step = Strings.CloudOnboarding.step(gate)
            let notice = notice(.init(scene: .tv, title: Strings.CloudOnboarding.elsewhereTitle, body: Strings.CloudOnboarding.elsewhereBody(step),
                                      primary: Strings.CloudOnboarding.openWeb, secondary: gate.requirement == .optional ? Strings.CloudOnboarding.skip : nil)) { [weak self] _ in
                guard let url = self?.web else { return }
                UIApplication.shared.open(url)
            }
            notice.onSecondary = { [weak self, weak notice] in
                guard let self, let notice else { return }
                await skip(gate, on: notice)
            }
            return notice
        }
    }

    private func notice(_ notice: OnboardingNoticeViewController.Notice, primary: @escaping (OnboardingNoticeViewController) async -> Void) -> OnboardingNoticeViewController {
        let screen = OnboardingNoticeViewController(context: context, notice: notice)
        screen.onPrimary = { [weak screen] in
            guard let screen else { return }
            await primary(screen)
        }
        return screen
    }

    /// Skips an optional gate; the server's answer moves the flow on.
    func skip(_ gate: OnboardingGate, on notice: OnboardingNoticeViewController) async {
        do { session.took(try await session.client.skipOnboardingGate(gate.id)) }
        catch { notice.say(Strings.CloudOnboarding.couldntSkip) }
    }

    private func checkAgain(_ notice: OnboardingNoticeViewController) async {
        notice.say(nil)
        do { try await session.readOnboarding() }
        catch { notice.say(Strings.CloudOnboarding.couldntCheck) }
    }

    /// Create your profile: the name, then any picture, as before home
    /// opens (`CloudProfileViewController`).
    private func profileScreen() -> UIViewController {
        let session = session
        let client = session.client
        let screen = CloudProfileViewController(
            context: context, handle: HappyCloud.handle(server: session.server) ?? session.computerName,
            prefill: CloudScreens.appleName, seed: context.account.agentConnections.placeholderSeed(for: id) ?? id
        ) { name, photo in
            let profile = try await client.profile()
            _ = try await client.renameProfile(name, email: profile.email, version: profile.version)
            CloudScreens.appleName = nil
            guard let photo else { return true }
            return (try? await client.setProfilePhoto(photo, contentType: "image/jpeg")) != nil
        }
        screen.finished = { photoSaved in
            guard let photoSaved else { return }
            if !photoSaved { CloudScreens.photoNotePending = true }
            _ = try? await session.readOnboarding()
        }
        // Apple's name from this sign-in, else the server's suggestion.
        if CloudScreens.appleName == nil {
            Task { [weak screen] in
                guard let suggested = (try? await client.profile())?.name, let screen, screen.nameField.text.text?.isEmpty != false else { return }
                screen.nameField.text.text = suggested
                screen.edited()
            }
        }
        return screen
    }

    /// You're all set: completes onboarding, then the Chief of Staff's
    /// conversation for those who may talk to it, else home.
    private func finishScreen(_ onboarding: Onboarding) -> UIViewController {
        let row = session.snapshot.allRows.first(where: \.isHappy) ?? session.home.allRows.first(where: \.isHappy)
        let name: String? = if case .adminBot(let bot)? = onboarding.gate("adminBot")?.kind { bot.name } else { row?.label }
        let meets = session.gate.allowsSending(toChiefOfStaff: true)
        let handle = HappyCloud.handle(server: session.server) ?? session.computerName
        let action = meets ? Strings.CloudOnboarding.meet(name ?? Strings.Start.logo) : Strings.CloudOnboarding.getStarted
        return notice(.init(scene: .sparkles, title: Strings.CloudOnboarding.doneTitle, body: Strings.CloudOnboarding.doneBody(handle), primary: action)) { [weak self] notice in
            await self?.finish(on: notice, meets: meets, legacy: onboarding.legacy)
        }
    }

    private func finish(on notice: OnboardingNoticeViewController, meets: Bool, legacy: Bool) async {
        notice.say(nil)
        if !legacy {
            do { try await session.client.completeOnboarding() }
            catch is OnboardingIncomplete { _ = try? await session.readOnboarding(); return }
            catch { notice.say(Strings.CloudOnboarding.couldntFinish); return }
        }
        finishing = true
        let session = session
        close { [weak self] in
            self?.finishing = false
            guard meets, let home = self?.home, let navigation = home.navigationController,
                  let chat = ChiefOfStaffAsk.chat(session: session, snapshot: session.snapshot) else { return }
            navigation.pushViewController(chat, animated: true)
        }
    }

    // MARK: Words

    private static let update = OnboardingNoticeViewController.Notice(
        scene: .magicWand, title: Strings.CloudOnboarding.updateTitle, body: Strings.CloudOnboarding.updateBody, primary: Strings.CloudOnboarding.updateAction
    )

    static func waiting(_ gates: [OnboardingGate]) -> OnboardingNoticeViewController.Notice {
        let theirs = gates.filter { !$0.canComplete && $0.status != .unavailable }
        return theirs.isEmpty
            ? .init(scene: .snail, title: Strings.CloudOnboarding.notReadyTitle, body: Strings.CloudOnboarding.notReadyBody, primary: Strings.CloudOnboarding.checkAgain)
            : .init(scene: .owl, title: Strings.CloudOnboarding.waitingTitle, body: Strings.CloudOnboarding.waitingBody(theirs.map(Strings.CloudOnboarding.step)),
                    primary: Strings.CloudOnboarding.checkAgain)
    }

    /// The App Store page the server names, else Happy's.
    private static func appStore(_ onboarding: Onboarding) -> URL {
        if case .mobileApp(let app)? = onboarding.gate("mobileApp")?.kind, let url = app.appStoreUrl.flatMap(URL.init(string:)) { return url }
        return URL(string: "https://apps.apple.com/us/app/happy-claude-code-client/id6748571505")!
    }

    /// The server in the web app.
    private var web: URL? {
        HappyCloud.serverName(session.server).flatMap { URL(string: "https://\($0).\(HappyCloud.web)/") }
    }
}

/// The flow's navigation: a progress bar centred in the bar's place, kept
/// across screens so it fills rather than jumps. It steps aside while the
/// screen on top is scrolled under it (a field's keyboard lifts the
/// screen), so it never lies over the screen's picture.
final class OnboardingNavigationController: UINavigationController, UINavigationControllerDelegate {
    let progress = OnboardingProgressView()
    private var scrolled: NSKeyValueObservation?

    override func viewDidLoad() {
        super.viewDidLoad()
        delegate = self
        view.addSubview(progress)
    }

    func navigationController(_ navigationController: UINavigationController, willShow viewController: UIViewController, animated: Bool) {
        guard let scroll = (viewController as? CloudStageViewController)?.scroll else { scrolled = nil; return progress.setCovered(false) }
        scrolled = scroll.observe(\.contentOffset, options: [.initial, .new]) { [weak self] scroll, _ in
            MainActor.assumeIsolated { self?.progress.setCovered(scroll.contentOffset.y > 1) }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        view.bringSubviewToFront(progress)
        let bar = navigationBar.frame
        let size = OnboardingProgressView.size
        progress.frame = CGRect(x: (view.bounds.width - size.width) / 2, y: bar.midY - size.height / 2, width: size.width, height: size.height)
    }
}

/// How far along onboarding is: a short capsule that fills; hidden for a
/// flow of one step.
final class OnboardingProgressView: UIView {
    static let size = CGSize(width: 96, height: 6)
    private let fill = UIView()
    private var fraction: Double?
    /// The screen under it is scrolled up behind it.
    private var covered = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        clipsToBounds = true
        layer.cornerRadius = Self.size.height / 2
        backgroundColor = UIColor(Palette.startDot)
        fill.backgroundColor = UIColor(Palette.startText)
        addSubview(fill)
        alpha = 0
        isAccessibilityElement = true
        accessibilityIdentifier = "onboarding-progress"
        accessibilityTraits = .updatesFrequently
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Nil hides it.
    func set(_ fraction: Double?, animated: Bool) {
        guard fraction != self.fraction else { return }
        let first = self.fraction == nil
        self.fraction = fraction
        accessibilityValue = fraction.map { "\(Int(($0 * 100).rounded()))%" }
        let apply = {
            self.alpha = self.shownAlpha
            self.layoutFill()
        }
        guard animated, !first, !UIAccessibility.isReduceMotionEnabled else { return apply() }
        UIView.animate(withDuration: 0.45, delay: 0.1, usingSpringWithDamping: 0.9, initialSpringVelocity: 0, options: [.beginFromCurrentState], animations: apply)
    }

    private var shownAlpha: CGFloat { fraction == nil || covered ? 0 : 1 }

    /// Fades out while the screen is under it; only a change moves it.
    func setCovered(_ covered: Bool) {
        guard covered != self.covered else { return }
        self.covered = covered
        UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState]) { self.alpha = self.shownAlpha }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layoutFill()
    }

    private func layoutFill() {
        let width = bounds.width * CGFloat(min(max(fraction ?? 0, 0), 1))
        fill.frame = CGRect(x: 0, y: 0, width: width, height: bounds.height)
        fill.layer.cornerRadius = bounds.height / 2
    }
}

/// One onboarding screen that asks nothing typed: its scene, what it says,
/// its action, and an optional quieter one (Skip for Now); what went wrong
/// shows under the words, in room kept for it.
final class OnboardingNoticeViewController: CloudStageViewController {
    struct Notice: Equatable {
        var scene: StateScene
        var title: String
        var body: String
        var primary: String
        var secondary: String?
    }

    var onPrimary: (() async -> Void)?
    var onSecondary: (() async -> Void)?
    private let status = StartGalleryView.bodyLabel("")

    init(context: AppContext, notice: Notice) {
        super.init(context: context, scene: notice.scene, title: notice.title, body: notice.body, primary: notice.primary, secondary: notice.secondary)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "onboarding-notice"
        primary.accessibilityIdentifier = "onboarding-primary"
        secondary?.accessibilityIdentifier = "onboarding-secondary"
        primary.action = { [weak self] in await self?.onPrimary?() }
        secondary?.action = { [weak self] in await self?.onSecondary?() }
        status.textColor = UIColor(Palette.textDestructive)
        content.addSubview(status)
    }

    /// New words in place (who the person waits for).
    func show(_ notice: Notice) {
        titleLabel.string = notice.title
        bodyLabel.string = notice.body
        relayout()
    }

    func say(_ problem: String?) {
        status.string = problem ?? ""
        relayout()
    }

    override func contentHeight(width: CGFloat) -> CGFloat { Self.statusHeight(status, width: width) }
    override func steadyContentHeight(width: CGFloat) -> CGFloat { Self.statusRoom }
    override func layoutContent() { status.setLayoutFrame(content.bounds) }
}
#endif
