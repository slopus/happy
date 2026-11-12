#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// An invite link opened in the app, once the account is signed in: the
/// server it is for (`POST /v1/invites/preview`) with the role it gives,
/// and Join, which takes it (`POST /v1/invites/accept`) and goes on to
/// Connecting, as Bootstrap does. An invite that can't be taken says why;
/// one for another email offers to sign in with another account, the
/// invite kept for after. One already accepted (perhaps by this account:
/// an email invite answers so even to the person who took it) offers the
/// server list instead.
final class CloudInviteViewController: CloudStageViewController {
    enum Phase: Equatable {
        case loading
        case offered(CloudInvitePreview)
        case refused(CloudInviteError)
        case failed(String)
    }

    private let account: CloudAccount
    private let invite: CloudInvite
    let row = CloudServerRow()
    private let spinner = UIActivityIndicatorView(style: .medium)
    /// The Connecting step after Join; a test's stand-in.
    var connecting: (CloudServer) -> UIViewController
    private(set) var phase: Phase = .loading {
        didSet { apply() }
    }

    init(context: AppContext, account: CloudAccount, invite: CloudInvite) {
        self.account = account
        self.invite = invite
        connecting = { CloudConnectingViewController(context: context, account: account, server: $0) }
        super.init(context: context, scene: nil, title: Strings.CloudConnect.inviteTitle, body: Strings.CloudConnect.inviteLoading,
                   primary: Strings.CloudConnect.inviteJoin)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "cloud-invite"
        primary.accessibilityIdentifier = "cloud-invite-join"
        primary.action = { [weak self] in await self?.primaryTapped() }
        row.state = .none
        spinner.color = StartViewController.Colors.text
        for subview in [row, spinner] as [UIView] { content.addSubview(subview) }
        apply()
        Task { await load() }
    }

    private func load() async {
        phase = .loading
        do {
            phase = .offered(try await account.preview(invite))
        } catch {
            settle(error)
        }
    }

    private func primaryTapped() async {
        switch phase {
        case .offered:
            do {
                let server = try await account.accept(invite)
                navigationController?.pushViewController(connecting(server), animated: true)
            } catch {
                settle(error)
            }
        case .refused(.emailMismatch):
            CloudScreens.pendingInvite = invite
            CloudScreens.signedOut(context: context, from: self)
        case .refused(.accepted):
            guard let navigation = navigationController else { return }
            navigation.setViewControllers(Array(navigation.viewControllers.dropLast()) + [CloudServersViewController(context: context, account: account)], animated: true)
        case .failed:
            await load()
        case .loading, .refused:
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
        guard isViewLoaded else { return }
        var body = Strings.CloudConnect.inviteLoading
        var problem = false
        row.isHidden = true
        primary.isHidden = false
        primary.isEnabled = true
        switch phase {
        case .loading:
            spinner.startAnimating()
            primary.isEnabled = false
        case .offered(let offer):
            spinner.stopAnimating()
            primary.title = Strings.CloudConnect.inviteJoin
            row.isHidden = false
            row.title.string = offer.server.title
            row.subtitle.string = HappyCloud.handle(offer.server.name)
            row.picture.image = picture(offer.server)
            body = Strings.CloudConnect.inviteMessage(HappyCloud.handle(offer.server.name), role: offer.roleName)
        case .refused(let error):
            spinner.stopAnimating()
            body = Strings.CloudConnect.invite(error)
            problem = true
            switch error {
            case .emailMismatch: primary.title = Strings.CloudConnect.inviteOtherAccount
            case .accepted: primary.title = Strings.CloudConnect.inviteShowServers
            case .invalid, .expired, .revoked, .exhausted: primary.isHidden = true
            }
        case .failed(let text):
            spinner.stopAnimating()
            body = text
            problem = true
            primary.title = Strings.HappyCloud.tryAgain
        }
        bodyLabel.string = body
        bodyLabel.textColor = UIColor(problem ? Palette.textDestructive : Palette.startTextSecondary)
        relayout()
    }

    /// Its picture from the preview's `data:` URL, else the placeholder
    /// its name picks, as the server list's.
    private func picture(_ server: CloudInvitePreview.Server) -> UIImage? {
        if let data = server.imageData, let image = UIImage(data: data) { return image }
        let side = CloudServerRowLayout.Metrics.picture
        if let cached = AvatarPlaceholderImages.cached(seed: server.name, side: side) { return cached }
        Task { [weak self] in
            let image = await AvatarPlaceholderImages.image(seed: server.name, side: side)
            self?.row.picture.image = image
        }
        return AvatarPlaceholderImages.pending(side: side)
    }

    private func items(width: CGFloat) -> [CloudColumnLayout.Item] {
        [
            .init(height: row.isHidden ? 0 : CloudServerRowLayout.Metrics.height),
            .init(size: CGSize(width: 44, height: spinner.isAnimating ? 44 : 0), gap: 0, centred: true),
        ]
    }

    override func contentHeight(width: CGFloat) -> CGFloat { CloudColumnLayout.stack(items(width: width), width: width).height }

    override func layoutContent() {
        let frames = CloudColumnLayout.stack(items(width: content.bounds.width), width: content.bounds.width).frames
        row.setLayoutFrame(frames[0])
        spinner.setLayoutFrame(frames[1])
    }
}
#endif
