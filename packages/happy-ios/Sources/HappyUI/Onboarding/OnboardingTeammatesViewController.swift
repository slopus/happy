#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The teammates gate: inviting people by email (`POST /v0/invites`), one
/// address after another, each a row under the field once sent: Sent with
/// a check, or Share Link where its email didn't go out. A server that
/// can't send email (`email_not_configured`) makes a link instead, shared
/// from the share sheet. The first invite completes the gate, but the step
/// stays (`holds`) for more until Continue. A server without the route
/// sends the person to the web. Skip for Now while optional and nothing
/// is sent. The invites sent scroll under the title while the actions
/// stay put (`pinsActions`).
final class OnboardingTeammatesViewController: CloudStageViewController, UITextFieldDelegate, OnboardingStepScreen {
    private let session: Session
    private let web: URL?
    let emailField = CloudField(prefix: nil, placeholder: Strings.CloudOnboarding.emailPlaceholder)
    let status = StartGalleryView.bodyLabel("")
    /// Lets the flow go on to the next step (Continue).
    var released: (() -> Void)?
    private var letGo = false

    struct Sent {
        var email: String?
        var invite: TeamInvite
    }
    private(set) var sent: [Sent] = []
    private var rows: [CloudServerRow] = []
    /// No email from this server: links only.
    private var linksOnly = false
    /// No invite route on this server: the web.
    private var unsupported = false
    /// The status line says what went wrong, gone once the address changes.
    private var saysProblem = false

    init(context: AppContext, session: Session, handle: String, optional: Bool, web: URL?) {
        self.session = session
        self.web = web
        super.init(context: context, scene: .openHands, title: Strings.CloudOnboarding.teammatesTitle, body: Strings.CloudOnboarding.teammatesBody(handle),
                   primary: Strings.CloudOnboarding.sendInvite, secondary: optional ? Strings.CloudOnboarding.skip : nil)
        // However many are sent, Send Invite and Continue stay in place.
        pinsActions = true
    }

    var holds: Bool { !sent.isEmpty && !letGo }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "onboarding-teammates"
        primary.accessibilityIdentifier = "onboarding-primary"
        secondary?.accessibilityIdentifier = "onboarding-secondary"
        primary.action = { [weak self] in await self?.primaryTapped() }
        let field = emailField.text
        field.keyboardType = .emailAddress
        field.textContentType = .emailAddress
        field.returnKeyType = .send
        field.accessibilityIdentifier = "onboarding-invite-email"
        field.accessibilityLabel = Strings.CloudOnboarding.emailLabel
        field.delegate = self
        field.addTarget(self, action: #selector(edited), for: .editingChanged)
        for subview in [emailField, status] { content.addSubview(subview) }
        update()
    }

    /// The words come first; the keyboard waits for a tap on the field.
    override var typingField: UITextField? { nil }

    // MARK: Inviting

    private var email: String { (emailField.text.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }

    @objc func edited() {
        if saysProblem { say(nil) }
        update()
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        if primary.isEnabled, !email.isEmpty { primary.tapped() }
        return false
    }

    /// Send Invite with an address typed; Continue once one is sent and
    /// the field is empty; Share Invite Link without email; the web
    /// without the route.
    private func update() {
        typealias Text = Strings.CloudOnboarding
        emailField.isHidden = linksOnly || unsupported
        if unsupported {
            primary.title = Text.openWeb
            primary.isEnabled = web != nil
        } else if linksOnly {
            primary.title = sent.isEmpty ? Text.shareInviteLink : Strings.CloudConnect.continueAction
            primary.isEnabled = true
        } else if email.isEmpty, !sent.isEmpty {
            primary.title = Strings.CloudConnect.continueAction
            primary.isEnabled = true
        } else {
            primary.title = Text.sendInvite
            primary.isEnabled = EmailAddress.looksValid(email)
        }
        secondary?.isHidden = !sent.isEmpty
        relayout()
    }

    private func primaryTapped() async {
        if unsupported {
            if let web { await UIApplication.shared.open(web) }
        } else if linksOnly {
            if sent.isEmpty { await invite(email: nil) } else { release() }
        } else if email.isEmpty, !sent.isEmpty {
            release()
        } else {
            await invite(email: email)
        }
    }

    private func release() {
        letGo = true
        released?()
    }

    func invite(email: String?) async {
        say(nil)
        emailField.text.isEnabled = false
        secondary?.isEnabled = false
        defer { emailField.text.isEnabled = true; secondary?.isEnabled = true; update() }
        do {
            let invite = try await session.client.invite(email: email)
            add(Sent(email: email, invite: invite))
            if email == nil { share(invite, from: rows.last?.join) }
            else { emailField.text.text = "" }
            // The gate is done now; the step holds until Continue.
            _ = try? await session.readOnboarding()
        } catch TeamInviteRefusal.emailNotConfigured {
            linksOnly = true
            say(Strings.CloudOnboarding.noEmail, problem: false)
        } catch TeamInviteRefusal.unsupported {
            unsupported = true
            say(Strings.CloudOnboarding.invitesOnWeb, problem: false)
        } catch TeamInviteRefusal.refused(let message) {
            say(message ?? Strings.CloudOnboarding.inviteFailed)
        } catch {
            say(Strings.CloudOnboarding.inviteFailed)
        }
    }

    private func add(_ sent: Sent) {
        typealias Text = Strings.CloudOnboarding
        self.sent.append(sent)
        let row = CloudServerRow(action: Text.shareLink, done: Text.sent)
        let side = CloudServerRowLayout.Metrics.picture
        if let email = sent.email {
            row.title.string = email
            row.subtitle.string = sent.invite.emailFailed ? Text.emailFailed : Text.inviteSent
            row.state = sent.invite.emailFailed && sent.invite.link != nil ? .join : .joined
            row.picture.image = AvatarPlaceholderImages.cached(seed: email, side: side) ?? AvatarPlaceholderImages.pending(side: side)
            Task { [weak row] in
                guard let image = await AvatarPlaceholderImages.image(seed: email, side: side) else { return }
                row?.picture.image = image
            }
        } else {
            row.title.string = Text.inviteLink
            row.subtitle.string = Text.inviteLinkNote
            row.state = .join
            row.picture.image = Self.linkGlyph
        }
        row.joinLabel = "\(Text.shareLink) \(row.title.string)"
        row.join.accessibilityIdentifier = "onboarding-invite-share-\(rows.count)"
        row.join.onTap = { [weak self, weak row] in self?.share(sent.invite, from: row?.join) }
        content.addSubview(row)
        rows.append(row)
        relayout()
    }

    /// The invite's link in the share sheet.
    private func share(_ invite: TeamInvite, from source: UIView?) {
        guard let link = invite.link.flatMap(URL.init(string:)) else { return }
        let sheet = UIActivityViewController(activityItems: [link], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = source ?? primary
        present(sheet, animated: true)
    }

    private static let linkGlyph: UIImage? = {
        let side = CloudServerRowLayout.Metrics.picture
        let symbol = UIImage(systemName: "link", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold))?
            .withTintColor(UIColor(Palette.startText), renderingMode: .alwaysOriginal)
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { _ in
            UIColor(Palette.startDot).setFill()
            UIRectFill(CGRect(x: 0, y: 0, width: side, height: side))
            guard let symbol else { return }
            symbol.draw(at: CGPoint(x: (side - symbol.size.width) / 2, y: (side - symbol.size.height) / 2))
        }
    }()

    func say(_ problem: String?) { say(problem, problem: true) }

    private func say(_ text: String?, problem: Bool) {
        status.string = text ?? ""
        saysProblem = problem && text != nil
        status.textColor = UIColor(problem ? Palette.textDestructive : Palette.startTextSecondary)
        relayout()
    }

    // MARK: Layout

    /// The field, the invites sent under it, then the status line in room
    /// kept for it.
    private func items(width: CGFloat, steady: Bool = false) -> [CloudColumnLayout.Item] {
        let field = CloudColumnLayout.Item(height: emailField.isHidden ? 0 : CloudField.height)
        let sent = steady ? [] : rows.map { _ in CloudColumnLayout.Item(height: CloudServerRowLayout.Metrics.height, gap: 12) }
        return [field] + sent + [.init(height: steady ? Self.statusRoom : Self.statusHeight(status, width: width), gap: 12)]
    }

    override func contentHeight(width: CGFloat) -> CGFloat { CloudColumnLayout.stack(items(width: width), width: width).height }
    override func steadyContentHeight(width: CGFloat) -> CGFloat { CloudColumnLayout.stack(items(width: width, steady: true), width: width).height }

    override func layoutContent() {
        let frames = CloudColumnLayout.stack(items(width: content.bounds.width), width: content.bounds.width).frames
        emailField.setLayoutFrame(frames[0])
        for (index, row) in rows.enumerated() { row.setLayoutFrame(frames[index + 1]) }
        status.setLayoutFrame(frames[frames.count - 1])
    }
}
#endif
