#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// An invite link opened in the app. The invite is shown before anyone
/// signs in: the server it is for (`POST /v1/invites/preview`, which needs
/// no session), its picture, who invited the person, the role it gives and
/// when it ends. Then one tap takes it:
///
///     link ─ no token that could be one ──────────▶ refused(.invalid)   no request
///      ▼
///     loading ── 410 ──▶ refused                     one way out
///      │    └── network, 5xx ──▶ failed ── Try Again ──▶ loading
///      ▼ 200
///     offered ─ signed in:  Join            ─ tap ─▶ joining
///             └ signed out: Sign in to join ─ tap ─▶ the welcome, pushed over it
///     the welcome ── signed in ──▶ joining            a new invite screen in every sign-in
///                                                     step's place (`CloudScreens.signedIn`):
///                                                     the tap was the consent
///                 └─ Back ──▶ offered (signed out)
///     joining ── 200 ──▶ Connecting, or the server opens when it is here already
///             ├─ 403 email_mismatch ──▶ refused(.emailMismatch)
///             │        └ Sign in with another email ─▶ the account signed out ─▶ the welcome
///             ├─ 410 ──▶ refused
///             ├─ 401 ──▶ offered (signed out), saying the sign-in ended
///             └─ network, 5xx ──▶ failed ── Try Again ──▶ joining
///
/// Nothing is taken without a tap on Join or Sign in to join: opening a
/// link never joins, and what the preview names never stands in for the
/// tap (it is unauthenticated, and says nothing about the account). A
/// refused invite offers the account's servers (one already accepted,
/// perhaps by this account, is in that list), or Close while signed out.
/// Settings' Happy Cloud switch plays no part here.
///
/// Every state keeps one layout (`CloudInviteLayout`): the title only
/// changes its words (Invite unavailable for a refusal, Use your invited
/// email for another email's) and the line under it fades out for a
/// refusal but keeps its room, the server's and the inviter's places are
/// kept while there is nothing to show in them (a link glyph in the
/// server's when the invite can't say which), the status line keeps the room of the
/// longest it can say, and the one full-width button only changes its
/// words. A change cross-fades in place.
final class CloudInviteViewController: CloudStageViewController {
    enum Phase: Equatable {
        case loading
        case offered(CloudInvitePreview)
        case joining(CloudInvitePreview)
        case refused(CloudInviteError)
        case failed(String)
    }

    /// The invite; nil for a link without a token that could be one.
    private let invite: CloudInvite?
    /// Where the preview is asked, and the welcome's sign-ins go; the
    /// tests' fake accounts.
    var http: any HTTPTransport = CloudScreens.inviteHTTP
    let picture = UIImageView()
    let name = StyledLabel(style: TextStyle(.semiBold, size: 22, lineHeight: 28), color: Palette.startText, lines: 1, alignment: .center)
    let handle = StyledLabel(style: TextStyle(.regular, size: 15, lineHeight: 20), color: Palette.startTextSecondary, lines: 1, alignment: .center)
    let inviterPicture = UIImageView()
    let inviter = StyledLabel(style: TextStyle(.regular, size: 15, lineHeight: 20), color: Palette.startTextSecondary, lines: 1)
    let status = CloudStageViewController.bodyLabel("")
    private let spinner = UIActivityIndicatorView(style: .medium)
    /// Measures each line the status could say, for the room it keeps.
    private let measure = CloudStageViewController.bodyLabel("")
    private var statusRoom: (width: CGFloat, text: String, height: CGFloat)?
    /// The Connecting step after Join; a test's stand-in.
    var connecting: (CloudAccount, CloudServer) -> UIViewController
    /// What the invite offered, kept when Join is then refused or fails.
    private var offer: CloudInvitePreview?
    /// Join found the account's sign-in over: said in the role's place
    /// until the next tap.
    private var signInEnded = false
    private(set) var phase: Phase {
        didSet { if isViewLoaded { UIView.transition(with: scroll, duration: 0.2, options: .transitionCrossDissolve) { self.apply() } } }
    }

    /// `joining`: what the invite offered, for the screen that takes a
    /// sign-in's place after Sign in to join, which takes the invite at
    /// once and asks for no preview.
    init(context: AppContext, link: CloudInviteLink, joining offer: CloudInvitePreview? = nil) {
        switch link {
        case .invite(let invite):
            self.invite = invite
            self.offer = offer
            phase = offer.map { .joining($0) } ?? .loading
        case .invalid:
            invite = nil
            phase = .refused(.invalid)
        }
        connecting = { CloudConnectingViewController(context: context, account: $0, server: $1) }
        super.init(context: context, scene: nil, title: Strings.CloudConnect.inviteTitle, body: Strings.CloudConnect.inviteBody,
                   primary: Strings.CloudConnect.inviteJoin)
    }

    /// The account, while its session lasts.
    private var account: CloudAccount? { CloudScreens.account.flatMap { $0.isLive() ? $0 : nil } }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "cloud-invite"
        titleLabel.accessibilityIdentifier = "cloud-invite-title"
        primary.accessibilityIdentifier = "cloud-invite-join"
        status.accessibilityIdentifier = "cloud-invite-status"
        primary.onTap = { [weak self] in self?.primaryTapped() }
        for (view, side) in [(picture, CloudInviteLayout.Metrics.picture), (inviterPicture, CloudInviteLayout.Metrics.inviter)] {
            view.contentMode = .scaleAspectFill
            view.clipsToBounds = true
            view.layer.cornerRadius = side / 2
        }
        spinner.color = StartViewController.Colors.text
        for subview in [picture, spinner, name, handle, inviterPicture, inviter, status] as [UIView] { content.addSubview(subview) }
        apply()
        switch phase {
        case .loading: load()
        case .joining: join()
        default: break
        }
    }

    /// Coming back (Back from the welcome, say), the button says what the
    /// account is now.
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        apply()
    }

    /// Back on top for good (not an edge swipe let go of halfway): the
    /// sign-in it sent the person to is over, so nothing later joins on
    /// the strength of that tap.
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if let invite, CloudScreens.pendingJoin?.invite == invite { CloudScreens.pendingJoin = nil }
    }

    private func load() {
        guard let invite else { return }
        phase = .loading
        Task {
            do {
                let offer = try await CloudAccount.preview(invite, http: http)
                self.offer = offer
                phase = .offered(offer)
            } catch {
                settle(error)
            }
        }
    }

    private func primaryTapped() {
        signInEnded = false
        switch phase {
        case .offered:
            joinOrSignIn()
        case .refused(.emailMismatch):
            // Another account takes it: this one is signed out, and the
            // invite waits under the welcome as it was offered.
            CloudScreens.account = nil
            if let offer { phase = .offered(offer) }
            signIn()
        case .refused:
            guard let account, let navigation = navigationController else {
                context.account.cancelAddingAccount()
                return CloudScreens.finish(from: self, opened: false)
            }
            navigation.setViewControllers(Array(navigation.viewControllers.dropLast()) + [CloudServersViewController(context: context, account: account)], animated: true)
        case .failed:
            if offer == nil { load() } else { joinOrSignIn() }
        case .loading, .joining:
            break
        }
    }

    private func joinOrSignIn() {
        if account == nil { signIn() } else { join() }
    }

    /// Sign in to join: the welcome over the invite, which whoever signs
    /// in then takes (`CloudScreens.signedIn`). Back from it is the invite
    /// again, as offered.
    private func signIn() {
        guard let invite, let offer else { return }
        phase = .offered(offer)
        CloudScreens.pendingJoin = (invite, offer)
        let welcome = CloudWelcomeViewController(context: context)
        welcome.http = http
        navigationController?.pushViewController(welcome, animated: true)
    }

    /// Takes the invite (`POST /v1/invites/accept`), under the account.
    private func join() {
        guard let invite, let offer else { return }
        guard let account else {
            phase = .offered(offer)
            return
        }
        phase = .joining(offer)
        Task {
            do {
                let server = try await account.accept(invite)
                // Here already: it opens, and no second connection is made.
                if let id = CloudScreens.connection(to: server, context: context) {
                    return try await CloudScreens.open(id, context: context, from: self)
                }
                // Connecting in the invite's place, over the servers' list
                // where there is one, so Back never returns to it. The
                // account stays signed in when the flow ends over the
                // server, so the next invite link opens straight on Join.
                let list = navigationController?.viewControllers.last { $0 is CloudServersViewController }
                CloudScreens.replace(from: self, with: connecting(account, server), keeping: list)
            } catch {
                settle(error)
            }
        }
    }

    private func settle(_ error: any Error) {
        switch error {
        case CloudAccountError.signInRequired:
            // The account's sign-in ended on the way: the invite again,
            // signed out.
            CloudScreens.account = nil
            signInEnded = true
            if let offer { phase = .offered(offer) } else { phase = .failed(CloudScreens.problem(error)) }
        case let error as CloudInviteError: phase = .refused(error)
        default: phase = .failed(CloudScreens.problem(error))
        }
    }

    private func apply() {
        if case .loading = phase { spinner.startAnimating() } else { spinner.stopAnimating() }
        let side = CloudInviteLayout.Metrics.picture
        picture.image = offer.map { serverPicture($0.server) } ?? (phase == .loading ? AvatarPlaceholderImages.pending(side: side) : Self.linkGlyph)
        // A refusal's line would say the opposite; its room is kept.
        switch phase {
        case .refused(.emailMismatch):
            titleLabel.string = Strings.CloudConnect.inviteOtherEmail
            bodyLabel.alpha = 1
        case .refused:
            titleLabel.string = Strings.CloudConnect.inviteUnavailable
            bodyLabel.alpha = 0
        default:
            titleLabel.string = Strings.CloudConnect.inviteTitle
            bodyLabel.alpha = 1
        }
        name.string = offer?.server.title ?? ""
        handle.string = offer.map { HappyCloud.handle($0.server.name) } ?? ""
        // Nobody to name, nobody shown; their place is kept.
        let from = offer?.inviter.flatMap { inviter in inviter.name.flatMap { $0.isEmpty ? nil : (inviter, $0) } }
        inviterPicture.image = from.map { inviterPicture($0.0, name: $0.1) }
        inviterPicture.alpha = from == nil ? 0 : 1
        inviter.string = from.map { Strings.CloudConnect.invitedBy($0.1) } ?? ""
        let joins = account == nil ? Strings.CloudConnect.inviteSignIn : Strings.CloudConnect.inviteJoin
        var joining = false
        switch phase {
        case .loading, .offered, .joining:
            if signInEnded {
                status.string = Strings.CloudConnect.expired
                status.textColor = UIColor(Palette.textDestructive)
            } else {
                status.string = Self.terms(offer)
                status.textColor = UIColor(Palette.startTextSecondary)
            }
            primary.title = joins
            primary.isEnabled = phase != .loading
            if case .joining = phase { joining = true }
        case .refused(let error):
            status.string = Strings.CloudConnect.invite(error)
            status.textColor = UIColor(Palette.textDestructive)
            primary.title = if case .emailMismatch = error { Strings.CloudConnect.inviteOtherAccount }
                else if account == nil { Strings.CloudConnect.inviteClose } else { Strings.CloudConnect.inviteShowServers }
            primary.isEnabled = true
        case .failed(let text):
            status.string = text
            status.textColor = UIColor(Palette.textDestructive)
            primary.title = Strings.HappyCloud.tryAgain
            primary.isEnabled = true
        }
        // Whether a tap began the join or a sign-in did, the button shows it.
        primary.isLoading = joining
        relayout()
    }

    /// What the invite gives and until when, as one line.
    static func terms(_ offer: CloudInvitePreview?) -> String {
        guard let offer else { return "" }
        return [offer.roleName.map(Strings.CloudConnect.inviteRole), offer.expiresAt.map(Strings.CloudConnect.inviteExpires)]
            .compactMap { $0 }.joined(separator: " ")
    }

    /// Its picture from the preview's `data:` URL, else the placeholder
    /// its name picks, as the server list's.
    private func serverPicture(_ server: CloudInvitePreview.Server) -> UIImage {
        if let data = server.imageData, let image = UIImage(data: data) { return image }
        let side = CloudInviteLayout.Metrics.picture
        if let cached = AvatarPlaceholderImages.cached(seed: server.name, side: side) { return cached }
        Task { [weak self] in
            guard let image = await AvatarPlaceholderImages.image(seed: server.name, side: side), let self,
                  offer?.server.name == server.name else { return }
            picture.image = image
        }
        return AvatarPlaceholderImages.pending(side: side)
    }

    /// The server's place when the invite can't say which: a link in a
    /// white circle.
    static let linkGlyph: UIImage = {
        let side = CloudInviteLayout.Metrics.picture
        let symbol = UIImage(systemName: "link", withConfiguration: UIImage.SymbolConfiguration(pointSize: 32, weight: .medium))?
            .withTintColor(UIColor(Palette.startTextSecondary), renderingMode: .alwaysOriginal)
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { _ in
            UIColor.white.setFill()
            UIBezierPath(ovalIn: CGRect(x: 0, y: 0, width: side, height: side)).fill()
            if let symbol { symbol.draw(at: CGPoint(x: (side - symbol.size.width) / 2, y: (side - symbol.size.height) / 2)) }
        }
    }()

    /// Their picture, else their initials.
    private func inviterPicture(_ inviter: CloudInvitePreview.Inviter, name: String) -> UIImage {
        if let data = inviter.imageData, let image = UIImage(data: data) { return image }
        let side = CloudInviteLayout.Metrics.inviter
        let initials = String(name.split(separator: " ").prefix(2).compactMap(\.first)).uppercased()
        let font = UIFont(name: FontFace.semiBold.rawValue, size: 10) ?? .systemFont(ofSize: 10, weight: .semibold)
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { _ in
            UIColor(Palette.startTextSecondary).withAlphaComponent(0.25).setFill()
            UIBezierPath(ovalIn: CGRect(x: 0, y: 0, width: side, height: side)).fill()
            let text = NSAttributedString(string: initials, attributes: [.font: font, .foregroundColor: UIColor(Palette.startText)])
            let size = text.size()
            text.draw(at: CGPoint(x: (side - size.width) / 2, y: (side - size.height) / 2))
        }
    }

    /// The room of the longest line the status could say at `width`: the
    /// role, every refusal, and what it says now.
    private func statusHeight(width: CGFloat) -> CGFloat {
        if let room = statusRoom, room.width == width, room.text == status.string { return room.height }
        let lines = Strings.CloudConnect.inviteRefusals + [Strings.CloudConnect.inviteRole("Viewer"), Strings.CloudConnect.expired, status.string]
        let height = lines.map { text -> CGFloat in
            measure.string = text
            return ceil(measure.measurable.height(fitting: width))
        }.max() ?? 0
        statusRoom = (width, status.string, height)
        return height
    }

    private func layout(width: CGFloat) -> CloudInviteLayout {
        CloudInviteLayout(width: width, inviterLabel: ceil(inviter.measurable.size(fitting: width).width), status: statusHeight(width: width))
    }

    override func contentHeight(width: CGFloat) -> CGFloat { layout(width: width).height }

    override func layoutContent() {
        let layout = layout(width: content.bounds.width)
        picture.setLayoutFrame(layout.picture)
        spinner.setLayoutFrame(layout.picture)
        name.setLayoutFrame(layout.name)
        handle.setLayoutFrame(layout.handle)
        inviterPicture.setLayoutFrame(layout.inviterPicture)
        inviter.setLayoutFrame(layout.inviterLabel)
        status.setLayoutFrame(layout.status)
    }
}
#endif
