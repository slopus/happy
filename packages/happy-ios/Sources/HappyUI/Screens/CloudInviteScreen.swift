#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// An invite link opened in the app, once the account is signed in: the
/// server it is for (`POST /v1/invites/preview`), its picture, who invited
/// the person and the role it gives, and Join, which takes it
/// (`POST /v1/invites/accept`) and goes on to Connecting, as Bootstrap does,
/// or opens the server when it is already on this phone.
/// An invite that can't be taken says why; one for another email offers to
/// sign in with another account, the invite kept for after; one already
/// accepted (perhaps by this account: an email invite answers so even to
/// the person who took it) offers the server list.
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
        case refused(CloudInviteError)
        case failed(String)
    }

    private let account: CloudAccount
    private let invite: CloudInvite
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
    var connecting: (CloudServer) -> UIViewController
    /// What the invite offered, kept when Join is then refused.
    private var offer: CloudInvitePreview?
    private(set) var phase: Phase = .loading {
        didSet { if isViewLoaded { UIView.transition(with: scroll, duration: 0.2, options: .transitionCrossDissolve) { self.apply() } } }
    }

    init(context: AppContext, account: CloudAccount, invite: CloudInvite) {
        self.account = account
        self.invite = invite
        connecting = { CloudConnectingViewController(context: context, account: account, server: $0) }
        super.init(context: context, scene: nil, title: Strings.CloudConnect.inviteTitle, body: Strings.CloudConnect.inviteBody,
                   primary: Strings.CloudConnect.inviteJoin)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "cloud-invite"
        titleLabel.accessibilityIdentifier = "cloud-invite-title"
        primary.accessibilityIdentifier = "cloud-invite-join"
        status.accessibilityIdentifier = "cloud-invite-status"
        primary.action = { [weak self] in await self?.primaryTapped() }
        for (view, side) in [(picture, CloudInviteLayout.Metrics.picture), (inviterPicture, CloudInviteLayout.Metrics.inviter)] {
            view.contentMode = .scaleAspectFill
            view.clipsToBounds = true
            view.layer.cornerRadius = side / 2
        }
        spinner.color = StartViewController.Colors.text
        for subview in [picture, spinner, name, handle, inviterPicture, inviter, status] as [UIView] { content.addSubview(subview) }
        apply()
        Task { await load() }
    }

    private func load() async {
        phase = .loading
        do {
            let offer = try await account.preview(invite)
            self.offer = offer
            phase = .offered(offer)
        } catch {
            settle(error)
        }
    }

    private func primaryTapped() async {
        switch phase {
        case .offered:
            do {
                let server = try await account.accept(invite)
                if let id = CloudScreens.connection(to: server, context: context) {
                    return try await CloudScreens.open(id, context: context, from: self)
                }
                // Connecting in the invite's place, over the servers' list
                // where there is one, so Back never returns to it. The
                // account stays signed in when the flow ends over the
                // server, so the next invite link opens straight on Join.
                let list = navigationController?.viewControllers.last { $0 is CloudServersViewController }
                CloudScreens.replace(from: self, with: connecting(server), keeping: list)
            } catch {
                settle(error)
            }
        case .refused(.emailMismatch):
            CloudScreens.pendingInvite = invite
            CloudScreens.signedOut(context: context, from: self)
        case .refused:
            guard let navigation = navigationController else { return }
            navigation.setViewControllers(Array(navigation.viewControllers.dropLast()) + [CloudServersViewController(context: context, account: account)], animated: true)
        case .failed:
            await load()
        case .loading:
            break
        }
    }

    private func settle(_ error: any Error) {
        switch error {
        case CloudAccountError.signInRequired:
            CloudScreens.pendingInvite = invite
            CloudScreens.signedOut(context: context, from: self)
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
        switch phase {
        case .loading, .offered:
            status.string = offer?.roleName.map(Strings.CloudConnect.inviteRole) ?? ""
            status.textColor = UIColor(Palette.startTextSecondary)
            primary.title = Strings.CloudConnect.inviteJoin
            primary.isEnabled = phase != .loading
        case .refused(let error):
            status.string = Strings.CloudConnect.invite(error)
            status.textColor = UIColor(Palette.textDestructive)
            primary.title = if case .emailMismatch = error { Strings.CloudConnect.inviteOtherAccount } else { Strings.CloudConnect.inviteShowServers }
            primary.isEnabled = true
        case .failed(let text):
            status.string = text
            status.textColor = UIColor(Palette.textDestructive)
            primary.title = Strings.HappyCloud.tryAgain
            primary.isEnabled = true
        }
        relayout()
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
        let lines = Strings.CloudConnect.inviteRefusals + [Strings.CloudConnect.inviteRole("Viewer"), status.string]
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
