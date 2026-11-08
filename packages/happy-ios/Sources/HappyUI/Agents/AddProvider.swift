#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Adding one provider to `destination` (ONBOARDING-API §2–5). A key or a
/// setup token is typed into a secure field, sent once, and kept nowhere
/// here; a sign-in is the server's, and the phone only shows its code and
/// page and follows it to the end.
@MainActor
struct ProviderFlows {
    let client: AgentClient
    let destination: CloudProvider.Destination
    weak var host: UIViewController?
    /// The list, read again once something was added.
    let added: () -> Void

    init(client: AgentClient, destination: CloudProvider.Destination, host: UIViewController, added: @escaping () -> Void) {
        self.client = client; self.destination = destination; self.host = host; self.added = added
    }

    /// An API key for `vendor` (`openai`, `anthropic`).
    func addKey(vendor: String) {
        let name = vendor == "anthropic" ? Strings.Providers.anthropic : Strings.Providers.openAI
        ask(title: Strings.Providers.addAPIKey, message: name, placeholder: Strings.Providers.apiKey) { secret in
            store(vendor: vendor, kind: "api_key", secret: secret, done: Strings.Providers.keyAdded) { addKey(vendor: vendor) }
        }
    }

    /// Claude's setup token, from `claude setup-token`.
    func addSetupToken(then finished: @escaping () -> Void = {}) {
        ask(title: Strings.Providers.setupToken, message: Strings.Providers.setupTokenHint, placeholder: Strings.Providers.setupToken) { secret in
            store(vendor: "claude-code", kind: "oauth_token", secret: secret, done: Strings.Providers.claudeConnected) { addSetupToken(then: finished) }
            finished()
        }
    }

    private func ask(title: String, message: String, placeholder: String, then: @escaping (String) -> Void) {
        guard let host else { return }
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addTextField { field in
            field.placeholder = placeholder
            field.isSecureTextEntry = true
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
            field.spellCheckingType = .no
            field.textContentType = .password
            field.accessibilityIdentifier = "provider-secret"
        }
        alert.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel))
        alert.addAction(UIAlertAction(title: Strings.Providers.connect, style: .default) { [weak alert] _ in
            let secret = (alert?.textFields?.first?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !secret.isEmpty else { return }
            then(secret)
        })
        host.present(alert, animated: true)
    }

    private func store(vendor: String, kind: String, secret: String, done: String, again: @escaping () -> Void) {
        guard let host else { return }
        let checking = UIAlertController(title: Strings.Providers.checking, message: nil, preferredStyle: .alert)
        host.present(checking, animated: true)
        let container = destination.container(vendor: vendor)
        Task { @MainActor in
            let result: Result<Void, any Error>
            do { try await client.addCloudCredential(container: container, vendor: vendor, kind: kind, secret: secret); result = .success(()) }
            catch { result = .failure(error) }
            checking.dismiss(animated: true) {
                switch result {
                case .success:
                    added()
                    Alerts.show(done, nil, on: host)
                case .failure(let error):
                    let alert = UIAlertController(title: Strings.Providers.couldNotAddKey, message: Self.words(error), preferredStyle: .alert)
                    alert.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel))
                    alert.addAction(UIAlertAction(title: Strings.Providers.tryAgain, style: .default) { _ in again() })
                    host.present(alert, animated: true)
                }
            }
        }
    }

    static func words(_ error: any Error) -> String {
        switch error {
        case let refusal as CloudCredentialRefusal: refusal.message
        case AgentClientError.status(_, _, let message?): message
        default: error.localizedDescription
        }
    }
}

/// The pieces both sign-in screens are made of: a column of text and
/// buttons, read top to bottom.
@MainActor
class ProviderSignInViewController: UIViewController {
    let flows: ProviderFlows
    let stack = UIStackView()
    let status = UILabel()
    let spinner = UIActivityIndicatorView(style: .medium)
    var follow: Task<Void, Never>?

    init(flows: ProviderFlows, title: String) {
        self.flows = flows
        super.init(nibName: nil, bundle: nil)
        self.title = title
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    deinit { follow?.cancel() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.settingsGround)
        navigationItem.largeTitleDisplayMode = .never
        stack.axis = .vertical
        stack.spacing = 18
        stack.alignment = .fill
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 32),
            stack.leadingAnchor.constraint(equalTo: view.readableContentGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.readableContentGuide.trailingAnchor),
        ])
        status.font = .preferredFont(forTextStyle: .footnote)
        status.textColor = .secondaryLabel
        status.textAlignment = .center
        status.numberOfLines = 0
        spinner.hidesWhenStopped = true
    }

    func label(_ text: String, style: UIFont.TextStyle = .body, mono: Bool = false) -> UILabel {
        let label = UILabel()
        label.text = text
        label.numberOfLines = 0
        label.textAlignment = .center
        label.adjustsFontForContentSizeCategory = true
        label.font = mono ? .monospacedSystemFont(ofSize: 34, weight: .semibold) : .preferredFont(forTextStyle: style)
        return label
    }

    func button(_ title: String, prominent: Bool = false, id: String, action: @escaping () -> Void) -> UIButton {
        let button = UIButton(configuration: prominent ? .prominentGlass() : .glass())
        button.configuration?.title = title
        button.accessibilityIdentifier = id
        button.addAction(UIAction { _ in action() }, for: .touchUpInside)
        return button
    }

    /// Opens the vendor's page in Safari: the person may already be signed
    /// in there, and the code works on any device.
    func openPage(_ url: URL?) {
        guard let url else { return }
        UIApplication.shared.open(url)
    }

    /// The sign-in's end: the list is read again and the screen goes back to
    /// it, or the server's words for what went wrong, with a way to start over.
    func finished(_ signIn: CloudSignIn, success: String, restart: @escaping () -> Void) {
        spinner.stopAnimating()
        switch signIn.status {
        case .succeeded:
            flows.added()
            status.text = success
            if let navigation = navigationController {
                navigation.popViewController(animated: true)
                if let top = navigation.topViewController { Alerts.show(success, nil, on: top) }
            }
        case .cancelled:
            navigationController?.popViewController(animated: true)
        default:
            status.text = signIn.failureText
            let alert = UIAlertController(title: signIn.errorCode == "expired" ? Strings.Providers.codeExpired : Strings.Providers.signInFailed,
                                          message: signIn.failureText, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel) { [weak self] _ in self?.navigationController?.popViewController(animated: true) })
            alert.addAction(UIAlertAction(title: Strings.Providers.tryAgain, style: .default) { _ in restart() })
            present(alert, animated: true)
        }
    }

    func failedToStart(_ error: any Error) {
        spinner.stopAnimating()
        let message = AgentClient.unavailable(error) ? Strings.Providers.notAvailable : ProviderFlows.words(error)
        status.text = message
        let alert = UIAlertController(title: Strings.Providers.signInFailed, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Common.ok, style: .default) { [weak self] _ in self?.navigationController?.popViewController(animated: true) })
        present(alert, animated: true)
    }
}

/// ChatGPT's device sign-in (§4): the code to type at OpenAI, a way to
/// copy it and open the page, and the server's word when it is done.
final class DeviceSignInViewController: ProviderSignInViewController {
    private let code = UILabel()
    private var signIn: CloudSignIn?
    private var copy: UIButton?
    private var open: UIButton?

    init(flows: ProviderFlows) {
        super.init(flows: flows, title: Strings.Providers.signInChatGPT)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "provider-device"
        code.font = .monospacedSystemFont(ofSize: 34, weight: .semibold)
        code.textAlignment = .center
        code.text = "····-····"
        code.accessibilityIdentifier = "provider-device-code"
        let copy = button(Strings.Providers.copy, id: "provider-device-copy") { [weak self] in self?.copyCode() }
        let open = button(Strings.Providers.openOpenAI, prominent: true, id: "provider-device-open") { [weak self] in self?.openPage(self?.signIn?.url) }
        let cancel = button(Strings.Common.cancel, id: "provider-device-cancel") { [weak self] in self?.cancel() }
        self.copy = copy; self.open = open
        copy.isEnabled = false; open.isEnabled = false
        let waiting = UIStackView(arrangedSubviews: [spinner, status])
        waiting.axis = .vertical
        waiting.spacing = 8
        for view in [label(Strings.Providers.deviceInstructions, style: .headline), code, copy, open, waiting, cancel] as [UIView] { stack.addArrangedSubview(view) }
        start()
    }

    private func start() {
        status.text = nil
        spinner.startAnimating()
        follow?.cancel()
        let client = flows.client, container = flows.destination.container(vendor: "codex")
        follow = Task { @MainActor [weak self] in
            do {
                let started = try await client.startCloudSignIn(.codex, container: container)
                self?.show(started)
                // The code comes a moment after the start, from the server's
                // CLI: each poll shows what has come.
                let end = try await client.waitForCloudSignIn(started, tick: { [weak self] next in
                    Task { @MainActor [weak self] in if !Task.isCancelled { self?.show(next) } }
                })
                guard !Task.isCancelled else { return }
                self?.finished(end, success: Strings.Providers.chatGPTConnected) { self?.start() }
            } catch is CancellationError {
            } catch {
                self?.failedToStart(error)
            }
        }
    }

    private func show(_ signIn: CloudSignIn) {
        self.signIn = signIn
        code.text = signIn.userCode ?? code.text
        copy?.isEnabled = signIn.userCode != nil
        open?.isEnabled = signIn.url != nil
        status.text = Strings.Providers.waiting
    }

    private func copyCode() {
        guard let value = signIn?.userCode else { return }
        UIPasteboard.general.string = value
        copy?.configuration?.title = Strings.Providers.copied
    }

    private func cancel() {
        follow?.cancel()
        let client = flows.client
        if signIn != nil { Task { await client.cancelCloudSignIn(.codex) } }
        navigationController?.popViewController(animated: true)
    }
}

/// Claude's sign-in (§5): its page, opened in Safari, shows a code that is
/// pasted back here; or a setup token from `claude setup-token` (§3) where
/// the server takes one. A server that doesn't run the sign-in yet offers
/// only the token.
final class ClaudeSignInViewController: ProviderSignInViewController {
    private let field = UITextField()
    private let offered: Bool
    private let setupToken: Bool
    private var signIn: CloudSignIn?
    private var open: UIButton?
    private var connect: UIButton?

    init(flows: ProviderFlows, offered: Bool, setupToken: Bool) {
        self.offered = offered
        self.setupToken = setupToken
        super.init(flows: flows, title: Strings.Providers.signInClaude)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "provider-claude"
        let token = button(Strings.Providers.useSetupToken, id: "provider-claude-token") { [weak self] in
            self?.flows.addSetupToken { self?.follow?.cancel() }
        }
        token.isHidden = !setupToken
        guard offered else {
            stack.addArrangedSubview(label(Strings.Providers.setupTokenHint))
            stack.addArrangedSubview(token)
            return
        }
        field.placeholder = Strings.Providers.code
        field.borderStyle = .roundedRect
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.accessibilityIdentifier = "provider-claude-code"
        field.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        let open = button(Strings.Providers.openClaude, prominent: true, id: "provider-claude-open") { [weak self] in self?.openPage(self?.signIn?.url) }
        let connect = button(Strings.Providers.connect, id: "provider-claude-connect") { [weak self] in self?.send() }
        self.open = open; self.connect = connect
        open.isEnabled = false; connect.isEnabled = false
        let waiting = UIStackView(arrangedSubviews: [spinner, status])
        waiting.axis = .vertical
        waiting.spacing = 8
        for view in [label(Strings.Providers.claudeInstructions), open, field, connect, waiting, token] as [UIView] { stack.addArrangedSubview(view) }
        start()
    }

    private func start() {
        spinner.startAnimating()
        status.text = nil
        field.text = nil
        follow?.cancel()
        let client = flows.client, container = flows.destination.container(vendor: "claude-code")
        follow = Task { @MainActor [weak self] in
            do {
                let started = try await client.startCloudSignIn(.claude, container: container)
                self?.show(started)
                self?.watch(started)
            } catch is CancellationError {
            } catch {
                self?.failedToStart(error)
            }
        }
    }

    /// Its page and code field, once the server's CLI has them.
    private func show(_ signIn: CloudSignIn) {
        self.signIn = signIn
        open?.isEnabled = signIn.url != nil
        connect?.isEnabled = signIn.acceptsCode
        if signIn.url != nil { spinner.stopAnimating() }
    }

    /// Follows the sign-in to its end, whoever ends it, showing its page
    /// when it comes.
    private func watch(_ signIn: CloudSignIn) {
        let client = flows.client
        follow = Task { @MainActor [weak self] in
            let end = try? await client.waitForCloudSignIn(signIn, tick: { [weak self] next in
                Task { @MainActor [weak self] in if next.id == signIn.id, !next.ended { self?.show(next) } }
            })
            guard let end, !Task.isCancelled else { return }
            self?.finished(end, success: Strings.Providers.claudeConnected) { self?.start() }
        }
    }

    private func send() {
        let code = (field.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty, signIn != nil else { return }
        field.resignFirstResponder()
        connect?.isEnabled = false
        spinner.startAnimating()
        status.text = Strings.Providers.waiting
        let client = flows.client
        Task { @MainActor [weak self] in
            do {
                let next = try await client.finishCloudSignIn(.claude, code: code)
                self?.field.text = nil
                if next.ended { self?.follow?.cancel(); self?.finished(next, success: Strings.Providers.claudeConnected) { self?.start() } }
            } catch {
                self?.spinner.stopAnimating()
                self?.connect?.isEnabled = true
                self?.status.text = ProviderFlows.words(error)
            }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // Leaving with a sign-in still waiting for its code ends it.
        guard isMovingFromParent, let signIn, !signIn.ended else { return }
        follow?.cancel()
        let client = flows.client
        Task { await client.cancelCloudSignIn(.claude) }
    }
}
#endif
