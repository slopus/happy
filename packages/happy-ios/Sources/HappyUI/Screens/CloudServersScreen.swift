#if canImport(UIKit)
import AuthenticationServices
import CryptoKit
import HappyCore
import HappyLayout
import UIKit

/// The navigation Happy Cloud is presented in, full screen; the
/// coordinator dismisses it over the account it opened.
final class CloudNavigationController: UINavigationController, AccountAddingFlow {}

/// One of Happy Cloud's screens: the flow's start is the screen before the
/// first of them.
protocol CloudFlowScreen: AccountAddingFlow {}

/// Happy Cloud's screens, full screen on the first screen's Grain Gradient,
/// in desktop's order (CloudConnectScreen.tsx):
///
/// 1. Welcome: desktop's Cloud slides in the first screen's gallery, and
///    under them the sign-in: Sign in with Apple (native) and Sign in
///    with GitHub (GitHub's page in the app, straight from the accounts
///    service). Skipped while the account's hour-long pass lasts.
/// 2. Join a server: each of the account's servers with Join; several can
///    be joined, then Continue opens the last. Bootstrap a new one and Join
///    with an invite under them. An account with none starts at Bootstrap.
/// 3. Bootstrap a server, or Join with an invite: then straight into it
///    (Connecting: a token for the server from the accounts API, no
///    browser).
///
/// Back from Join a server, or from the first Bootstrap, signs the account
/// out, so Continue can use another. A server shows as `@name`.
/// docs/SERVER-SIGN-IN.md, "Happy Cloud".
@MainActor
enum CloudScreens {
    /// The account's one-hour pass, in memory only, while it lasts.
    static var account: CloudAccount?
    /// The name Apple gave this sign-in, which it gives only the first
    /// time: what "What's your name?" offers. In memory only.
    static var appleName: String?

    /// The first screen of the flow: the servers while the account's pass
    /// lasts, the welcome otherwise.
    static func first(context: AppContext) -> UIViewController {
        CloudAccount.forgetKeptGrant(backend: SecurityKeychainBackend())
        if let account, account.isLive() { return CloudServersViewController(context: context, account: account) }
        account = nil
        return CloudWelcomeViewController(context: context)
    }

    /// Signed in: the servers, in the test sign-in's place, so Back goes
    /// to the welcome.
    static func signedIn(_ account: CloudAccount, context: AppContext, from controller: UIViewController) {
        self.account = account
        guard let navigation = controller.navigationController else { return }
        var stack = navigation.viewControllers
        if stack.last is CloudTestSignInViewController { stack.removeLast() }
        stack.append(CloudServersViewController(context: context, account: account))
        navigation.setViewControllers(stack, animated: true)
    }

    /// Back to the welcome when the account's pass has ended, which says
    /// so over Continue: no retry.
    static func signedOut(context: AppContext, from controller: UIViewController) {
        account = nil
        guard let navigation = controller.navigationController else { return }
        var stack = Array(navigation.viewControllers.prefix { !($0 is CloudFlowScreen) })
        let welcome = CloudWelcomeViewController(context: context, expired: true)
        if stack.isEmpty, let close = navigation.viewControllers.first?.navigationItem.leftBarButtonItem {
            welcome.navigationItem.leftBarButtonItem = close
        }
        stack.append(welcome)
        navigation.setViewControllers(stack, animated: true)
    }

    /// Done. When the account open changed, the coordinator ends the flow
    /// over the new account's home (`AccountAddingFlow`); dismissing here
    /// too would show the old home first. Otherwise the sheet goes, or a
    /// pushed flow returns to where it began.
    static func finish(from controller: UIViewController, opened: Bool) {
        guard !opened, let navigation = controller.navigationController, !navigation.isBeingDismissed else { return }
        if navigation.presentingViewController != nil { navigation.dismiss(animated: true); return }
        if let start = navigation.viewControllers.last(where: { !($0 is CloudFlowScreen) }) { navigation.popToViewController(start, animated: true) }
    }

    /// The server isn't kept without the member's name.
    struct NameNeeded: Error {}

    /// Signs this phone in to `server` with a token from the accounts API
    /// (no browser) and keeps it; `open` opens it too. A server that wants
    /// the member's profile first asks their name on `controller`. Returns
    /// the connection's id.
    static func join(_ server: CloudServer, account: CloudAccount, context: AppContext, on controller: UIViewController, open: Bool,
                     makeFlow: (String) throws -> ServerSignInFlow = { try ServerSignInFlow.cloud($0) }) async throws -> String {
        guard let origin = server.origin else { throw ServerSignInError.invalidURL }
        let (access, grant) = try await account.serverToken(for: server)
        let flow = try makeFlow(origin)
        var signedIn = try await flow.signedIn(access: access, grant: grant, installation: .recorded)
        if signedIn.needsProfile {
            let suggested = await flow.suggestedName(for: signedIn)
            guard let name = await NamePrompt.ask(on: controller, message: Strings.ServerSignIn.nameCloudMessage, prefill: appleName ?? suggested) else {
                throw NameNeeded()
            }
            signedIn = try await flow.saveProfile(name, for: signedIn)
            appleName = nil
        }
        return try await context.account.addServer(signedIn, open: open)
    }

    /// Why a join failed, in words.
    static func problem(_ error: any Error) -> String {
        switch error {
        case is NameNeeded: Strings.ServerSignIn.nameNeeded
        case let error as CloudAccountError: Strings.HappyCloud.failure(error)
        default: Strings.ServerSignIn.failure(error)
        }
    }
}

/// The gradient, under a bar that shows it through, for every Cloud screen.
@MainActor
private func dressCloudScreen(_ controller: UIViewController, gradient: GrainGradientView) {
    gradient.frame = controller.view.bounds
    gradient.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    controller.view.addSubview(gradient)
    let bar = UINavigationBarAppearance()
    bar.configureWithTransparentBackground()
    controller.navigationItem.standardAppearance = bar
    controller.navigationItem.scrollEdgeAppearance = bar
    controller.navigationItem.compactAppearance = bar
    controller.minimalBackButton()
}

/// Happy Cloud's welcome, desktop's (`CLOUD_SLIDES` in a `WelcomeScreen`),
/// with the sign-in in its action's place: its slides in the first screen's
/// gallery, at the first screen's place, Sign in with Apple where Start is
/// and Sign in with GitHub under it where Use Happy Cloud is
/// (`CloudWelcomeLayout`).
///
/// - Sign in with Apple: Apple's own button, Sign in with Apple, then
///   `POST /v1/auth/native`.
/// - Sign in with GitHub: the accounts service's authorization request
///   with `provider=github`, which goes straight to GitHub, in the app's
///   own browser sheet.
///
/// A note over the buttons says when the account's sign-in has ended, or
/// why one failed. Ten taps on the cloud mark within four seconds open a
/// test account's sign-in. Desktop's scenes drift down both sides
/// (`CLOUD_DRIFT`, `SetupDriftView`), clear of the slides and buttons.
final class CloudWelcomeViewController: UIViewController, CloudFlowScreen, ASWebAuthenticationPresentationContextProviding {
    /// Desktop's Cloud slides: the Happy Cloud mark in liquid metal, then 🤖, 🔒, ✨, 👐.
    static let slides: [StartGalleryView.Slide] = zip(
        [StartGalleryView.Art.cloud, .scene(.robot), .scene(.closedLock), .scene(.sparkles), .scene(.openHands)],
        Strings.CloudConnect.slides
    ).map { StartGalleryView.Slide(art: $0, title: $1.title, body: $1.body) }
    /// Their lines run to two or three: longer than the first screen's.
    static let advanceInterval: TimeInterval = 12
    /// Desktop's CLOUD_DRIFT: ☁️, 🤖, ✨ down the left; 🦙, 🔒, 🌳 down the right.
    static let drift: [StateScene] = [.cloudVariation, .robot, .sparkles, .llama, .closedLock, .tree]

    let context: AppContext
    private let gradient = GrainGradientView(palette: StartViewController.Colors.grain)
    private let scroll = UIScrollView()
    let drift = SetupDriftView(scenes: CloudWelcomeViewController.drift)
    let gallery = StartGalleryView(slides: CloudWelcomeViewController.slides, interval: CloudWelcomeViewController.advanceInterval)
    private(set) var appleButton: ASAuthorizationAppleIDButton?
    let github = RoundButton(title: Strings.CloudConnect.github)
    let note = StartGalleryView.bodyLabel("")
    private var taps = CloudLogoTaps()
    private var browser: ASWebAuthenticationSession?
    private var apple: CloudApple?
    /// Where the test account's sign-in goes; the tests' fake accounts.
    var http: any HTTPTransport = NoRedirectURLSessionTransport()

    init(context: AppContext, expired: Bool = false) {
        self.context = context
        super.init(nibName: nil, bundle: nil)
        note.string = expired ? Strings.CloudConnect.expired : ""
        note.accessibilityIdentifier = "cloud-welcome-note"
        followsTextSize()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "cloud-welcome"
        dressCloudScreen(self, gradient: gradient)
        drift.frame = view.bounds
        drift.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(drift)
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.showsVerticalScrollIndicator = false
        scroll.alwaysBounceVertical = false
        view.addSubview(scroll)
        github.accessibilityIdentifier = "cloud-github"
        github.action = { [weak self] in await self?.signInWithGitHub() }
        if HappyCloud.isOffered(in: context.variant) {
            gallery.onArtTap = { [weak self] in self?.logoTapped(at: Date()) }
        }
        for subview in [gallery, note, github] as [UIView] { scroll.addSubview(subview) }
        updateAppleButton()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.updateAppleButton() }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        gallery.isRunning = true
        drift.isRunning = true
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        gallery.isRunning = false
        drift.isRunning = false
    }

    /// Apple's button in the style that stands out on the gradient: black
    /// on the light one, white on the dark.
    private func updateAppleButton() {
        appleButton?.removeFromSuperview()
        let button = ASAuthorizationAppleIDButton(authorizationButtonType: .signIn,
                                                  authorizationButtonStyle: traitCollection.userInterfaceStyle == .dark ? .white : .black)
        button.accessibilityIdentifier = "cloud-apple"
        button.addAction(UIAction { [weak self] _ in Task { await self?.signInWithApple() } }, for: .touchUpInside)
        scroll.addSubview(button)
        appleButton = button
        view.setNeedsLayout()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // The first screen's safe area: without this one's bar, which sits over its top row.
        var insets = view.safeAreaInsets
        if let bar = navigationController?.navigationBar, !bar.isHidden {
            insets.top = max(0, insets.top - bar.frame.height)
        }
        // GitHub's as wide as its label; Apple's as tall, as wide as the wider.
        let metrics = RoundButtonMetrics.of(github.size)
        let label = github.label.measurable.size(fitting: .greatestFiniteMagnitude)
        let githubSize = CGSize(width: ceil(label.width) + metrics.paddingHorizontal * 2, height: github.layout(width: StartLayout.Metrics.buttonMinWidth).size.height)
        let layout = CloudWelcomeLayout(
            size: view.bounds.size,
            safeArea: LayoutInsets(insets),
            button: CGSize(width: 0, height: metrics.height),
            secondary: githubSize,
            note: note.string.isEmpty ? nil : note.measurable,
            slides: gallery.slides,
            dots: gallery.dotsSize
        )
        scroll.frame = view.bounds
        scroll.contentSize = CGSize(width: view.bounds.width, height: insets.top + layout.start.contentHeight + insets.bottom)
        gallery.setLayoutFrame(layout.start.gallery)
        gallery.apply(layout.start)
        note.setLayoutFrame(layout.note)
        appleButton?.setLayoutFrame(layout.button)
        appleButton?.cornerRadius = layout.button.height / 2
        github.setLayoutFrame(layout.secondary)
        // The drift keeps clear of the art, every slide's words, the dots,
        // the note and the buttons.
        let start = layout.start, gallery = start.gallery
        let words = start.titles.first.map { title in
            CGRect(x: gallery.minX + title.minX, y: gallery.minY + title.minY, width: title.width,
                   height: (start.bodies.map(\.maxY).max() ?? title.maxY) - title.minY)
        }
        let avoid = [start.art.offsetBy(dx: gallery.minX, dy: gallery.minY), words ?? .zero, start.dots.offsetBy(dx: gallery.minX, dy: gallery.minY),
                     layout.note, layout.button, layout.secondary]
        drift.avoid = avoid.filter { !$0.isEmpty }.map { scroll.convert($0, to: view) }
    }

    /// The tenth tap within four seconds opens a test account's sign-in.
    func logoTapped(at now: Date) {
        guard HappyCloud.isOffered(in: context.variant), taps.tap(at: now) else { return }
        taps = CloudLogoTaps()
        let signIn = CloudTestSignInViewController(context: context)
        signIn.http = http
        navigationController?.pushViewController(signIn, animated: true)
    }

    private func signInWithApple() async {
        guard apple == nil else { return }
        say(nil)
        let apple = CloudApple(anchor: view)
        self.apple = apple
        defer { self.apple = nil }
        do {
            let identity = try await apple.signIn()
            CloudScreens.appleName = identity.name ?? CloudScreens.appleName
            let account = try await CloudAccount.signIn(provider: "apple", idToken: identity.idToken, nonce: identity.nonce,
                                                        authorizationCode: identity.authorizationCode, name: identity.name)
            CloudScreens.signedIn(account, context: context, from: self)
        } catch OAuthError.cancelled {
        } catch {
            say(Strings.HappyCloud.failure(error))
        }
    }

    /// GitHub's own page in the app's browser sheet, ephemeral: no Safari
    /// cookie comes in, so after Back signs the account out another GitHub
    /// account can be picked, and iOS asks no "wants to use … to sign in"
    /// first. Passwords and passkeys still fill.
    private func signInWithGitHub() async {
        say(nil)
        do {
            let request = try CloudAccount.request(provider: "github")
            let callback = try await CloudBrowser.authenticate(request.url, anchor: self, ephemeral: true) { self.browser = $0 }
            let account = try await CloudAccount.signIn(request, callback: callback)
            CloudScreens.signedIn(account, context: context, from: self)
        } catch OAuthError.cancelled {
        } catch {
            say(Strings.HappyCloud.failure(error))
        }
    }

    /// A failure in the note's place, over the buttons; nil clears it.
    private func say(_ problem: String?) {
        note.string = problem ?? ""
        note.textColor = UIColor(problem == nil ? Palette.startTextSecondary : Palette.textDestructive)
        view.setNeedsLayout()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { CloudBrowser.anchor(view) }
}

/// One Happy Cloud step after the welcome: the gradient, optional art, a
/// title, a line under it, what the step holds, and its actions at the
/// bottom, riding the keyboard (`CloudStageLayout`). Steps that sign the
/// account out on Back set `signsOutOnBack`.
class CloudStageViewController: UIViewController, CloudFlowScreen {
    let context: AppContext
    private let gradient = GrainGradientView(palette: StartViewController.Colors.grain)
    let scroll = UIScrollView()
    let art: StateSceneView?
    let titleLabel: StyledLabel
    let bodyLabel: StyledLabel
    let content = UIView()
    let primary: RoundButton
    /// Shown in the primary action's place instead of it, such as Sign in
    /// with Apple's own button.
    var primaryReplacement: UIView? {
        didSet {
            oldValue?.removeFromSuperview()
            primary.isHidden = primaryReplacement != nil
            if let primaryReplacement { scroll.addSubview(primaryReplacement) }
            relayout()
        }
    }
    let secondary: RoundButton?
    private let keyboardProbe = UIView()
    /// Back (or the edge swipe) to the step before signs the account out:
    /// Join a server, and Bootstrap when the account has no server.
    var signsOutOnBack = false

    init(context: AppContext, scene: StateScene?, title: String, body: String, primary: String, secondary: String? = nil, secondaryDisplay: RoundButtonDisplay = .inverted) {
        self.context = context
        art = scene.map { StateSceneView(scene: $0, size: StartLayout.Metrics.art, replayLabel: title) }
        titleLabel = StartGalleryView.titleLabel(title)
        bodyLabel = StartGalleryView.bodyLabel(body)
        self.primary = RoundButton(title: primary)
        self.secondary = secondary.map { RoundButton(title: $0, size: secondaryDisplay == .filled ? .large : .normal, display: secondaryDisplay) }
        super.init(nibName: nil, bundle: nil)
        if let secondary = self.secondary, secondaryDisplay == .inverted { Self.quiet(secondary) }
        followsTextSize()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// A text action in the gradient's secondary colour.
    static func quiet(_ button: RoundButton) {
        button.label.color = Palette.startTextSecondary
        button.spinner.color = UIColor(Palette.startTextSecondary)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        dressCloudScreen(self, gradient: gradient)
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.alwaysBounceVertical = true
        scroll.keyboardDismissMode = .interactive
        view.addSubview(scroll)
        for subview in [art, titleLabel, bodyLabel, content, primary, secondary].compactMap({ $0 }) { scroll.addSubview(subview) }
        // A layout pass whenever the keyboard moves.
        keyboardProbe.isHidden = true
        view.addSubview(keyboardProbe)
        keyboardProbe.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            keyboardProbe.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            keyboardProbe.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            keyboardProbe.widthAnchor.constraint(equalToConstant: 1),
            keyboardProbe.heightAnchor.constraint(equalToConstant: 1),
        ])
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        guard signsOutOnBack, isMovingFromParent else { return }
        // Only once Back has really gone back: an edge swipe let go of halfway stays.
        if let coordinator = transitionCoordinator {
            coordinator.animate(alongsideTransition: nil) { context in
                if !context.isCancelled { CloudScreens.account = nil }
            }
        } else {
            CloudScreens.account = nil
        }
    }

    /// How tall the step's own part is at `width`.
    func contentHeight(width: CGFloat) -> CGFloat { 0 }
    /// Places the step's own part in `content`'s bounds.
    func layoutContent() {}

    func relayout() { view.setNeedsLayout() }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let size = view.bounds.size
        let safeArea = LayoutInsets(view.safeAreaInsets)
        let column = CloudStageLayout.column(size: size, safeArea: safeArea)
        let primaryShown = !primary.isHidden || primaryReplacement != nil
        var actions: [CloudStageLayout.Action] = []
        if primaryShown { actions.append(.init(height: primary.layout(width: column).size.height)) }
        if let secondary, !secondary.isHidden {
            let gap = secondary.display == .filled ? CloudStageLayout.Metrics.actionGap : CloudStageLayout.Metrics.textActionGap
            actions.append(.init(height: secondary.layout(width: column).size.height, gap: gap))
        }
        let layout = CloudStageLayout(
            size: size, safeArea: safeArea, keyboardTop: keyboardProbe.frame.maxY,
            art: art == nil ? 0 : StartLayout.Metrics.art,
            title: titleLabel.measurable,
            body: bodyLabel.string.isEmpty ? .fixed(.zero) : bodyLabel.measurable,
            content: Measurable { [unowned self] width in CGSize(width: width, height: contentHeight(width: width)) },
            actions: actions
        )
        scroll.frame = view.bounds
        scroll.contentSize = CGSize(width: size.width, height: layout.contentHeight)
        scroll.contentInset.bottom = layout.keyboardInset
        scroll.verticalScrollIndicatorInsets.bottom = layout.keyboardInset
        art?.setLayoutFrame(layout.art)
        titleLabel.setLayoutFrame(layout.title)
        bodyLabel.setLayoutFrame(layout.body)
        content.setLayoutFrame(layout.content)
        layoutContent()
        var frames = layout.actions[...]
        if primaryShown, let frame = frames.popFirst() {
            primary.setLayoutFrame(frame)
            primaryReplacement?.setLayoutFrame(frame)
        }
        if let secondary, let frame = frames.popFirst() { secondary.setLayoutFrame(frame) }
    }
}

/// Taps on the welcome's logo: ten within four seconds open the test
/// account form.
struct CloudLogoTaps {
    static let needed = 10
    static let within: TimeInterval = 4
    private var times: [Date] = []

    /// Whether this tap is the tenth within the window.
    mutating func tap(at now: Date) -> Bool {
        times = times.filter { now.timeIntervalSince($0) < Self.within } + [now]
        return times.count >= Self.needed
    }
}

/// A test account's login and password, and its sign-in button. Made only
/// once the logo opens it; the password lives in the field alone.
final class CloudTestSignIn: UIView {
    let login = CloudField(prefix: nil, placeholder: Strings.HappyCloud.testLogin)
    let password = CloudField(prefix: nil, placeholder: Strings.HappyCloud.testPassword)
    let button = RoundButton(title: Strings.HappyCloud.testSignIn, size: .normal, display: .inverted)

    init() {
        super.init(frame: .zero)
        accessibilityIdentifier = "cloud-test-sign-in"
        login.text.accessibilityIdentifier = "cloud-test-login"
        password.text.accessibilityIdentifier = "cloud-test-password"
        button.accessibilityIdentifier = "cloud-test-submit"
        CloudStageViewController.quiet(button)
        login.text.returnKeyType = .next
        password.text.returnKeyType = .go
        password.text.isSecureTextEntry = true
        for view in [login, password, button] { addSubview(view) }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func items(width: CGFloat) -> [CloudColumnLayout.Item] {
        [.init(height: CloudField.height), .init(height: CloudField.height, gap: 12), .init(height: button.layout(width: width).size.height, gap: 12)]
    }

    func height(width: CGFloat) -> CGFloat { CloudColumnLayout.stack(items(width: width), width: width).height }

    override func layoutSubviews() {
        super.layoutSubviews()
        let frames = CloudColumnLayout.stack(items(width: bounds.width), width: bounds.width).frames
        login.setLayoutFrame(frames[0])
        password.setLayoutFrame(frames[1])
        button.setLayoutFrame(frames[2])
    }
}

/// A test account's sign-in, for testing every surface without Apple or
/// GitHub: its login and password, opened by ten taps on the welcome's
/// Happy mark in development and preview builds.
final class CloudTestSignInViewController: CloudStageViewController, UITextFieldDelegate {
    let problem = StartGalleryView.bodyLabel("")
    private(set) var testSignIn: CloudTestSignIn?
    /// Where the test account's sign-in goes; the tests' fake accounts.
    var http: any HTTPTransport = NoRedirectURLSessionTransport()

    init(context: AppContext) {
        super.init(context: context, scene: .closedLock, title: Strings.CloudConnect.signInTitle, body: "", primary: Strings.CloudConnect.signInTitle)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "cloud-sign-in"
        primary.isHidden = true
        problem.textColor = UIColor(Palette.textDestructive)
        problem.accessibilityIdentifier = "cloud-sign-in-problem"
        content.addSubview(problem)
        guard HappyCloud.isOffered(in: context.variant) else { return }
        let form = CloudTestSignIn()
        form.login.text.delegate = self
        form.password.text.delegate = self
        form.button.action = { [weak self] in await self?.signInWithTestAccount() }
        content.addSubview(form)
        testSignIn = form
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if let testSignIn, testSignIn.login.text.text?.isEmpty ?? true { testSignIn.login.text.becomeFirstResponder() }
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        guard let form = testSignIn else { return true }
        if textField === form.login.text { form.password.text.becomeFirstResponder() } else { form.button.tapped() }
        return false
    }

    /// The form's button's action; it leaves `isLoading` to the button.
    func signInWithTestAccount() async {
        guard let form = testSignIn else { return }
        let login = (form.login.text.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let password = form.password.text.text ?? ""
        guard !login.isEmpty, !password.isEmpty else { return say(Strings.HappyCloud.testMissing) }
        say(nil)
        do {
            let account = try await CloudAccount.signIn(login: login, password: password, http: http)
            form.password.text.text = nil
            view.endEditing(true)
            CloudScreens.signedIn(account, context: context, from: self)
        } catch {
            say(Strings.HappyCloud.failure(error))
        }
    }

    private func items(width: CGFloat) -> [CloudColumnLayout.Item] {
        [
            .init(height: testSignIn?.height(width: width) ?? 0),
            .init(height: problem.string.isEmpty ? 0 : problem.measurable.height(fitting: width), gap: 16),
        ]
    }

    override func contentHeight(width: CGFloat) -> CGFloat { CloudColumnLayout.stack(items(width: width), width: width).height }

    override func layoutContent() {
        let frames = CloudColumnLayout.stack(items(width: content.bounds.width), width: content.bounds.width).frames
        testSignIn?.setLayoutFrame(frames[0])
        problem.setLayoutFrame(frames[1])
    }

    private func say(_ text: String?) {
        problem.string = text ?? ""
        relayout()
    }
}

/// One Sign in with Apple: the name and email asked for, the request
/// bound to a fresh nonce by its SHA-256, and what the accounts service
/// needs back, the raw nonce among it.
@MainActor
final class CloudApple: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    struct Identity { let idToken: String; let nonce: String; let authorizationCode: String?; let name: String? }
    private let anchor: UIView
    private var continuation: CheckedContinuation<Identity, any Error>?
    private var nonce = ""

    init(anchor: UIView) { self.anchor = anchor }

    func signIn() async throws -> Identity {
        nonce = Self.nonce()
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        request.nonce = SHA256.hash(data: Data(nonce.utf8)).map { String(format: "%02x", $0) }.joined()
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            controller.performRequests()
        }
    }

    private static func nonce() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        let credential = authorization.credential as? ASAuthorizationAppleIDCredential
        let idToken = credential?.identityToken.flatMap { String(data: $0, encoding: .utf8) }
        let code = credential?.authorizationCode.flatMap { String(data: $0, encoding: .utf8) }
        // Apple gives the name only the first time; it goes with that sign-in.
        let name = credential?.fullName.map { PersonNameComponentsFormatter().string(from: $0) }.flatMap { $0.isEmpty ? nil : $0 }
        MainActor.assumeIsolated {
            guard let idToken else { return finish(.failure(OAuthError.invalidResponse)) }
            finish(.success(Identity(idToken: idToken, nonce: nonce, authorizationCode: code, name: name)))
        }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: any Error) {
        let cancelled = (error as? ASAuthorizationError)?.code == .canceled
        MainActor.assumeIsolated { finish(.failure(cancelled ? OAuthError.cancelled : error)) }
    }

    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated { CloudBrowser.anchor(anchor) }
    }

    private func finish(_ result: Result<Identity, any Error>) {
        continuation?.resume(with: result)
        continuation = nil
    }
}

/// Join a server, desktop's: each of the account's servers with its
/// picture, its name and `@name`, and Join, or Joined once it is on this
/// phone. Joining keeps the list, so several can be joined (one after
/// another, each asking a name if its server wants one); Continue, once
/// one is in, opens the last joined. Back is held while a join runs.
/// Bootstrap a new one and Join with an invite sit under the list. An
/// account with no server goes straight to Bootstrap a server.
final class CloudServersViewController: CloudStageViewController {
    private let account: CloudAccount
    /// Where the list comes from: the account's; a preview's own.
    private let load: () async throws -> [CloudServer]
    private var servers: [CloudServer]?
    private var rows: [String: CloudServerRow] = [:]
    private var order: [String] = []
    private let spinner = UIActivityIndicatorView(style: .medium)
    let status = StartGalleryView.bodyLabel("")
    let bootstrap = RoundButton(title: Strings.CloudConnect.bootstrapNew, size: .normal, display: .inverted)
    let invite = RoundButton(title: Strings.CloudConnect.joinWithInvite, size: .normal, display: .inverted)
    private var pictures: [String: UIImage] = [:]
    private var loadingPictures: Set<String> = []
    /// Servers being joined, and those joined from here (server id to
    /// connection id), the last one last.
    private var joining: Set<String> = []
    private(set) var joined: [(server: String, connection: String)] = []
    /// Joins run one after another.
    private var queue: Task<Void, Never>?
    private var failedToLoad = false

    init(context: AppContext, account: CloudAccount, load: (() async throws -> [CloudServer])? = nil) {
        self.account = account
        self.load = load ?? { try await account.servers() }
        super.init(context: context, scene: nil, title: Strings.CloudConnect.serversTitle, body: Strings.CloudConnect.serversMessage,
                   primary: Strings.CloudConnect.continueAction)
        signsOutOnBack = true
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "cloud-servers"
        primary.accessibilityIdentifier = "cloud-servers-continue"
        primary.isHidden = true
        primary.action = { [weak self] in await self?.primaryTapped() }
        bootstrap.accessibilityIdentifier = "cloud-create"
        invite.accessibilityIdentifier = "cloud-join"
        for link in [bootstrap, invite] { Self.quiet(link) }
        bootstrap.onTap = { [weak self] in
            guard let self, joining.isEmpty else { return }
            navigationController?.pushViewController(CloudCreateViewController(context: context, account: account, first: false), animated: true)
        }
        invite.onTap = { [weak self] in
            guard let self, joining.isEmpty else { return }
            navigationController?.pushViewController(CloudJoinViewController(context: context, account: account), animated: true)
        }
        spinner.color = StartViewController.Colors.text
        status.accessibilityIdentifier = "cloud-servers-status"
        for subview in [spinner, status, bootstrap, invite] as [UIView] { content.addSubview(subview) }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        Task { await reload() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        navigationController?.interactivePopGestureRecognizer?.isEnabled = true
    }

    private func reload() async {
        if servers == nil {
            spinner.startAnimating()
            relayout()
        }
        do {
            let list = try await load()
            failedToLoad = false
            // None yet: Bootstrap leads, and its Back signs out as this one's does.
            if list.isEmpty, joined.isEmpty, let navigation = navigationController, navigation.topViewController === self {
                var stack = navigation.viewControllers
                stack.removeLast()
                stack.append(CloudCreateViewController(context: context, account: account, first: true))
                navigation.setViewControllers(stack, animated: true)
                return
            }
            servers = list
            say(nil)
        } catch CloudAccountError.signInRequired {
            CloudScreens.signedOut(context: context, from: self)
            return
        } catch {
            failedToLoad = servers == nil
            say(CloudScreens.problem(error))
        }
        spinner.stopAnimating()
        rebuild()
    }

    /// Already on this phone (and not signed out there), or joined here.
    private func connection(for server: CloudServer) -> String? {
        if let here = joined.last(where: { $0.server == server.id }) { return here.connection }
        guard let origin = server.origin, let existing = HappyCloud.connection(to: origin, in: context.account.agentConnections.accounts), !existing.revoked else { return nil }
        return existing.id
    }

    private func rebuild() {
        rows.values.forEach { $0.removeFromSuperview() }
        rows = [:]
        order = []
        for server in servers ?? [] where server.origin != nil {
            let row = CloudServerRow()
            row.title.string = server.title
            row.subtitle.string = HappyCloud.handle(server.name)
            row.picture.image = picture(server)
            row.join.accessibilityIdentifier = "cloud-server-\(server.name)"
            row.joinLabel = Strings.CloudConnect.joinServer(server.title)
            row.join.onTap = { [weak self] in self?.join(server) }
            content.addSubview(row)
            rows[server.id] = row
            order.append(server.id)
        }
        update()
    }

    /// Each row's Join, Joining or Joined; Continue once one is in; Back
    /// held while a join runs.
    private func update() {
        for server in servers ?? [] {
            guard let row = rows[server.id] else { continue }
            row.state = joining.contains(server.id) ? .joining : connection(for: server) != nil ? .joined : .join
        }
        let busy = !joining.isEmpty
        navigationItem.hidesBackButton = busy
        navigationItem.leftBarButtonItem?.isEnabled = !busy
        navigationController?.interactivePopGestureRecognizer?.isEnabled = !busy
        bootstrap.isEnabled = !busy
        invite.isEnabled = !busy
        let anyJoined = (servers ?? []).contains { connection(for: $0) != nil }
        primary.title = failedToLoad ? Strings.HappyCloud.tryAgain : Strings.CloudConnect.continueAction
        primary.isHidden = !(failedToLoad || anyJoined)
        primary.isEnabled = !busy
        relayout()
    }

    private func join(_ server: CloudServer) {
        guard !joining.contains(server.id), connection(for: server) == nil else { return }
        joining.insert(server.id)
        say(nil)
        update()
        let previous = queue
        queue = Task { [weak self] in
            await previous?.value
            guard let self else { return }
            do {
                let id = try await CloudScreens.join(server, account: account, context: context, on: self, open: false)
                joined.append((server.id, id))
            } catch CloudAccountError.signInRequired {
                joining.remove(server.id)
                return CloudScreens.signedOut(context: context, from: self)
            } catch {
                say(CloudScreens.problem(error))
            }
            joining.remove(server.id)
            update()
        }
    }

    /// Continue: the last server joined here, else one already on this
    /// phone, opens. After a list that failed, Try Again.
    private func primaryTapped() async {
        if failedToLoad {
            servers = nil
            return await reload()
        }
        let id = joined.last?.connection ?? (servers ?? []).lazy.compactMap { self.connection(for: $0) }.first
        guard let id else { return }
        let accounts = context.account
        if !accounts.showsAgentConnections { await accounts.setShowsAgentConnections(true) }
        accounts.cancelAddingAccount()
        let opened = accounts.agentConnections.activeID != id
        do {
            try await accounts.switchAccount(to: id)
            CloudScreens.finish(from: self, opened: opened)
        } catch {
            say(CloudScreens.problem(error))
        }
    }

    private func say(_ text: String?) {
        status.string = text ?? ""
        status.textColor = UIColor(Palette.textDestructive)
        relayout()
    }

    private func items(width: CGFloat) -> [CloudColumnLayout.Item] {
        let rowItems = order.map { _ in CloudColumnLayout.Item(height: CloudServerRowLayout.Metrics.height, gap: 12) }
        let link = { (button: RoundButton) in button.layout(width: width).size }
        return rowItems + [
            .init(size: CGSize(width: 44, height: spinner.isAnimating ? 44 : 0), gap: 12, centred: true),
            .init(height: status.string.isEmpty ? 0 : status.measurable.height(fitting: width), gap: 16),
            .init(size: link(bootstrap), gap: 16, centred: true),
            .init(size: link(invite), gap: 0, centred: true),
        ]
    }

    override func contentHeight(width: CGFloat) -> CGFloat { CloudColumnLayout.stack(items(width: width), width: width).height }

    override func layoutContent() {
        let frames = CloudColumnLayout.stack(items(width: content.bounds.width), width: content.bounds.width).frames
        for (index, id) in order.enumerated() { rows[id]?.setLayoutFrame(frames[index]) }
        let rest = frames.suffix(4).map { $0 }
        spinner.setLayoutFrame(rest[0])
        status.setLayoutFrame(rest[1])
        bootstrap.setLayoutFrame(rest[2])
        invite.setLayoutFrame(rest[3])
    }

    /// Its picture, else its ThumbHash, else the placeholder its name picks
    /// (as desktop's, and its home's once connected); the rest is fetched
    /// once and the row updated.
    private func picture(_ server: CloudServer) -> UIImage {
        let side = CloudServerRowLayout.Metrics.picture
        let seed = server.name
        if pictures[server.id] == nil, !loadingPictures.contains(server.id) {
            loadingPictures.insert(server.id)
            Task { [weak self, account] in
                var image: UIImage?
                if let picture = server.image, let data = try? await account.image(picture) {
                    image = await Task.detached { AccountPictureImages.decode(data)?.picture as? UIImage }.value
                }
                if image == nil { image = await AvatarPlaceholderImages.image(seed: seed, side: side) }
                guard let self, let image else { return }
                pictures[server.id] = image
                rows[server.id]?.picture.image = image
            }
        }
        return pictures[server.id] ?? ThumbHashImages.image(server.image?.thumbhash)
            ?? AvatarPlaceholderImages.cached(seed: seed, side: side) ?? AvatarPlaceholderImages.pending(side: side)
    }
}

/// Bootstrap a server: its name, as `@name`, checked as it is typed;
/// Bootstrap once it is free, which makes it with the person as its owner
/// and goes straight into it. When the account has none yet (`first`) it
/// says so, offers an invite instead, and Back signs the account out.
final class CloudCreateViewController: CloudStageViewController, UITextFieldDelegate {
    private let account: CloudAccount
    let field = CloudField(prefix: "@", placeholder: Strings.CloudConnect.namePlaceholder)
    let status = StartGalleryView.bodyLabel("")
    let invite = RoundButton(title: Strings.CloudConnect.haveInvite, size: .normal, display: .inverted)
    private let first: Bool
    private var checking: Task<Void, Never>?

    init(context: AppContext, account: CloudAccount, first: Bool = false) {
        self.account = account
        self.first = first
        super.init(context: context, scene: nil, title: Strings.CloudConnect.createTitle,
                   body: first ? Strings.CloudConnect.createFirstMessage : Strings.CloudConnect.createMessage, primary: Strings.CloudConnect.createAction)
        signsOutOnBack = first
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "cloud-create-server"
        primary.accessibilityIdentifier = "cloud-create-save"
        primary.isEnabled = false
        field.text.accessibilityIdentifier = "cloud-create-name"
        field.text.accessibilityLabel = "Server name"
        field.text.returnKeyType = .done
        field.text.delegate = self
        field.text.addTarget(self, action: #selector(edited), for: .editingChanged)
        primary.action = { [weak self] in await self?.create() }
        status.accessibilityIdentifier = "cloud-create-status"
        invite.accessibilityIdentifier = "cloud-create-invite"
        Self.quiet(invite)
        invite.isHidden = !first
        invite.onTap = { [weak self] in
            guard let self else { return }
            navigationController?.pushViewController(CloudJoinViewController(context: context, account: account), animated: true)
        }
        for subview in [field, status, invite] as [UIView] { content.addSubview(subview) }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        field.text.becomeFirstResponder()
    }

    private var name: String { Strings.HappyCloud.bareName(field.text.text ?? "") }

    private func say(_ text: String, problem: Bool = false) {
        status.string = text
        status.textColor = problem ? UIColor(Palette.textDestructive) : UIColor(Palette.startTextSecondary)
        relayout()
    }

    @objc func edited() {
        checking?.cancel()
        primary.isEnabled = false
        say("")
        let name = name
        guard !name.isEmpty else { return }
        guard HappyCloud.isValidName(name) else { return say(Strings.CloudConnect.invalidName, problem: true) }
        say(Strings.CloudConnect.checking)
        checking = Task { [weak self, account] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            let answer: Result<CloudAccount.Availability, any Error>
            do { answer = .success(try await account.availability(name)) } catch { answer = .failure(error) }
            guard !Task.isCancelled, let self, self.name == name else { return }
            switch answer {
            case .success(.available):
                say(Strings.CloudConnect.available(name))
                primary.isEnabled = true
            case .success(let answer): say(Strings.CloudConnect.unavailable(answer, name: name) ?? "", problem: true)
            case .failure(CloudAccountError.signInRequired): CloudScreens.signedOut(context: context, from: self)
            case .failure(let error): say(Strings.HappyCloud.failure(error), problem: true)
            }
        }
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        // Through the button, which shows it working and runs it once.
        if primary.isEnabled { primary.tapped() }
        return false
    }

    /// The hint's line is kept whether or not it says anything, so typing
    /// never moves the page.
    private func items(width: CGFloat) -> [CloudColumnLayout.Item] {
        let hint = max((TextStyles.startSlideBody.lineHeight ?? 24), status.string.isEmpty ? 0 : status.measurable.height(fitting: width))
        return [
            .init(height: CloudField.height),
            .init(height: hint, gap: 12),
            .init(size: invite.isHidden ? .zero : invite.layout(width: width).size, gap: 12, centred: true),
        ]
    }

    override func contentHeight(width: CGFloat) -> CGFloat { CloudColumnLayout.stack(items(width: width), width: width).height }

    override func layoutContent() {
        let frames = CloudColumnLayout.stack(items(width: content.bounds.width), width: content.bounds.width).frames
        field.setLayoutFrame(frames[0])
        status.setLayoutFrame(frames[1])
        invite.setLayoutFrame(frames[2])
    }

    /// The primary button's action: `RoundButton` marks itself loading
    /// before running it, so this never checks `isLoading` itself, which
    /// once made every tap return without a word.
    func create() async {
        let name = name
        guard HappyCloud.isValidName(name) else { return say(Strings.CloudConnect.invalidName, problem: true) }
        do {
            let server = try await account.create(name)
            navigationController?.pushViewController(CloudConnectingViewController(context: context, account: account, server: server), animated: true)
        } catch CloudAccountError.signInRequired {
            CloudScreens.signedOut(context: context, from: self)
        } catch {
            say(Strings.HappyCloud.failure(error), problem: true)
        }
    }
}

/// Join with an invite: a server's `@name` and the invite code its owner
/// gave; Join server once both are there, then straight into it.
final class CloudJoinViewController: CloudStageViewController, UITextFieldDelegate {
    private let account: CloudAccount
    let nameField = CloudField(prefix: "@", placeholder: Strings.CloudConnect.namePlaceholder)
    let codeField = CloudField(prefix: nil, placeholder: Strings.CloudConnect.codePlaceholder)
    let status = StartGalleryView.bodyLabel("")

    init(context: AppContext, account: CloudAccount) {
        self.account = account
        super.init(context: context, scene: nil, title: Strings.CloudConnect.joinTitle, body: Strings.CloudConnect.joinMessage, primary: Strings.CloudConnect.joinAction)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "cloud-join-server"
        primary.accessibilityIdentifier = "cloud-join-save"
        primary.isEnabled = false
        nameField.text.accessibilityIdentifier = "cloud-join-name"
        nameField.text.accessibilityLabel = "Server name"
        codeField.text.accessibilityIdentifier = "cloud-join-code"
        codeField.text.accessibilityLabel = Strings.CloudConnect.codePlaceholder
        nameField.text.returnKeyType = .next
        codeField.text.returnKeyType = .join
        for field in [nameField, codeField] {
            field.text.delegate = self
            field.text.addTarget(self, action: #selector(edited), for: .editingChanged)
        }
        status.textColor = UIColor(Palette.textDestructive)
        primary.action = { [weak self] in await self?.join() }
        for subview in [nameField, codeField, status] { content.addSubview(subview) }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        nameField.text.becomeFirstResponder()
    }

    private var filled: Bool {
        !Strings.HappyCloud.bareName(nameField.text.text ?? "").isEmpty && !(codeField.text.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    @objc func edited() { primary.isEnabled = filled }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        if textField === nameField.text { codeField.text.becomeFirstResponder() } else if filled { primary.tapped() }
        return false
    }

    private func items(width: CGFloat) -> [CloudColumnLayout.Item] {
        [
            .init(height: CloudField.height),
            .init(height: CloudField.height, gap: 12),
            .init(height: max((TextStyles.startSlideBody.lineHeight ?? 24), status.string.isEmpty ? 0 : status.measurable.height(fitting: width)), gap: 12),
        ]
    }

    override func contentHeight(width: CGFloat) -> CGFloat { CloudColumnLayout.stack(items(width: width), width: width).height }

    override func layoutContent() {
        let frames = CloudColumnLayout.stack(items(width: content.bounds.width), width: content.bounds.width).frames
        nameField.setLayoutFrame(frames[0])
        codeField.setLayoutFrame(frames[1])
        status.setLayoutFrame(frames[2])
    }

    /// The primary button's action; like `create`, it leaves `isLoading`
    /// to the button.
    func join() async {
        let name = Strings.HappyCloud.bareName(nameField.text.text ?? "")
        let code = (codeField.text.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !code.isEmpty else {
            status.string = Strings.HappyCloud.joinMissing
            return relayout()
        }
        status.string = ""
        do {
            let server = try await account.join(name, code: code)
            navigationController?.pushViewController(CloudConnectingViewController(context: context, account: account, server: server), animated: true)
        } catch CloudAccountError.signInRequired {
            CloudScreens.signedOut(context: context, from: self)
        } catch {
            status.string = Strings.HappyCloud.failure(error)
        }
        relayout()
    }
}

/// Signing in to a server just made or joined by invite: a token for it
/// from the accounts API, no browser, then its home. A failure says why,
/// with Try Again.
final class CloudConnectingViewController: CloudStageViewController {
    private let account: CloudAccount
    private let server: CloudServer
    private let startsAtOnce: Bool
    private let spinner = UIActivityIndicatorView(style: .large)
    /// How the server's sign-in is made: the cloud's own; a test's stand-in.
    var makeFlow: (String) throws -> ServerSignInFlow = { try ServerSignInFlow.cloud($0) }
    private var started = false

    init(context: AppContext, account: CloudAccount, server: CloudServer, startsAtOnce: Bool = true) {
        self.account = account
        self.server = server
        self.startsAtOnce = startsAtOnce
        super.init(context: context, scene: .robot, title: Strings.HappyCloud.connecting(HappyCloud.handle(server.name)), body: Strings.HappyCloud.connectingBody, primary: Strings.HappyCloud.tryAgain)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "cloud-connecting"
        primary.accessibilityIdentifier = "cloud-connect-again"
        primary.isHidden = true
        primary.action = { [weak self] in await self?.connect() }
        spinner.color = StartViewController.Colors.text
        spinner.startAnimating()
        content.addSubview(spinner)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard startsAtOnce, !started else { return }
        started = true
        Task { await connect() }
    }

    override func contentHeight(width: CGFloat) -> CGFloat { spinner.isAnimating ? 44 : 0 }
    override func layoutContent() {
        spinner.setLayoutFrame(CloudColumnLayout.stack([.init(size: CGSize(width: 44, height: content.bounds.height), centred: true)], width: content.bounds.width).frames[0])
    }

    private func show(problem: String?) {
        titleLabel.string = problem == nil ? Strings.HappyCloud.connecting(HappyCloud.handle(server.name)) : Strings.CloudConnect.failedTitle
        bodyLabel.string = problem ?? Strings.HappyCloud.connectingBody
        bodyLabel.textColor = problem == nil ? UIColor(Palette.startTextSecondary) : UIColor(Palette.textDestructive)
        if problem == nil { spinner.startAnimating() } else { spinner.stopAnimating() }
        primary.isHidden = problem == nil
        relayout()
    }

    private func connect() async {
        show(problem: nil)
        do {
            _ = try await CloudScreens.join(server, account: account, context: context, on: self, open: true, makeFlow: makeFlow)
            CloudScreens.finish(from: self, opened: true)
        } catch CloudAccountError.signInRequired {
            CloudScreens.signedOut(context: context, from: self)
        } catch {
            show(problem: CloudScreens.problem(error))
        }
    }
}

/// The app's own browser sheet, until it comes back to Happy's redirect
/// URI. `ephemeral` keeps Safari's cookies out (and asks nothing first).
@MainActor
enum CloudBrowser {
    static func authenticate(_ url: URL, anchor: ASWebAuthenticationPresentationContextProviding, ephemeral: Bool = false,
                             keep: (ASWebAuthenticationSession) -> Void) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callback: .customScheme(OAuthRedirect.scheme)) { callback, error in
                if let callback { continuation.resume(returning: callback) }
                else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin { continuation.resume(throwing: OAuthError.cancelled) }
                else { continuation.resume(throwing: error ?? OAuthError.invalidResponse) }
            }
            session.prefersEphemeralWebBrowserSession = ephemeral
            session.presentationContextProvider = anchor
            keep(session)
            if !session.start() { continuation.resume(throwing: OAuthError.invalidResponse) }
        }
    }

    static func anchor(_ view: UIView) -> ASPresentationAnchor {
        view.window ?? UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first!
    }
}

/// A server in Join a server's list, on glass over the gradient: its
/// picture, its name over `@name`, and Join, Joining, or Joined with a
/// check (`CloudServerRowLayout`).
final class CloudServerRow: UIView {
    enum State { case join, joining, joined }

    private let glass = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterial))
    let picture = UIImageView()
    let title = StyledLabel(style: TextStyle(.semiBold, size: 17, lineHeight: 22), color: Palette.startText, lines: 1)
    let subtitle = StyledLabel(style: TextStyle(.regular, size: 15, lineHeight: 20), color: Palette.startTextSecondary, lines: 1)
    let join = RoundButton(title: Strings.CloudConnect.join, size: .small)
    private let joined = UIButton(type: .system)

    var state: State = .join {
        didSet { apply() }
    }
    /// Join's spoken name, "Join Acme": the button sets its own label from
    /// its title whenever it changes, so it is put back after.
    var joinLabel: String? {
        didSet { apply() }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        glass.clipsToBounds = true
        glass.layer.cornerRadius = 22
        glass.layer.cornerCurve = .continuous
        glass.isUserInteractionEnabled = false
        picture.contentMode = .scaleAspectFill
        picture.clipsToBounds = true
        picture.layer.cornerRadius = CloudServerRowLayout.Metrics.picture / 2
        var look = UIButton.Configuration.plain()
        look.image = UIImage(systemName: "checkmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold))
        look.imagePadding = 4
        look.contentInsets = .zero
        look.attributedTitle = AttributedString(Strings.CloudConnect.joined, attributes: AttributeContainer([
            .font: UIFont(name: FontFace.regular.rawValue, size: 15) ?? .systemFont(ofSize: 15),
        ]))
        joined.configuration = look
        joined.tintColor = UIColor(Palette.startTextSecondary)
        joined.isUserInteractionEnabled = false
        joined.accessibilityLabel = Strings.CloudConnect.joined
        for view in [glass, picture, title, subtitle, join, joined] as [UIView] { addSubview(view) }
        apply()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func apply() {
        join.isHidden = state == .joined
        join.isLoading = state == .joining
        if let joinLabel { join.accessibilityLabel = joinLabel }
        joined.isHidden = state != .joined
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let buttonSize = state == .joined ? joined.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: 32)) : join.layout(width: 0).size
        let layout = CloudServerRowLayout(width: bounds.width, button: CGSize(width: buttonSize.width, height: max(32, buttonSize.height)))
        glass.setLayoutFrame(bounds)
        picture.setLayoutFrame(layout.picture)
        title.setLayoutFrame(layout.title)
        subtitle.setLayoutFrame(layout.subtitle)
        join.setLayoutFrame(layout.button)
        joined.setLayoutFrame(layout.button)
    }
}

/// A large field on the gradient, with an optional prefix such as `@`.
final class CloudField: UIView {
    static let height: CGFloat = 58
    private let glass = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterial))
    private let prefix = UILabel()
    let text = UITextField()

    init(prefix: String?, placeholder: String) {
        super.init(frame: .zero)
        glass.clipsToBounds = true
        glass.layer.cornerRadius = 18
        glass.layer.cornerCurve = .continuous
        glass.isUserInteractionEnabled = false
        let font = UIFont(name: FontFace.regular.rawValue, size: 20) ?? .systemFont(ofSize: 20)
        self.prefix.text = prefix
        self.prefix.font = font
        self.prefix.textColor = UIColor(Palette.startTextSecondary)
        text.font = font
        text.textColor = UIColor(Palette.startText)
        text.attributedPlaceholder = NSAttributedString(string: placeholder, attributes: [.foregroundColor: UIColor(Palette.startTextSecondary).withAlphaComponent(0.5)])
        text.autocapitalizationType = .none
        text.autocorrectionType = .no
        text.spellCheckingType = .no
        text.keyboardType = .asciiCapable
        text.clearButtonMode = .whileEditing
        for view in [glass, self.prefix, text] as [UIView] { addSubview(view) }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        glass.frame = bounds
        let prefixWidth = prefix.text == nil ? 0 : ceil(prefix.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: bounds.height)).width)
        prefix.frame = CGRect(x: 18, y: 0, width: prefixWidth, height: bounds.height)
        let x = prefixWidth > 0 ? prefix.frame.maxX + 1 : 18
        text.frame = CGRect(x: x, y: 0, width: bounds.width - x - 12, height: bounds.height)
    }
}

#if DEBUG
/// Each Happy Cloud screen under an account token, for the harness's
/// device screenshots (`-screen cloud -cloudScreen …`): `welcome`,
/// `expired`, `test`, `servers` (two of the preview's own),
/// `empty` (none: Bootstrap), `live` (the account's, under the token),
/// `create`, `join`, `connecting`.
public enum CloudScreensPreview {
    @MainActor
    public static func make(context: AppContext, token: String, screen: String, name: String?) -> UINavigationController {
        let account = CloudAccount.preview(token: token, expiresAt: nil)
        CloudScreens.account = screen == "expired" ? nil : account
        let navigation = UINavigationController(rootViewController: CloudWelcomeViewController(context: context, expired: screen == "expired"))
        let server = CloudServer(id: "preview", name: name ?? "acme", url: "", role: .owner, displayName: "Acme")
        let list = [server, CloudServer(id: "preview-2", name: "globex-labs", url: "", role: .member, displayName: "Globex Labs")]
        switch screen {
        case "test": navigation.pushViewController(CloudTestSignInViewController(context: context), animated: false)
        case "servers": navigation.pushViewController(CloudServersViewController(context: context, account: account, load: { list }), animated: false)
        case "empty": navigation.pushViewController(CloudServersViewController(context: context, account: account, load: { [] }), animated: false)
        case "live": navigation.pushViewController(CloudServersViewController(context: context, account: account), animated: false)
        case "create":
            let create = CloudCreateViewController(context: context, account: account)
            navigation.pushViewController(create, animated: false)
            if let name { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { create.field.text.text = name; create.edited() } }
        case "join":
            let join = CloudJoinViewController(context: context, account: account)
            navigation.pushViewController(join, animated: false)
            if let name { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { join.nameField.text.text = name; join.codeField.text.text = "pcmurcvd"; join.edited() } }
        case "connecting": navigation.pushViewController(CloudConnectingViewController(context: context, account: account, server: server, startsAtOnce: false), animated: false)
        default: break
        }
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        return navigation
    }
}
#endif
#endif
