#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// One of signing in to Happy Cloud by email's two steps: a field, a line
/// under it that says what went wrong (its two lines' room kept whether or
/// not it says anything, so nothing moves when it does), and buttons that may have to
/// wait, their titles counting down (`update`), once the accounts service
/// answers `429 rate_limited`. docs/SERVER-SIGN-IN.md, "Happy Cloud".
class CloudEmailStepViewController: CloudStageViewController, CloudSignInStep, UITextFieldDelegate {
    let field: CloudField
    let status = CloudStageViewController.bodyLabel("")
    /// Where the codes are asked for and checked; the tests' fake accounts.
    let http: any HTTPTransport
    /// The clock the waits count down by; the tests' own.
    var now: () -> Date = Date.init
    private var ticker: Task<Void, Never>?

    init(context: AppContext, http: any HTTPTransport, field: CloudField, title: String, body: String, primary: String, secondary: String? = nil) {
        self.http = http
        self.field = field
        super.init(context: context, scene: nil, title: title, body: body, primary: primary, secondary: secondary)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        field.text.delegate = self
        field.text.addTarget(self, action: #selector(edited), for: .editingChanged)
        content.addSubview(field)
        content.addSubview(status)
        tick()
    }

    override var typingField: UITextField? { field.text }

    /// What the step shows now: the buttons' titles and whether they can
    /// be used. Whether a wait is still counting down.
    @discardableResult
    func update() -> Bool { false }

    /// Updates now, and every quarter second while a wait counts down.
    func tick() {
        guard update(), ticker == nil else { return }
        ticker = Task { [weak self] in
            while true {
                try? await Task.sleep(for: .milliseconds(250))
                guard let self, !Task.isCancelled else { return }
                if !update() { ticker = nil; return }
            }
        }
    }

    @objc func edited() { update() }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        // Through the button, which shows it working and runs it once.
        if primary.isEnabled { primary.tapped() }
        return false
    }

    /// `text` under the field, red when it's a problem; nil clears it.
    func say(_ text: String?, problem: Bool = true) {
        status.string = text ?? ""
        status.textColor = UIColor(problem ? Palette.textDestructive : Palette.startTextSecondary)
        relayout()
    }

    /// When a `429` says to ask again, from now; a minute when it doesn't say.
    func waitEnds(_ error: any Error) -> Date? {
        guard case CloudAccountError.rateLimited(let retryAfter, _) = error else { return nil }
        return now().addingTimeInterval(retryAfter ?? 60)
    }

    func items(width: CGFloat, steady: Bool = false) -> [CloudColumnLayout.Item] {
        [
            .init(height: CloudField.height),
            .init(height: steady ? Self.statusRoom : Self.statusHeight(status, width: width), gap: 12),
        ]
    }

    override func contentHeight(width: CGFloat) -> CGFloat { CloudColumnLayout.stack(items(width: width), width: width).height }
    override func steadyContentHeight(width: CGFloat) -> CGFloat { CloudColumnLayout.stack(items(width: width, steady: true), width: width).height }

    override func layoutContent() {
        let frames = CloudColumnLayout.stack(items(width: content.bounds.width), width: content.bounds.width).frames
        field.setLayoutFrame(frames[0])
        status.setLayoutFrame(frames[1])
    }
}

/// Sign in with email, the first step: the address, and Send code, which
/// asks the accounts service to email a one-time code
/// (`POST /v1/auth/email/start`), then the code step.
final class CloudEmailViewController: CloudEmailStepViewController {
    /// When Send code can be used again after a `429`.
    private(set) var sendAt: Date?

    init(context: AppContext, http: any HTTPTransport) {
        super.init(context: context, http: http, field: CloudField(prefix: nil, placeholder: Strings.CloudEmail.emailPlaceholder),
                   title: Strings.CloudEmail.emailTitle, body: Strings.CloudEmail.emailMessage, primary: Strings.CloudEmail.send)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "cloud-email-step"
        primary.accessibilityIdentifier = "cloud-email-send"
        field.text.accessibilityIdentifier = "cloud-email-address"
        field.text.accessibilityLabel = "Email address"
        field.text.keyboardType = .emailAddress
        field.text.textContentType = .emailAddress
        field.text.returnKeyType = .send
        status.accessibilityIdentifier = "cloud-email-status"
        primary.action = { [weak self] in await self?.send() }
    }

    var address: String { (field.text.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }

    @discardableResult
    override func update() -> Bool {
        let wait = sendAt.map { $0.timeIntervalSince(now()) } ?? 0
        primary.title = wait > 0 ? Strings.CloudEmail.send(in: wait) : Strings.CloudEmail.send
        primary.isEnabled = wait <= 0 && !address.isEmpty
        return wait > 0
    }

    /// The primary button's action; it leaves `isLoading` to the button.
    func send() async {
        let email = address
        guard !email.isEmpty else { return say(Strings.CloudEmail.emailMissing) }
        guard email.contains("@") else { return say(Strings.CloudEmail.invalidEmail) }
        say(nil)
        do {
            try await CloudAccount.startEmailSignIn(email: email, http: http)
            let code = CloudEmailCodeViewController(context: context, email: email, http: http, sentAt: now())
            code.now = now
            CloudScreens.pushTyping(code, on: navigationController)
        } catch {
            say(Strings.CloudEmail.failure(error))
            if let ends = waitEnds(error) { sendAt = ends; tick() }
        }
    }
}

/// A mail app the code step can open, where the code is waiting.
enum MailApp: CaseIterable {
    /// Apple's Mail.
    case mail
    /// Gmail's app, when it is installed (`googlegmail` is in every
    /// Info.plist's `LSApplicationQueriesSchemes`, as `message` is).
    case gmail

    /// Its inbox.
    var url: URL {
        switch self {
        case .mail: URL(string: "message://")!
        case .gmail: URL(string: "googlegmail://")!
        }
    }

    var title: String {
        switch self {
        case .mail: Strings.CloudEmail.openMail
        case .gmail: Strings.CloudEmail.openGmail
        }
    }

    var identifier: String {
        switch self {
        case .mail: "cloud-email-open-mail"
        case .gmail: "cloud-email-open-gmail"
        }
    }
}

/// What a paste control pastes into: plain text, handed over as a string.
/// `UIPasteControl` reads the pasteboard on the person's tap, so iOS asks
/// no "Allow Paste"; it enables itself only while the pasteboard holds
/// what `pasteConfiguration` accepts.
@MainActor
final class TextPasteTarget: NSObject, UIPasteConfigurationSupporting {
    var pasteConfiguration: UIPasteConfiguration? = UIPasteConfiguration(forAccepting: NSString.self)
    var onText: (String) -> Void = { _ in }

    func canPaste(_ itemProviders: [NSItemProvider]) -> Bool {
        itemProviders.contains { $0.canLoadObject(ofClass: NSString.self) }
    }

    func paste(itemProviders: [NSItemProvider]) {
        guard let provider = itemProviders.first(where: { $0.canLoadObject(ofClass: NSString.self) }) else { return onText("") }
        _ = provider.loadObject(ofClass: NSString.self) { [weak self] value, _ in
            let text = value as? String ?? ""
            Task { @MainActor in self?.onText(text) }
        }
    }
}

/// iOS's Paste, sized for a frame layout. The control draws itself out of
/// process and knows its own size only once that has happened, a moment
/// after it is made, and says so through Auto Layout alone: until then it
/// holds a pill's room (invisible, nothing is drawn yet), and when its
/// size arrives whatever holds it is laid out again.
final class PasteControl: UIPasteControl {
    /// Its room before iOS has said its size: "Paste" in English.
    static let placeholder = CGSize(width: 68, height: 36)

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        let own = intrinsicContentSize
        return own.width > 0 && own.height > 0 ? own : Self.placeholder
    }

    override func invalidateIntrinsicContentSize() {
        super.invalidateIntrinsicContentSize()
        superview?.setNeedsLayout()
    }
}

/// Sign in with email, the second step: the 6-digit code sent to the
/// address, a field Mail's code fills (`.oneTimeCode`), checked as soon as
/// it has all six (`POST /v1/auth/email/verify`), then the servers as after
/// any sign-in. Resend code waits a minute after each code sent; Change
/// email goes back to the address.
///
/// iOS offers a code over the keyboard only from Messages and Apple Mail.
/// For one read anywhere else (Gmail's app, say):
///
/// - Paste, at the field's right end (`UIPasteControl`: no paste prompt,
///   and iOS dims it while the pasteboard holds no text), takes the code
///   out of whatever was copied (`EmailCode.find`) and checks it as typing
///   the sixth digit does; text without one says so under the field;
/// - Open Mail, and Open Gmail when Gmail is installed, in the row of
///   quiet links with Change email, open the mail app. Back in Happy the
///   step is as it was left, its field holding the keyboard.
///
/// Paste is always there and the links are decided before the step shows,
/// so nothing comes or goes on it: the row is one line whatever it holds
/// (`CloudLinksLayout`), where Change email alone was.
final class CloudEmailCodeViewController: CloudEmailStepViewController {
    static let length = EmailCode.length
    /// Between codes sent.
    static let resendInterval: TimeInterval = 60

    let email: String
    let change = RoundButton(title: Strings.CloudEmail.changeEmail, size: CloudLinksLayout.Metrics.size, display: .inverted)
    /// Paste, in the field. Its words and its dimming are iOS's own.
    let paste: PasteControl
    let pasteTarget = TextPasteTarget()
    /// Whether a mail app can be opened, and opening it; a test's own.
    var canOpen: (URL) -> Bool = { UIApplication.shared.canOpenURL($0) }
    var open: (URL) -> Void = { UIApplication.shared.open($0) }
    /// The mail apps here, each with its link, once the step has loaded.
    private(set) var mailLinks: [(app: MailApp, link: RoundButton)] = []
    /// When Resend code can be used: a minute after the last code sent, or
    /// when a `429` says.
    private(set) var resendAt: Date
    /// When Verify can be used again after a `429`.
    private(set) var verifyAt: Date?

    init(context: AppContext, email: String, http: any HTTPTransport, sentAt: Date) {
        self.email = email
        resendAt = sentAt.addingTimeInterval(Self.resendInterval)
        let configuration = UIPasteControl.Configuration()
        configuration.displayMode = .labelOnly
        configuration.cornerStyle = .capsule
        // A filled pill, as a row's Join is. iOS draws its own colours
        // instead when these don't contrast enough.
        configuration.baseForegroundColor = UIColor(Palette.roundButtonText)
        configuration.baseBackgroundColor = UIColor(Palette.roundButtonFill)
        paste = PasteControl(configuration: configuration)
        super.init(context: context, http: http, field: CloudField(prefix: nil, placeholder: Strings.CloudEmail.codePlaceholder),
                   title: Strings.CloudEmail.codeTitle, body: Strings.CloudEmail.codeMessage(email), primary: Strings.CloudEmail.verify,
                   secondary: Strings.CloudEmail.resend)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "cloud-email-code-step"
        primary.accessibilityIdentifier = "cloud-email-verify"
        secondary?.accessibilityIdentifier = "cloud-email-resend"
        field.text.accessibilityIdentifier = "cloud-email-code"
        field.text.accessibilityLabel = Strings.CloudEmail.codePlaceholder
        field.text.keyboardType = .numberPad
        field.text.textContentType = .oneTimeCode
        field.text.clearButtonMode = .never
        status.accessibilityIdentifier = "cloud-email-code-status"
        change.accessibilityIdentifier = "cloud-email-change"
        Self.quiet(change)
        change.onTap = { [weak self] in self?.navigationController?.popViewController(animated: true) }
        paste.accessibilityIdentifier = "cloud-email-paste"
        pasteTarget.onText = { [weak self] in self?.pasted($0) }
        paste.target = pasteTarget
        field.accessory = paste
        mailLinks = MailApp.allCases.filter { canOpen($0.url) }.map { app in
            let link = RoundButton(title: app.title, size: CloudLinksLayout.Metrics.size, display: .inverted)
            link.accessibilityIdentifier = app.identifier
            Self.quiet(link)
            link.onTap = { [weak self] in self?.open(app.url) }
            return (app, link)
        }
        for link in links { content.addSubview(link) }
        primary.action = { [weak self] in await self?.verify() }
        secondary?.action = { [weak self] in await self?.resend() }
        NotificationCenter.default.addObserver(self, selector: #selector(cameBack), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    /// The row of quiet links: the mail apps, then Change email.
    private var links: [RoundButton] { mailLinks.map(\.link) + [change] }

    /// Back in Happy (from the mail app, say): the step is as it was left,
    /// and its field has the keyboard again.
    @objc func cameBack() {
        guard viewIfLoaded?.window != nil, navigationController?.topViewController === self, presentedViewController == nil,
              !field.text.isFirstResponder else { return }
        field.text.becomeFirstResponder()
    }

    /// What Paste handed over: the code in it goes in the field and is
    /// checked as a typed one is; text without one says so and changes
    /// nothing.
    func pasted(_ text: String) {
        guard let code = EmailCode.find(in: text) else { return say(Strings.CloudEmail.nothingToPaste) }
        field.text.text = code
        edited()
    }

    var code: String { field.text.text ?? "" }

    @discardableResult
    override func update() -> Bool {
        let date = now()
        let verifyWait = verifyAt.map { $0.timeIntervalSince(date) } ?? 0
        let resendWait = resendAt.timeIntervalSince(date)
        primary.title = verifyWait > 0 ? Strings.CloudEmail.verify(in: verifyWait) : Strings.CloudEmail.verify
        primary.isEnabled = verifyWait <= 0 && code.count == Self.length
        secondary?.title = resendWait > 0 ? Strings.CloudEmail.resend(in: resendWait) : Strings.CloudEmail.resend
        secondary?.isEnabled = resendWait <= 0
        return verifyWait > 0 || resendWait > 0
    }

    /// Digits only, at most six (`123 456` pasted into the field or Mail's code alike);
    /// the sixth checks the code at once.
    override func edited() {
        let digits = String(code.filter { ("0"..."9").contains($0) }.prefix(Self.length))
        if digits != code { field.text.text = digits }
        if digits.count < Self.length, !status.string.isEmpty { say(nil) }
        update()
        if digits.count == Self.length, primary.isEnabled { primary.tapped() }
    }

    /// The primary button's action; it leaves `isLoading` to the button.
    func verify() async {
        let code = code
        guard code.count == Self.length else { return }
        say(nil)
        do {
            let account = try await CloudAccount.signIn(email: email, code: code, http: http)
            view.endEditing(true)
            CloudScreens.signedIn(account, context: context, from: self)
        } catch {
            say(Strings.CloudEmail.failure(error))
            if let ends = waitEnds(error) { verifyAt = ends } else { field.text.text = "" }
            tick()
        }
    }

    /// Resend code's action: another code to the same address, and a
    /// minute's wait again.
    func resend() async {
        do {
            try await CloudAccount.startEmailSignIn(email: email, http: http)
            resendAt = now().addingTimeInterval(Self.resendInterval)
            field.text.text = ""
            say(Strings.CloudEmail.resent, problem: false)
        } catch {
            say(Strings.CloudEmail.failure(error))
            if let ends = waitEnds(error) { resendAt = max(resendAt, ends) }
        }
        tick()
    }

    override func items(width: CGFloat, steady: Bool = false) -> [CloudColumnLayout.Item] {
        super.items(width: width, steady: steady) + [.init(height: CloudLinksLayout.Metrics.height, gap: 4)]
    }

    override func layoutContent() {
        super.layoutContent()
        let width = content.bounds.width
        let row = CloudColumnLayout.stack(items(width: width), width: width).frames[2]
        let labels = links.map { ceil($0.label.measurable.size(fitting: width).width) }
        for (link, frame) in zip(links, CloudLinksLayout(labels: labels, width: row.width, origin: row.origin).links) { link.setLayoutFrame(frame) }
    }
}
#endif
