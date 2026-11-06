#if canImport(UIKit)
import AuthenticationServices
import HappyCore
import HappyLayout
import UIKit

/// Happy Cloud's servers: the account signs in first (the system browser,
/// whose cookie on the accounts origin lets each server's sign-in finish
/// without a page), then the servers it belongs to, creating one and
/// joining one. Picking a server runs the team-server sign-in on it
/// (`ServerSignInViewController`); one connected already is switched to.
/// docs/SERVER-SIGN-IN.md, "Happy Cloud".
final class CloudServersViewController: UIViewController, ASWebAuthenticationPresentationContextProviding {
    private let context: AppContext
    private let keychain = CloudAccountKeychain(backend: SecurityKeychainBackend())
    private let list = GroupedListView()
    private var account: CloudAccount?
    private var servers: [CloudServer]?
    private var problem: String?
    private var browser: ASWebAuthenticationSession?
    private var signingIn = false
    /// Each server's picture once its bytes or placeholder are decoded.
    private var pictures: [String: UIImage] = [:]
    private var pictureRows: [String: ItemRowView] = [:]
    private var loadingPictures: Set<String> = []
    static let pictureSide = ItemRowLayout.Metrics.iconSize

    init(context: AppContext) {
        self.context = context
        account = CloudAccount.restore(keychain: keychain)
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func loadView() { view = list }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = HappyCloud.name
        view.accessibilityIdentifier = "cloud-servers"
        render()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if account == nil { Task { await signIn() } } else if servers == nil { Task { await reload() } }
    }

    /// The account's sign-in in the system browser, then its servers.
    private func signIn() async {
        guard !signingIn else { return }
        signingIn = true
        defer { signingIn = false }
        problem = nil
        render()
        do {
            let request = try CloudAccount.request()
            let callback = try await authenticate(request.url)
            account = try await CloudAccount.signIn(request, callback: callback, keychain: keychain)
            await reload()
        } catch OAuthError.cancelled {
            render()
        } catch {
            problem = Strings.ServerSignIn.failure(error)
            render()
        }
    }

    private func reload() async {
        guard let account else { return }
        do {
            servers = try await account.servers()
            problem = nil
        } catch CloudAccountError.signInRequired {
            await account.signOut()
            self.account = nil
            servers = nil
            await signIn()
            return
        } catch {
            problem = Strings.HappyCloud.failure(error)
        }
        render()
    }

    private func render() {
        guard account != nil else {
            let again = ItemRowView(title: Strings.HappyCloud.signIn, icon: ItemIcon("person.crop.circle", tint: Palette.textLink)) { [weak self] in
                Task { await self?.signIn() }
            }
            again.accessibilityIdentifier = "cloud-sign-in"
            list.sections = [ItemGroupView(footer: problem ?? Strings.ServerSignIn.cloudMessage, rows: [again])]
            return
        }
        let connected = Set(context.account.agentConnections.accounts.compactMap(\.server))
        let rows: [UIView] = (servers ?? []).compactMap { server in
            guard let origin = server.origin else { return nil }
            let row = ItemRowView(title: server.title, subtitle: "\(server.name).\(HappyCloud.base)",
                                  detail: connected.contains(origin) ? Strings.HappyCloud.connected : server.role == .owner ? Strings.HappyCloud.owner : nil,
                                  icon: picture(server)) { [weak self] in
                self?.connect(origin)
            }
            row.accessibilityIdentifier = "cloud-server-\(server.name)"
            pictureRows[server.id] = row
            return row
        }
        let create = ItemRowView(title: Strings.HappyCloud.create, icon: ItemIcon("plus", tint: Palette.textLink)) { [weak self] in
            guard let self, let account else { return }
            navigationController?.pushViewController(CloudServerNameViewController(context: context, account: account), animated: true)
        }
        create.accessibilityIdentifier = "cloud-create"
        let join = ItemRowView(title: Strings.HappyCloud.join, icon: ItemIcon("person.badge.plus", tint: Palette.textLink)) { [weak self] in
            Task { await self?.join() }
        }
        join.accessibilityIdentifier = "cloud-join"
        var sections: [UIView] = []
        if servers == nil, problem == nil {
            let loading = ItemRowView(title: Strings.HappyCloud.yourServers)
            loading.isLoading = true
            sections.append(ItemGroupView(rows: [loading]))
        } else if !rows.isEmpty || problem != nil {
            sections.append(ItemGroupView(title: Strings.HappyCloud.yourServers, footer: problem, rows: rows))
        }
        sections.append(ItemGroupView(footer: Strings.HappyCloud.footer, rows: [create, join]))
        list.sections = sections
    }

    /// What a server's row shows now: its picture, else its ThumbHash, else
    /// the generated avatar once decoded; the rest is fetched once.
    private func picture(_ server: CloudServer) -> ItemIcon {
        load(server)
        let image = pictures[server.id] ?? ThumbHashImages.image(server.image?.thumbhash)
            ?? AvatarPlaceholderImages.cached(seed: server.id, side: Self.pictureSide) ?? AvatarPlaceholderImages.pending(side: Self.pictureSide)
        var icon = ItemIcon(.image(image), round: true)
        icon.size = Self.pictureSide
        return icon
    }

    private func load(_ server: CloudServer) {
        guard pictures[server.id] == nil, !loadingPictures.contains(server.id), let account else { return }
        loadingPictures.insert(server.id)
        Task { [weak self] in
            var image: UIImage?
            if let picture = server.image, let data = try? await account.image(picture) {
                image = await Task.detached { AccountPictureImages.decode(data)?.picture as? UIImage }.value
            }
            if image == nil { image = await AvatarPlaceholderImages.image(seed: server.id, side: Self.pictureSide) }
            guard let self else { return }
            loadingPictures.remove(server.id)
            guard let image else { return }
            pictures[server.id] = image
            var icon = ItemIcon(.image(image), round: true)
            icon.size = Self.pictureSide
            pictureRows[server.id]?.icon = icon
        }
    }

    /// A server: the one here already comes forward; otherwise its sign-in,
    /// which the account's browser session finishes without a page.
    private func connect(_ origin: String) {
        let account = context.account
        if let existing = HappyCloud.connection(to: origin, in: account.agentConnections.accounts), !existing.revoked {
            Task { [weak self] in
                if !account.showsAgentConnections { await account.setShowsAgentConnections(true) }
                do {
                    try await account.switchAccount(to: existing.id)
                    self?.close()
                } catch {
                    guard let self else { return }
                    Alerts.show(Strings.Common.error, Strings.AccountSwitcher.switchFailed, on: self)
                }
            }
            return
        }
        navigationController?.pushViewController(ServerSignInViewController(context: context, server: origin, installation: .recorded, startsAtOnce: true), animated: true)
    }

    private func close() {
        if navigationController?.presentingViewController != nil { dismiss(animated: true) }
        else { navigationController?.popToRootViewController(animated: true) }
    }

    /// A server's name and the invite code its owner gave.
    private func join() async {
        guard let account else { return }
        let answer: (String, String)? = await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: Strings.HappyCloud.join, message: Strings.HappyCloud.joinMessage, preferredStyle: .alert)
            alert.addTextField { field in
                field.placeholder = Strings.HappyCloud.namePlaceholder
                field.autocapitalizationType = .none
                field.autocorrectionType = .no
                field.accessibilityIdentifier = "cloud-join-name"
            }
            alert.addTextField { field in
                field.placeholder = Strings.HappyCloud.codePlaceholder
                field.autocapitalizationType = .none
                field.autocorrectionType = .no
                field.accessibilityIdentifier = "cloud-join-code"
            }
            alert.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel) { _ in continuation.resume(returning: nil) })
            alert.addAction(UIAlertAction(title: Strings.HappyCloud.joinAction, style: .default) { [weak alert] _ in
                let fields = alert?.textFields?.map { ($0.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines) } ?? []
                guard fields.count == 2, !fields[0].isEmpty, !fields[1].isEmpty else { return continuation.resume(returning: nil) }
                continuation.resume(returning: (fields[0].lowercased(), fields[1]))
            })
            present(alert, animated: true)
        }
        guard let (name, code) = answer else { return }
        do {
            let server = try await account.join(name, code: code)
            await reload()
            if let origin = server.origin { connect(origin) }
        } catch {
            Alerts.show(Strings.HappyCloud.joinFailedTitle, Strings.HappyCloud.failure(error), on: self)
        }
    }

    private func authenticate(_ url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callback: .customScheme(OAuthRedirect.scheme)) { callback, error in
                if let callback { continuation.resume(returning: callback) }
                else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin { continuation.resume(throwing: OAuthError.cancelled) }
                else { continuation.resume(throwing: error ?? OAuthError.invalidResponse) }
            }
            // The account's session cookie stays for each server's sign-in.
            session.prefersEphemeralWebBrowserSession = false
            session.presentationContextProvider = self
            browser = session
            if !session.start() { continuation.resume(throwing: OAuthError.invalidResponse) }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        view.window ?? UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first!
    }
}

/// A new server's name, under the app's base, checked as it is typed, then
/// made with the person as its owner and connected to.
final class CloudServerNameViewController: UIViewController, UITextFieldDelegate {
    private let context: AppContext
    private let account: CloudAccount
    private let list = GroupedListView()
    private let form = ServerFormView()
    private var checking: Task<Void, Never>?

    init(context: AppContext, account: CloudAccount) {
        self.context = context
        self.account = account
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func loadView() { view = list }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = Strings.HappyCloud.create
        view.accessibilityIdentifier = "cloud-create-server"
        list.sections = [ItemGroupView(footer: Strings.HappyCloud.nameFooter, rows: [form])]
        form.saveTitle = Strings.HappyCloud.createAction
        form.save.accessibilityIdentifier = "cloud-create-save"
        form.field.accessibilityIdentifier = "cloud-create-name"
        form.field.placeholder = Strings.HappyCloud.namePlaceholder
        form.field.autocapitalizationType = .none
        form.field.autocorrectionType = .no
        form.field.keyboardType = .asciiCapable
        let suffix = UILabel()
        suffix.text = ".\(HappyCloud.base)"
        suffix.textColor = UIColor(Palette.textSecondary)
        suffix.font = form.field.font
        suffix.sizeToFit()
        form.field.rightView = suffix
        form.field.rightViewMode = .always
        form.field.delegate = self
        form.field.addTarget(self, action: #selector(edited), for: .editingChanged)
        form.save.action = { [weak self] in await self?.create() }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        form.field.becomeFirstResponder()
    }

    private var name: String { (form.field.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

    /// Asks whether the name is free once typing pauses.
    @objc private func edited() {
        checking?.cancel()
        form.error = nil
        let name = name
        guard !name.isEmpty else { return }
        guard HappyCloud.isValidName(name) else { form.error = Strings.HappyCloud.invalidName; return }
        checking = Task { [weak self, account] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            let answer = try? await account.availability(name)
            guard !Task.isCancelled, let self, self.name == name else { return }
            form.error = answer.flatMap(Strings.HappyCloud.unavailable)
        }
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        Task { await create() }
        return false
    }

    private func create() async {
        let name = name
        guard HappyCloud.isValidName(name), !form.isValidating else { form.error = Strings.HappyCloud.invalidName; return }
        form.isValidating = true
        defer { form.isValidating = false }
        do {
            let server = try await account.create(name)
            guard let origin = server.origin else { throw CloudAccountError.invalidResponse }
            navigationController?.pushViewController(ServerSignInViewController(context: context, server: origin, installation: .recorded, startsAtOnce: true), animated: true)
        } catch CloudAccountError.refused(_, let code, _) where code == "taken" {
            form.error = Strings.HappyCloud.unavailable(.taken)
        } catch {
            form.error = Strings.HappyCloud.failure(error)
        }
    }
}
#endif
