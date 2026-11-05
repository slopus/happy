#if canImport(UIKit)
import AuthenticationServices
import HappyCore
import HappyWire
import UIKit

/// Signs in to a team server: one Happy Desktop's code named, or one here
/// already whose sign-in ended. The address is shown, never typed. The
/// server's own sign-in opens in the system browser
/// (`ASWebAuthenticationSession`), which returns to Happy's fixed redirect
/// URI (`OAuthRedirect`, docs/SERVER-SIGN-IN.md). How the server signs in is
/// read as the screen opens, and the host the person will sign in at shows
/// beside the server's before anything opens; that method is the one used.
/// Nothing is kept until the server has accepted the sign-in and, when the
/// installation is known, proved to be it.
final class ServerSignInViewController: UIViewController, ASWebAuthenticationPresentationContextProviding {
    private let context: AppContext
    private let list = GroupedListView()
    private let form = ServerFormView()
    private let server: String
    /// The installation the server must report (health `instanceId`).
    private let instanceId: String?
    private var browser: ASWebAuthenticationSession?
    /// Discovery, started as the screen opens; a failed one starts again on
    /// Continue.
    private var discovering: Task<ServerSignInFlow, any Error>?
    private let serverRow = ItemRowView(title: Strings.ServerSignIn.server)
    private let authorizationRow = ItemRowView(title: Strings.ServerSignIn.signsInAt)

    init(context: AppContext, server: String, instanceId: String?) {
        self.context = context
        self.server = server
        self.instanceId = instanceId
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func loadView() { view = list }

    override func viewDidLoad() {
        super.viewDidLoad()
        let again = context.account.agentConnections.accounts.contains { $0.server == server }
        title = again ? Strings.ServerSignIn.signInAgain : Strings.ServerSignIn.title
        view.accessibilityIdentifier = "server-sign-in"
        list.sections = [ItemGroupView(footer: Strings.ServerSignIn.footer, rows: [form])]
        serverRow.detail = URLComponents(string: server).map { ($0.host ?? server) + ($0.port.map { ":\($0)" } ?? "") }
        serverRow.accessibilityIdentifier = "server-sign-in-host"
        authorizationRow.accessibilityIdentifier = "server-sign-in-authorization-host"
        form.saveTitle = Strings.ServerSignIn.continueAction
        form.save.accessibilityIdentifier = "server-sign-in-continue"
        // Shown, not edited: the code or the account named it.
        form.field.accessibilityIdentifier = "server-sign-in-url"
        form.field.text = server
        form.field.isEnabled = false
        form.save.action = { [weak self] in await self?.signIn() }
        _ = discover()
    }

    /// How the server signs in, once: the method shown is the method used.
    private func discover() -> Task<ServerSignInFlow, any Error> {
        if let discovering { return discovering }
        let task = Task { [server] in try await ServerSignInFlow.start(server) }
        discovering = task
        Task { [weak self] in
            do {
                let flow = try await task.value
                self?.show(flow)
            } catch {
                guard let self, discovering == task else { return }
                discovering = nil
                if !(error is CancellationError), !form.isValidating { form.error = Strings.ServerSignIn.failure(error) }
            }
        }
        return task
    }

    /// The server's host, and beside it the host the browser will open.
    private func show(_ flow: ServerSignInFlow) {
        authorizationRow.detail = flow.method.authorizationHost
        list.sections = [ItemGroupView(footer: Strings.ServerSignIn.footer, rows: [form]), ItemGroupView(rows: [serverRow, authorizationRow])]
    }

    private func signIn() async {
        guard !form.isValidating else { return }
        form.error = nil
        form.isValidating = true
        defer { form.isValidating = false }
        do {
            let flow = try await discover().value
            let request = try flow.request(redirectUri: OAuthRedirect.uri)
            let callback = try await authenticate(request.url, scheme: OAuthRedirect.scheme)
            var signedIn = try await flow.complete(request, callback: callback, instanceId: instanceId)
            if signedIn.needsProfile {
                guard let name = await askName() else { throw OAuthError.cancelled }
                signedIn = try await flow.saveProfile(name, for: signedIn)
            }
            try await context.account.addServer(signedIn)
            Analytics.shared.log(.signInResult(method: .teamServer, result: .ok, errorCode: nil))
            // The window's root becomes the server's home; a sheet this
            // was shown in goes with the adding.
            if presentingViewController != nil, navigationController?.viewControllers.first === self { dismiss(animated: true) }
        } catch is CancellationError {
        } catch OAuthError.cancelled {
            Analytics.shared.log(.signInResult(method: .teamServer, result: .cancelled, errorCode: nil))
        } catch {
            form.error = Strings.ServerSignIn.failure(error)
            Analytics.shared.log(.signInResult(method: .teamServer, result: .failed, errorCode: .init(error)))
        }
    }

    /// The system browser, until it comes back to the redirect URI.
    private func authenticate(_ url: URL, scheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callback: .customScheme(scheme)) { callback, error in
                if let callback { continuation.resume(returning: callback) }
                else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin { continuation.resume(throwing: OAuthError.cancelled) }
                else { continuation.resume(throwing: error ?? OAuthError.invalidResponse) }
            }
            // Keeps the organization's single sign-on session for the
            // next sign-in, as any app signing in through Safari does.
            session.prefersEphemeralWebBrowserSession = false
            session.presentationContextProvider = self
            browser = session
            if !session.start() { continuation.resume(throwing: OAuthError.invalidResponse) }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        view.window ?? UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first!
    }

    /// The person's name, for a server meeting them for the first time.
    private func askName() async -> String? {
        await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: Strings.ServerSignIn.nameTitle, message: Strings.ServerSignIn.nameMessage, preferredStyle: .alert)
            alert.addTextField { field in
                field.placeholder = Strings.ServerSignIn.namePlaceholder
                field.textContentType = .name
                field.autocapitalizationType = .words
            }
            alert.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel) { _ in continuation.resume(returning: nil) })
            alert.addAction(UIAlertAction(title: Strings.ServerSignIn.continueAction, style: .default) { [weak alert] _ in
                let name = alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                continuation.resume(returning: name.isEmpty ? nil : name)
            })
            present(alert, animated: true)
        }
    }
}
#endif
