#if canImport(UIKit)
import AuthenticationServices
import CryptoKit
import HappyCore
import HappyLayout
import UIKit

/// Happy Cloud's screens, full screen on the first screen's Grain Gradient
/// with its large type and one primary action each: Welcome (Sign in with
/// Apple, or the account's sign-in in the system browser), Your Servers,
/// Create, Join, and Connecting (a token for the server from the accounts
/// API, no browser). A server shows as `@name`. docs/SERVER-SIGN-IN.md,
/// "Happy Cloud".
@MainActor
enum CloudScreens {
    /// The account's one-hour pass, in memory only, while it lasts.
    static var account: CloudAccount?

    /// The first screen of the flow: the servers while the account's pass
    /// lasts, Welcome otherwise.
    static func first(context: AppContext) -> UIViewController {
        CloudAccount.forgetKeptGrant(backend: SecurityKeychainBackend())
        if let account, account.isLive() { return CloudServersViewController(context: context, account: account) }
        account = nil
        return CloudWelcomeViewController(context: context)
    }

    /// Signed in: the servers.
    static func signedIn(_ account: CloudAccount, context: AppContext, from controller: UIViewController) {
        self.account = account
        controller.navigationController?.pushViewController(CloudServersViewController(context: context, account: account), animated: true)
    }

    /// Back to Welcome when the account's pass has ended: no retry.
    static func signedOut(context: AppContext, from controller: UIViewController) {
        account = nil
        guard let navigation = controller.navigationController else { return }
        var stack = Array(navigation.viewControllers.prefix { !($0 is CloudStageViewController) })
        stack.append(CloudWelcomeViewController(context: context))
        navigation.setViewControllers(stack, animated: true)
    }

    /// Done: the sheet goes, or a pushed flow returns to where it began.
    static func finish(from controller: UIViewController) {
        guard let navigation = controller.navigationController else { return }
        if navigation.presentingViewController != nil { navigation.dismiss(animated: true); return }
        if let start = navigation.viewControllers.last(where: { !($0 is CloudStageViewController) }) { navigation.popToViewController(start, animated: true) }
    }
}

/// One Happy Cloud screen: the gradient, optional art, a large title, a
/// line under it, what the screen holds, and its action at the bottom,
/// riding the keyboard.
class CloudStageViewController: UIViewController {
    let context: AppContext
    private let gradient = GrainGradientView(palette: StartViewController.Colors.grain)
    let scroll = UIScrollView()
    private let art: StateSceneView?
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

    init(context: AppContext, scene: StateScene?, title: String, body: String, primary: String, secondary: String? = nil) {
        self.context = context
        art = scene.map { StateSceneView(scene: $0, size: StartLayout.Metrics.art, replayLabel: title) }
        titleLabel = StartGalleryView.titleLabel(title)
        bodyLabel = StartGalleryView.bodyLabel(body)
        self.primary = RoundButton(title: primary)
        self.secondary = secondary.map { RoundButton(title: $0, size: .normal, display: .inverted) }
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        gradient.frame = view.bounds
        gradient.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(gradient)
        let bar = UINavigationBarAppearance()
        bar.configureWithTransparentBackground()
        navigationItem.standardAppearance = bar
        navigationItem.scrollEdgeAppearance = bar
        navigationItem.compactAppearance = bar
        minimalBackButton()
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

    /// How tall the screen's own part is at `width`.
    func contentHeight(width: CGFloat) -> CGFloat { 0 }
    /// Places the screen's own part in `content`'s bounds.
    func layoutContent() {}

    func relayout() { view.setNeedsLayout() }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let bounds = view.bounds
        let safe = view.safeAreaInsets
        let width = min(bounds.width - 48, 440)
        let x = (bounds.width - width) / 2
        var y = safe.top + 24
        if let art {
            art.frame = CGRect(x: (bounds.width - StartLayout.Metrics.art) / 2, y: y, width: StartLayout.Metrics.art, height: StartLayout.Metrics.art)
            y += StartLayout.Metrics.art + 24
        }
        let fit = CGSize(width: width, height: .greatestFiniteMagnitude)
        let titleHeight = ceil(titleLabel.sizeThatFits(fit).height)
        titleLabel.frame = CGRect(x: x, y: y, width: width, height: titleHeight)
        y += titleHeight + 12
        let bodyHeight = bodyLabel.string.isEmpty ? 0 : ceil(bodyLabel.sizeThatFits(fit).height)
        bodyLabel.frame = CGRect(x: x, y: y, width: width, height: bodyHeight)
        y += bodyHeight + 32
        let contentHeight = contentHeight(width: width)
        content.frame = CGRect(x: x, y: y, width: width, height: contentHeight)
        layoutContent()
        y += contentHeight + 24
        let primaryHeight = primary.isHidden && primaryReplacement == nil ? 0 : primary.layout(width: width).size.height
        let secondaryHeight = secondary.map { $0.isHidden ? 0 : $0.layout(width: width).size.height } ?? 0
        let actions = primaryHeight + (secondaryHeight > 0 ? secondaryHeight + 4 : 0)
        let bottom = min(bounds.height - max(safe.bottom, 16) - 16, keyboardProbe.frame.maxY - 16)
        let top = max(y, bottom - actions)
        primary.frame = CGRect(x: x, y: top, width: width, height: primaryHeight)
        primaryReplacement?.frame = primary.frame
        secondary?.frame = CGRect(x: x, y: top + primaryHeight + 4, width: width, height: secondaryHeight)
        scroll.frame = bounds
        scroll.contentSize = CGSize(width: bounds.width, height: top + actions + max(safe.bottom, 16) + 16)
    }
}

/// "Connect to Happy Cloud?": Sign in with Apple, or other ways in the
/// system browser.
final class CloudWelcomeViewController: CloudStageViewController, ASWebAuthenticationPresentationContextProviding {
    private var browser: ASWebAuthenticationSession?
    private var apple: CloudApple?
    private let appleButton = ASAuthorizationAppleIDButton(authorizationButtonType: .continue, authorizationButtonStyle: .black)
    private let problem = StartGalleryView.bodyLabel("")

    init(context: AppContext) {
        super.init(context: context, scene: .sparkles, title: Strings.ServerSignIn.cloudTitle, body: Strings.ServerSignIn.cloudMessage,
                   primary: Strings.ServerSignIn.cloudConnect, secondary: Strings.HappyCloud.otherWays)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "cloud-welcome"
        appleButton.accessibilityIdentifier = "cloud-apple"
        appleButton.addAction(UIAction { [weak self] _ in Task { await self?.signInWithApple() } }, for: .touchUpInside)
        primaryReplacement = appleButton
        secondary?.accessibilityIdentifier = "cloud-connect"
        secondary?.action = { [weak self] in await self?.signInInBrowser() }
        problem.textColor = UIColor(Palette.textDestructive)
        content.addSubview(problem)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        appleButton.cornerRadius = appleButton.bounds.height / 2
    }

    override func contentHeight(width: CGFloat) -> CGFloat {
        problem.string.isEmpty ? 0 : ceil(problem.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height)
    }

    override func layoutContent() { problem.frame = content.bounds }

    private func signInWithApple() async {
        guard apple == nil else { return }
        say(nil)
        let apple = CloudApple(anchor: view)
        self.apple = apple
        defer { self.apple = nil }
        do {
            let identity = try await apple.signIn()
            let account = try await CloudAccount.signIn(provider: "apple", idToken: identity.idToken, nonce: identity.nonce,
                                                        authorizationCode: identity.authorizationCode, name: identity.name)
            CloudScreens.signedIn(account, context: context, from: self)
        } catch OAuthError.cancelled {
        } catch {
            say(Strings.HappyCloud.failure(error))
        }
    }

    private func signInInBrowser() async {
        say(nil)
        do {
            let request = try CloudAccount.request()
            let callback = try await CloudBrowser.authenticate(request.url, anchor: self) { self.browser = $0 }
            let account = try await CloudAccount.signIn(request, callback: callback)
            CloudScreens.signedIn(account, context: context, from: self)
        } catch OAuthError.cancelled {
        } catch {
            say(Strings.ServerSignIn.failure(error))
        }
    }

    private func say(_ text: String?) {
        problem.string = text ?? ""
        relayout()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { CloudBrowser.anchor(view) }
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

/// The servers the account belongs to, each a card; Create a New Server,
/// and Join with an invite under it.
final class CloudServersViewController: CloudStageViewController {
    private let account: CloudAccount
    private var servers: [CloudServer]?
    private var cards: [String: CloudServerCard] = [:]
    private var order: [String] = []
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var pictures: [String: UIImage] = [:]
    private var loadingPictures: Set<String> = []

    init(context: AppContext, account: CloudAccount) {
        self.account = account
        super.init(context: context, scene: nil, title: Strings.HappyCloud.yourServers, body: "", primary: Strings.HappyCloud.create, secondary: Strings.HappyCloud.joinWithInvite)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "cloud-servers"
        primary.accessibilityIdentifier = "cloud-create"
        secondary?.accessibilityIdentifier = "cloud-join"
        primary.onTap = { [weak self] in
            guard let self else { return }
            navigationController?.pushViewController(CloudCreateViewController(context: context, account: account), animated: true)
        }
        secondary?.onTap = { [weak self] in
            guard let self else { return }
            navigationController?.pushViewController(CloudJoinViewController(context: context, account: account), animated: true)
        }
        spinner.color = StartViewController.Colors.text
        content.addSubview(spinner)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        Task { await reload() }
    }

    private func reload() async {
        if servers == nil { spinner.startAnimating() }
        do {
            servers = try await account.servers()
            bodyLabel.string = servers?.isEmpty == true ? Strings.HappyCloud.noServers : Strings.HappyCloud.pickServer
        } catch CloudAccountError.signInRequired {
            CloudScreens.signedOut(context: context, from: self)
            return
        } catch {
            bodyLabel.string = Strings.HappyCloud.failure(error)
        }
        spinner.stopAnimating()
        rebuild()
    }

    private func rebuild() {
        cards.values.forEach { $0.removeFromSuperview() }
        cards = [:]
        order = []
        let connected = Set(context.account.agentConnections.accounts.compactMap(\.server))
        for server in servers ?? [] {
            guard let origin = server.origin else { continue }
            let card = CloudServerCard()
            card.title.string = server.title
            card.subtitle.string = HappyCloud.handle(server.name)
            card.detail.string = connected.contains(origin) ? Strings.HappyCloud.connected : server.role == .owner ? Strings.HappyCloud.owner : ""
            card.picture.image = picture(server)
            card.accessibilityIdentifier = "cloud-server-\(server.name)"
            card.addAction(UIAction { [weak self] _ in self?.connect(server, origin: origin) }, for: .touchUpInside)
            content.addSubview(card)
            cards[server.id] = card
            order.append(server.id)
        }
        relayout()
    }

    override func contentHeight(width: CGFloat) -> CGFloat {
        if servers == nil { return 44 }
        return order.isEmpty ? 0 : CGFloat(order.count) * CloudServerCard.height + CGFloat(order.count - 1) * 12
    }

    override func layoutContent() {
        spinner.center = CGPoint(x: content.bounds.midX, y: 22)
        for (index, id) in order.enumerated() {
            cards[id]?.frame = CGRect(x: 0, y: CGFloat(index) * (CloudServerCard.height + 12), width: content.bounds.width, height: CloudServerCard.height)
        }
    }

    /// Its picture, else its ThumbHash, else the generated avatar; the
    /// rest is fetched once and the card updated.
    private func picture(_ server: CloudServer) -> UIImage {
        let side = CloudServerCard.pictureSide
        if pictures[server.id] == nil, !loadingPictures.contains(server.id) {
            loadingPictures.insert(server.id)
            Task { [weak self, account] in
                var image: UIImage?
                if let picture = server.image, let data = try? await account.image(picture) {
                    image = await Task.detached { AccountPictureImages.decode(data)?.picture as? UIImage }.value
                }
                if image == nil { image = await AvatarPlaceholderImages.image(seed: server.id, side: side) }
                guard let self, let image else { return }
                pictures[server.id] = image
                cards[server.id]?.picture.image = image
            }
        }
        return pictures[server.id] ?? ThumbHashImages.image(server.image?.thumbhash)
            ?? AvatarPlaceholderImages.cached(seed: server.id, side: side) ?? AvatarPlaceholderImages.pending(side: side)
    }

    /// A server here already comes forward; another is connected to.
    private func connect(_ server: CloudServer, origin: String) {
        let accounts = context.account
        if let existing = HappyCloud.connection(to: origin, in: accounts.agentConnections.accounts), !existing.revoked {
            Task { [weak self] in
                if !accounts.showsAgentConnections { await accounts.setShowsAgentConnections(true) }
                guard (try? await accounts.switchAccount(to: existing.id)) != nil, let self else { return }
                CloudScreens.finish(from: self)
            }
            return
        }
        navigationController?.pushViewController(CloudConnectingViewController(context: context, account: account, server: server), animated: true)
    }
}

/// A new server's name, as `@name`, checked as it is typed, then made with
/// the person as its owner and connected to.
final class CloudCreateViewController: CloudStageViewController, UITextFieldDelegate {
    private let account: CloudAccount
    let field = CloudField(prefix: "@", placeholder: Strings.HappyCloud.namePlaceholder)
    let status = StartGalleryView.bodyLabel("")
    private var checking: Task<Void, Never>?

    init(context: AppContext, account: CloudAccount) {
        self.account = account
        super.init(context: context, scene: nil, title: Strings.HappyCloud.createTitle, body: Strings.HappyCloud.nameFooter, primary: Strings.HappyCloud.createAction)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "cloud-create-server"
        primary.accessibilityIdentifier = "cloud-create-save"
        field.text.accessibilityIdentifier = "cloud-create-name"
        field.text.returnKeyType = .done
        field.text.delegate = self
        field.text.addTarget(self, action: #selector(edited), for: .editingChanged)
        primary.action = { [weak self] in await self?.create() }
        content.addSubview(field)
        content.addSubview(status)
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
        say("")
        let name = name
        guard !name.isEmpty else { return }
        guard HappyCloud.isValidName(name) else { return say(Strings.HappyCloud.invalidName, problem: true) }
        checking = Task { [weak self, account] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            let answer: Result<CloudAccount.Availability, any Error>
            do { answer = .success(try await account.availability(name)) } catch { answer = .failure(error) }
            guard !Task.isCancelled, let self, self.name == name else { return }
            switch answer {
            case .success(.available): say(Strings.HappyCloud.available(name))
            case .success(let answer): say(Strings.HappyCloud.unavailable(answer, name: name) ?? "", problem: true)
            case .failure(CloudAccountError.signInRequired): CloudScreens.signedOut(context: context, from: self)
            case .failure(let error): say(Strings.HappyCloud.failure(error), problem: true)
            }
        }
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        // Through the button, which shows it working and runs it once.
        primary.tapped()
        return false
    }

    override func contentHeight(width: CGFloat) -> CGFloat {
        CloudField.height + (status.string.isEmpty ? 0 : 12 + ceil(status.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height))
    }

    override func layoutContent() {
        field.frame = CGRect(x: 0, y: 0, width: content.bounds.width, height: CloudField.height)
        status.frame = CGRect(x: 0, y: CloudField.height + 12, width: content.bounds.width, height: max(0, content.bounds.height - CloudField.height - 12))
    }

    /// The primary button's action: `RoundButton` marks itself loading
    /// before running it, so this never checks `isLoading` itself, which
    /// once made every tap return without a word.
    func create() async {
        let name = name
        guard HappyCloud.isValidName(name) else { return say(Strings.HappyCloud.invalidName, problem: true) }
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

/// A server's `@name` and the invite code its owner gave.
final class CloudJoinViewController: CloudStageViewController, UITextFieldDelegate {
    private let account: CloudAccount
    let nameField = CloudField(prefix: "@", placeholder: Strings.HappyCloud.namePlaceholder)
    let codeField = CloudField(prefix: nil, placeholder: Strings.HappyCloud.codePlaceholder)
    let status = StartGalleryView.bodyLabel("")

    init(context: AppContext, account: CloudAccount) {
        self.account = account
        super.init(context: context, scene: nil, title: Strings.HappyCloud.join, body: Strings.HappyCloud.joinMessage, primary: Strings.HappyCloud.joinAction)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "cloud-join-server"
        primary.accessibilityIdentifier = "cloud-join-save"
        nameField.text.accessibilityIdentifier = "cloud-join-name"
        codeField.text.accessibilityIdentifier = "cloud-join-code"
        nameField.text.returnKeyType = .next
        codeField.text.returnKeyType = .join
        nameField.text.delegate = self
        codeField.text.delegate = self
        status.textColor = UIColor(Palette.textDestructive)
        primary.action = { [weak self] in await self?.join() }
        for subview in [nameField, codeField, status] { content.addSubview(subview) }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        nameField.text.becomeFirstResponder()
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        if textField === nameField.text { codeField.text.becomeFirstResponder() } else { primary.tapped() }
        return false
    }

    override func contentHeight(width: CGFloat) -> CGFloat {
        CloudField.height * 2 + 12 + (status.string.isEmpty ? 0 : 12 + ceil(status.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height))
    }

    override func layoutContent() {
        let width = content.bounds.width
        nameField.frame = CGRect(x: 0, y: 0, width: width, height: CloudField.height)
        codeField.frame = CGRect(x: 0, y: CloudField.height + 12, width: width, height: CloudField.height)
        let top = CloudField.height * 2 + 24
        status.frame = CGRect(x: 0, y: top, width: width, height: max(0, content.bounds.height - top))
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

/// Signing in to one server: a token for it from the accounts API, no
/// browser, then its home.
final class CloudConnectingViewController: CloudStageViewController {
    private let account: CloudAccount
    private let server: CloudServer
    private let startsAtOnce: Bool
    private let spinner = UIActivityIndicatorView(style: .large)
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
    override func layoutContent() { spinner.center = CGPoint(x: content.bounds.midX, y: content.bounds.midY) }

    private func show(problem: String?) {
        bodyLabel.string = problem ?? Strings.HappyCloud.connectingBody
        bodyLabel.textColor = problem == nil ? UIColor(Palette.startTextSecondary) : UIColor(Palette.textDestructive)
        if problem == nil { spinner.startAnimating() } else { spinner.stopAnimating() }
        primary.isHidden = problem == nil
        relayout()
    }

    private func connect() async {
        guard let origin = server.origin else { return show(problem: Strings.ServerSignIn.failure(ServerSignInError.invalidURL)) }
        show(problem: nil)
        do {
            let (access, grant) = try await account.serverToken(for: server)
            let flow = try ServerSignInFlow.cloud(origin)
            var signedIn = try await flow.signedIn(access: access, grant: grant, installation: .recorded)
            // The cloud names every member from the account; this only
            // answers the team profile gate on a server that hasn't.
            if signedIn.needsProfile { signedIn = try await flow.saveProfile(HappyCloud.handle(server.name), for: signedIn) }
            try await context.account.addServer(signedIn)
            CloudScreens.finish(from: self)
        } catch CloudAccountError.signInRequired {
            CloudScreens.signedOut(context: context, from: self)
        } catch let error as CloudAccountError {
            show(problem: Strings.HappyCloud.failure(error))
        } catch {
            show(problem: Strings.ServerSignIn.failure(error))
        }
    }
}

/// The system browser, until it comes back to Happy's redirect URI. Not
/// ephemeral, so the accounts service's own session spares a second
/// sign-in there.
@MainActor
enum CloudBrowser {
    static func authenticate(_ url: URL, anchor: ASWebAuthenticationPresentationContextProviding, keep: (ASWebAuthenticationSession) -> Void) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callback: .customScheme(OAuthRedirect.scheme)) { callback, error in
                if let callback { continuation.resume(returning: callback) }
                else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin { continuation.resume(throwing: OAuthError.cancelled) }
                else { continuation.resume(throwing: error ?? OAuthError.invalidResponse) }
            }
            session.prefersEphemeralWebBrowserSession = false
            session.presentationContextProvider = anchor
            keep(session)
            if !session.start() { continuation.resume(throwing: OAuthError.invalidResponse) }
        }
    }

    static func anchor(_ view: UIView) -> ASPresentationAnchor {
        view.window ?? UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first!
    }
}

/// A server as a card on the gradient: its picture, its name, `@name`, and
/// whether it is connected or yours.
final class CloudServerCard: UIControl {
    static let height: CGFloat = 76
    static let pictureSide: CGFloat = 48
    private let glass = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterial))
    let picture = UIImageView()
    let title = StyledLabel(style: TextStyle(.semiBold, size: 17, lineHeight: 22), color: Palette.startText, lines: 1)
    let subtitle = StyledLabel(style: TextStyle(.regular, size: 15, lineHeight: 20), color: Palette.startTextSecondary, lines: 1)
    let detail = StyledLabel(style: TextStyle(.regular, size: 15, lineHeight: 20), color: Palette.startTextSecondary, lines: 1)
    private let chevron = UIImageView(image: UIImage(systemName: "chevron.right", withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold)))

    override init(frame: CGRect) {
        super.init(frame: frame)
        glass.clipsToBounds = true
        glass.layer.cornerRadius = 22
        glass.layer.cornerCurve = .continuous
        picture.contentMode = .scaleAspectFill
        picture.clipsToBounds = true
        picture.layer.cornerRadius = Self.pictureSide / 2
        chevron.tintColor = UIColor(Palette.startTextSecondary)
        isAccessibilityElement = true
        accessibilityTraits = .button
        for view in [glass, picture, title, subtitle, detail, chevron] as [UIView] {
            view.isUserInteractionEnabled = false
            addSubview(view)
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.6 : 1 }
    }

    override var accessibilityLabel: String? {
        get { [title.string, subtitle.string, detail.string].filter { !$0.isEmpty }.joined(separator: ", ") }
        set {}
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        glass.frame = bounds
        let side = Self.pictureSide
        picture.frame = CGRect(x: 14, y: (bounds.height - side) / 2, width: side, height: side)
        let chevronSize = chevron.image?.size ?? .zero
        chevron.frame = CGRect(x: bounds.width - 18 - chevronSize.width, y: (bounds.height - chevronSize.height) / 2, width: chevronSize.width, height: chevronSize.height)
        let detailWidth = detail.string.isEmpty ? 0 : ceil(detail.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: 20)).width)
        detail.frame = CGRect(x: chevron.frame.minX - 10 - detailWidth, y: (bounds.height - 20) / 2, width: detailWidth, height: 20)
        let textX = picture.frame.maxX + 14
        let textWidth = max(0, (detailWidth > 0 ? detail.frame.minX : chevron.frame.minX) - 10 - textX)
        title.frame = CGRect(x: textX, y: bounds.height / 2 - 22, width: textWidth, height: 22)
        subtitle.frame = CGRect(x: textX, y: bounds.height / 2 + 1, width: textWidth, height: 20)
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
/// device screenshots (`-screen cloud -cloudScreen …`).
public enum CloudScreensPreview {
    @MainActor
    public static func make(context: AppContext, token: String, screen: String, name: String?) -> UINavigationController {
        let account = CloudAccount.preview(token: token, expiresAt: screen == "expired" ? Date(timeIntervalSinceNow: -60) : nil)
        CloudScreens.account = account
        let navigation = UINavigationController(rootViewController: CloudWelcomeViewController(context: context))
        let server = CloudServer(id: "preview", name: name ?? "acme", url: "", role: .owner, displayName: "Acme")
        switch screen {
        // An expired pass goes straight back to Welcome.
        case "servers", "expired": navigation.pushViewController(CloudServersViewController(context: context, account: account), animated: false)
        case "create":
            let create = CloudCreateViewController(context: context, account: account)
            navigation.pushViewController(create, animated: false)
            if let name { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { create.field.text.text = name; create.edited() } }
        case "join":
            let join = CloudJoinViewController(context: context, account: account)
            navigation.pushViewController(join, animated: false)
            if let name { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { join.nameField.text.text = name; join.codeField.text.text = "pcmurcvd" } }
        case "connecting": navigation.pushViewController(CloudConnectingViewController(context: context, account: account, server: server, startsAtOnce: false), animated: false)
        default: break
        }
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        return navigation
    }
}
#endif
#endif
