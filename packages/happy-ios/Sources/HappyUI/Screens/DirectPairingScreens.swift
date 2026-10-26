#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
import UIKit

final class DirectIdentityView: UIView {
    let image = UIImageView()
    let heading = StyledLabel(style: TextStyles.restoreInstruction, color: Palette.text, alignment: .center)
    let body = StyledLabel(style: TextStyles.restorePath, color: Palette.textSecondary, alignment: .center)
    let emoji = PairingEmojiLabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        image.image = UIImage.happy("logo-black")?.withRenderingMode(.alwaysTemplate)
        image.tintColor = UIColor(Palette.headerTint)
        image.contentMode = .scaleAspectFit
        image.clipsToBounds = true
        for child in [image, heading, body, emoji] { addSubview(child) }
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
    func layout(_ width: CGFloat) -> DirectIdentityLayout {
        DirectIdentityLayout(width: width, title: heading.measurable, body: body.measurable, emoji: emoji.measurable)
    }
    override func sizeThatFits(_ size: CGSize) -> CGSize { layout(size.width).size }
    override func layoutSubviews() {
        let layout = layout(bounds.width)
        image.setLayoutFrame(layout.image); image.layer.cornerRadius = layout.image.width / 2
        heading.setLayoutFrame(layout.title); body.setLayoutFrame(layout.body); emoji.setLayoutFrame(layout.emoji)
    }
}

/// Render the comparison with the platform color emoji face at a readable
/// size, independently of the app's bundled text styles.
final class PairingEmojiLabel: UILabel {
    var string: String = "" { didSet { text = string } }
    override init(frame: CGRect) {
        super.init(frame: frame)
        numberOfLines = 0; textAlignment = .center
        font = UIFont(name: "AppleColorEmoji", size: 36) ?? .systemFont(ofSize: 36)
        adjustsFontForContentSizeCategory = true
        textColor = UIColor(Palette.text)
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
}

@MainActor
enum DirectPairingFlow {
    @discardableResult
    /// `start`: how the link came, for the pairing's events.
    static func openIfDirect(_ text: String, context: AppContext, on controller: UIViewController, start: PairingStart = .openedLink) -> Bool {
        guard DirectPairingLink.isDirect(text) else { return false }
        // The Direct connection experiment off: it says so, and offers to
        // turn it on and go on.
        let preference = StemCellsPreference(variant: context.variant)
        guard preference.showsComputers else {
            Task { @MainActor in
                guard await Alerts.confirm(Strings.StemCells.directExperimentTitle, Strings.StemCells.directExperimentDetail, confirmTitle: Strings.StemCells.turnOn, on: controller) else {
                    return PairingAnalytics.shared.log(.cancelled(method: .direct, start: start))
                }
                await StemCellsExperiments.setDirectConnection(true, context: context, surface: .onboarding)
                _ = openIfDirect(text, context: context, on: controller, start: start)
            }
            return true
        }
        do {
            let link = try DirectPairingLink(text)
            let pairing = DirectPairingViewController(context: context, link: link, start: start)
            StemCellsGlassChrome.dress(pairing, over: controller)
            controller.navigationController?.pushViewController(pairing, animated: true)
        } catch {
            PairingAnalytics.shared.log(.failed(method: .direct, start: start))
            Alerts.show("Could not pair", error.localizedDescription, on: controller)
        }
        return true
    }

    static func scan(context: AppContext, on controller: UIViewController) {
        Task { @MainActor in
            guard let text = await PairingFlow.scan(.terminal, from: controller) else { return }
            if openIfDirect(text, context: context, on: controller, start: .scan) { return }
            guard let session = context.account.session else {
                Alerts.show("Sign in to Happy", "Sign in to a Happy account before connecting this kind of computer code.", on: controller)
                return
            }
            let outcome = await PairingFlow.approve(text, expecting: .terminal, session: session)
            PairingFlow.report(outcome, kind: .terminal, on: controller)
        }
    }
}

final class DirectPairingViewController: UIViewController {
    private let context: AppContext
    private let link: DirectPairingLink
    private let service: DirectPairingService
    private let identity = DirectIdentityView()
    private lazy var screen = OnboardingScreenView(content: identity, primary: RoundButton(title: "Connecting…"), secondary: RoundButton(title: "Cancel", size: .normal, display: .inverted))
    private var job: Task<Void, Never>?
    private var expiry: Task<Void, Never>?
    private var ready = false
    private var finished = false
    private let start: PairingStart
    /// Its ending, once logged.
    private var reported = false

    init(context: AppContext, link: DirectPairingLink, start: PairingStart = .openedLink) {
        self.context = context; self.link = link; self.start = start; service = DirectPairingService(link: link)
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
    override func loadView() { view = screen }
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Pair computer"
        identity.heading.string = link.name
        identity.body.string = "Name from pairing code · not verified yet\nConnecting to your computer…"
        screen.primary.isLoading = true; screen.primary.isEnabled = false
        screen.primary.onTap = { [weak self] in
            guard let self else { return }
            job = Task { [weak self] in await self?.confirm() }
        }
        screen.secondary.onTap = { [weak self] in self?.cancel() }
        NotificationCenter.default.addObserver(self, selector: #selector(backgrounded), name: UIApplication.didEnterBackgroundNotification, object: nil)
        let service = service
        job = Task { [weak self] in
            do {
                let emoji = try await service.start(deviceName: UIDevice.current.name)
                guard let self, !Task.isCancelled else { return }
                identity.emoji.string = emoji.joined(separator: " ")
                identity.emoji.accessibilityLabel = "Verification emoji: " + emoji.joined(separator: ", ")
                identity.body.string = "Name from pairing code · unverified\n\nCompare these four emoji with the computer. Continue only when all four match. Confirm on both screens."
                screen.primary.title = "Emoji match"; screen.primary.isLoading = false; screen.primary.isEnabled = true
                screen.secondary.title = "They don’t match"
                ready = true; view.setNeedsLayout()
            } catch {
                guard !Task.isCancelled else { return }
                self?.fail(error)
            }
        }
        let delay = max(0, link.expiresAt.timeIntervalSinceNow)
        expiry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.fail(DirectPairingError.expired)
        }
    }
    private func confirm() async {
        guard ready, !finished else { return }
        ready = false; screen.primary.title = "Waiting for computer…"; screen.primary.isLoading = true; screen.primary.isEnabled = false
        identity.body.string = "Name from pairing code · unverified\n\nConfirm the same emoji on your computer to finish pairing."
        do {
            let credentials = try await service.confirm()
            try Task.checkCancellation()
            guard !finished else { return }
            // Proof is valid; account creation now loads authenticated node
            // identity immediately, and the home observes subsequent refreshes.
            expiry?.cancel()
            screen.primary.title = "Loading computer…"
            try await context.account.addDirect(credentials, name: link.name)
            finished = true
            report(.completed(method: .direct, start: start))
        } catch {
            finished = false
            fail(error)
        }
    }
    private func report(_ event: PairingEvent) {
        guard !reported else { return }
        reported = true
        PairingAnalytics.shared.log(event)
    }
    private func fail(_ error: Error) {
        guard !finished else { return }
        report(.failed(method: .direct, start: start))
        finished = true; job?.cancel(); expiry?.cancel()
        let service = service; Task { await service.cancel() }
        screen.primary.isLoading = false; screen.primary.isEnabled = false; screen.primary.title = "Pairing ended"
        identity.body.string = error is DirectPairingError ? error.localizedDescription : DirectPairingError.unavailable.localizedDescription
        identity.emoji.string = ""; screen.secondary.title = "Back"
        view.setNeedsLayout()
    }
    private func cancel() {
        if !finished { report(.cancelled(method: .direct, start: start)) }
        job?.cancel(); expiry?.cancel(); finished = true
        let service = service; Task { await service.cancel() }
        navigationController?.popViewController(animated: true)
    }
    @objc private func backgrounded() { fail(DirectPairingError.expired) }
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isMovingFromParent || navigationController == nil || navigationController?.isBeingDismissed == true {
            // Left before it ended: back, or the sheet swiped away.
            if !finished { report(.cancelled(method: .direct, start: start)) }
            job?.cancel(); expiry?.cancel()
            let service = service; Task { await service.cancel() }
        }
    }
}

final class DirectHomeViewController: UIViewController {
    private let context: AppContext
    private let id: String
    private let identity = DirectIdentityView()
    private lazy var screen = OnboardingScreenView(content: identity, primary: RoundButton(title: "Manage accounts"), secondary: RoundButton(title: "Disconnect", size: .normal, display: .inverted))
    private var observation: AccountsObservation?
    private var accountHeader: HomeAccountControl?
    private var imageJob: Task<Void, Never>?
    private var imageData: Data?

    init(context: AppContext, id: String) {
        self.context = context; self.id = id
        super.init(nibName: nil, bundle: nil); followsTextSize()
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
    override func loadView() { view = screen }
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Computer"
        accountHeader = HomeAccountControl(context: context, controller: self)
        screen.primary.onTap = { [weak self] in self?.manage() }
        screen.secondary.action = { [weak self] in await self?.disconnect() }
        observation = context.account.observeAccounts { [weak self] _ in self?.update() }
    }
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated); navigationController?.setNavigationBarHidden(false, animated: animated)
    }
    private func update() {
        guard let account = context.account.direct.accounts.first(where: { $0.id == id }) else { return }
        identity.heading.string = account.name
        identity.body.string = account.status == .revoked ? DirectPairingError.revoked.localizedDescription : "\(account.status.title)\nSessions and messages are coming soon."
        if imageData != account.avatar {
            imageData = account.avatar; imageJob?.cancel()
            let bytes = account.avatar
            imageJob = Task { [weak self] in
                let image = await Task.detached { bytes.flatMap { AccountPictureImages.decode($0)?.picture as? UIImage } }.value
                guard !Task.isCancelled, let self else { return }
                identity.image.image = image ?? UIImage.happy("logo-black")?.withRenderingMode(.alwaysTemplate)
            }
        }
        view.setNeedsLayout()
    }
    private func manage() { navigationController?.pushViewController(CombinedAccountsViewController(context: context), animated: true) }
    private func disconnect() async {
        guard await Alerts.confirm("Disconnect computer?", "This removes the connection and its credentials from this phone.", confirmTitle: "Disconnect", destructive: true, on: self) else { return }
        do { try await context.account.signOut(accountID: id) }
        catch { Alerts.show("Could not disconnect", error.localizedDescription, on: self) }
    }
}
#endif