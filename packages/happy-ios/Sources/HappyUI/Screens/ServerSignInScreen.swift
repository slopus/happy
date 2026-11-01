#if canImport(UIKit)
import AuthenticationServices
import HappyCore
import HappyWire
import UIKit

/// Adds a team server by its HTTPS address, or signs one in again: the
/// server's own sign-in opens in the system browser
/// (`ASWebAuthenticationSession`), which returns to Happy's fixed redirect
/// URI (`OAuthRedirect`, docs/SERVER-SIGN-IN.md). A server being signed in
/// again is filled in and can't be changed. Nothing is kept until the server has accepted the sign-in.
final class ServerSignInViewController: UIViewController, UITextFieldDelegate, ASWebAuthenticationPresentationContextProviding {
    private let context: AppContext
    private let list = GroupedListView()
    private let form = ServerFormView()
    /// The server signed in to again, whose address can't be edited here.
    private let fixed: String?
    private var browser: ASWebAuthenticationSession?

    init(context: AppContext, server: String? = nil) {
        self.context = context
        fixed = server
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func loadView() { view = list }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = fixed != nil && context.account.agentConnections.accounts.contains(where: { $0.server == fixed }) ? Strings.ServerSignIn.signInAgain : Strings.ServerSignIn.title
        view.accessibilityIdentifier = "server-sign-in"
        list.sections = [ItemGroupView(footer: Strings.ServerSignIn.footer, rows: [form])]
        form.saveTitle = Strings.ServerSignIn.continueAction
        form.save.accessibilityIdentifier = "server-sign-in-continue"
        form.field.accessibilityIdentifier = "server-sign-in-url"
        form.field.text = fixed
        form.field.isEnabled = fixed == nil
        form.field.delegate = self
        form.field.addTarget(self, action: #selector(edited), for: .editingChanged)
        form.save.action = { [weak self] in await self?.signIn() }
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        Task { await signIn() }
        return true
    }

    @objc private func edited() { form.error = nil }

    private func signIn() async {
        guard !form.isValidating else { return }
        let address = form.field.text ?? ""
        guard !address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            form.error = Strings.Server.enterServerUrl
            return
        }
        form.field.resignFirstResponder()
        form.error = nil
        form.isValidating = true
        defer { form.isValidating = false; form.field.isEnabled = fixed == nil }
        do {
            let flow = try await ServerSignInFlow.start(address)
            let request = try flow.request(redirectUri: OAuthRedirect.uri)
            let callback = try await authenticate(request.url, scheme: OAuthRedirect.scheme)
            var signedIn = try await flow.complete(request, callback: callback)
            if signedIn.needsProfile {
                guard let name = await askName() else { throw OAuthError.cancelled }
                signedIn = try await flow.saveProfile(name, for: signedIn)
            }
            try await context.account.addServer(signedIn)
            // The window's root becomes the server's home; a sheet this
            // was shown in goes with the adding.
            if presentingViewController != nil, navigationController?.viewControllers.first === self { dismiss(animated: true) }
        } catch is CancellationError {
        } catch OAuthError.cancelled {
        } catch {
            form.error = Strings.ServerSignIn.failure(error)
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
