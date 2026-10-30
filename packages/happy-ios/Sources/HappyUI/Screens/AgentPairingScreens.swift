#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
import UIKit

final class AgentIdentityView: UIView {
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
    func layout(_ width: CGFloat) -> AgentIdentityLayout {
        AgentIdentityLayout(width: width, title: heading.measurable, body: body.measurable, emoji: emoji.measurable)
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
enum PairingFlow {
    @discardableResult
    /// `start`: how the link came, for the pairing's events.
    static func openIfAgentPairing(_ text: String, context: AppContext, on controller: UIViewController, start: PairingStart = .openedLink) -> Bool {
        guard PairingLink.isAgentConnection(text) else { return false }
        do {
            let link = try PairingLink(text)
            let pairing = AgentPairingViewController(context: context, link: link, start: start)
            controller.navigationController?.pushViewController(pairing, animated: true)
        } catch {
            PairingAnalytics.shared.log(.failed(method: .agentConnection, start: start))
            Alerts.show("Could not pair", error.localizedDescription, on: controller)
        }
        return true
    }

}

final class AgentPairingViewController: UIViewController {
    private let context: AppContext
    private let link: PairingLink
    private let service: PairingService
    private let identity = AgentIdentityView()
    private lazy var screen = OnboardingScreenView(content: identity, primary: RoundButton(title: "Connecting…"), secondary: RoundButton(title: "Cancel", size: .normal, display: .inverted))
    private var job: Task<Void, Never>?
    private var expiry: Task<Void, Never>?
    private var ready = false
    private var finished = false
    private let start: PairingStart
    /// Its ending, once logged.
    private var reported = false

    init(context: AppContext, link: PairingLink, start: PairingStart = .openedLink) {
        self.context = context; self.link = link; self.start = start; service = PairingService(link: link)
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
    override func loadView() { view = screen }
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Connect Agent"
        identity.heading.string = link.name
        identity.body.string = "Name from pairing code · not verified yet\nConnecting to the agent…"
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
                identity.body.string = "Name from pairing code · unverified\n\nCompare these four emoji with the agent. Continue only when all four match. Confirm on both screens."
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
            self?.fail(PairingError.expired)
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
            try await context.account.addAgentConnection(credentials, name: link.name)
            finished = true
            report(.completed(method: .agentConnection, start: start))
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
        report(.failed(method: .agentConnection, start: start))
        finished = true; job?.cancel(); expiry?.cancel()
        let service = service; Task { await service.cancel() }
        screen.primary.isLoading = false; screen.primary.isEnabled = false; screen.primary.title = "Pairing ended"
        identity.body.string = error is PairingError ? error.localizedDescription : PairingError.unavailable.localizedDescription
        identity.emoji.string = ""; screen.secondary.title = "Back"
        view.setNeedsLayout()
    }
    private func cancel() {
        if !finished { report(.cancelled(method: .agentConnection, start: start)) }
        job?.cancel(); expiry?.cancel(); finished = true
        let service = service; Task { await service.cancel() }
        navigationController?.popViewController(animated: true)
    }
    @objc private func backgrounded() { fail(PairingError.expired) }
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isMovingFromParent || navigationController == nil || navigationController?.isBeingDismissed == true {
            // Left before it ended: back, or the sheet swiped away.
            if !finished { report(.cancelled(method: .agentConnection, start: start)) }
            job?.cancel(); expiry?.cancel()
            let service = service; Task { await service.cancel() }
        }
    }
}

#endif