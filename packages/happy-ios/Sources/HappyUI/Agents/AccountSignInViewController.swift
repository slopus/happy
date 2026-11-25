#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
import UIKit

/// Signing one of a computer's accounts in again (API.md "Provider
/// sign-in"), drawn by `AccountSignInView`: every state fills the same
/// places, so nothing moves as the sign-in goes on. Codex and Grok show
/// their device code to type at the vendor; Claude opens its page and takes the code it shows, pasted back.
/// The daemon runs the vendor's program and keeps the credential: the
/// phone hands a pasted code on once and keeps nothing. It follows
/// `provider_sign_in.updated` and reads the sign-in every 3 seconds besides,
/// until it ends; leaving while it runs cancels it.
final class AccountSignInViewController: UIViewController {
    private let client: AgentClient
    private let store: Store?
    private let account: ProviderAccount
    private let changed: (ProviderSignIn) -> Void
    private let refused: (ProviderSignInRefusal) -> Void
    private var current: ProviderSignIn?
    /// The operation this screen follows; nil until it started or joined.
    private var operationId: String?
    private var shown: ProviderSignIn.Phase?
    private var submitting = false
    private var following: Task<Void, Never>?
    private var listening: Task<Void, Never>?

    private let page = AccountSignInView()

    init(client: AgentClient, store: Store?, account: ProviderAccount, current: ProviderSignIn?,
         changed: @escaping (ProviderSignIn) -> Void, refused: @escaping (ProviderSignInRefusal) -> Void) {
        self.client = client
        self.store = store
        self.account = account
        self.current = current
        self.changed = changed
        self.refused = refused
        super.init(nibName: nil, bundle: nil)
        title = Strings.ProviderAccounts.signInAgain
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    deinit {
        following?.cancel()
        listening?.cancel()
    }

    /// What the screen shows now: for the tests.
    var shownPhase: ProviderSignIn.Phase? { shown }
    /// Where each place is: for the tests, the same in every state.
    var shownSlots: [CGRect] { page.places }

    override func loadView() { view = page }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "account-sign-in"
        navigationItem.largeTitleDisplayMode = .never
        page.name.string = ProviderAccountsModel.name(account)
        page.field.addAction(UIAction { [weak self] _ in self?.submitCode() }, for: .editingDidEndOnExit)
        listen()
        if let operation = current?.operation, !operation.ended {
            // One already going, from this phone or another device: joined.
            operationId = operation.id
            render(current?.phase ?? .starting)
            follow()
        } else {
            start()
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        guard navigationController?.viewControllers.contains(where: { $0 === self }) != true else { return }
        following?.cancel()
        listening?.cancel()
        // Backing out cancels what is still going.
        guard operationId != nil, current?.operation?.ended == false else { return }
        let client = client, id = account.id
        Task { _ = try? await client.cancelProviderSignIn(id) }
    }

    // MARK: Following

    private func start() {
        operationId = nil
        submitting = false
        page.field.text = nil
        render(.starting)
        let client = client, account = account
        following?.cancel()
        following = Task { @MainActor [weak self] in
            do {
                let started = try await client.startProviderSignIn(account.id, method: account.credential.phoneMethod(cli: account.type))
                guard let self, !Task.isCancelled else { return }
                operationId = started.operation?.id
                adopt(started)
                follow()
            } catch is CancellationError {
            } catch {
                guard let self, !Task.isCancelled else { return }
                let refusal = ProviderSignInRefusal(error)
                refused(refusal)
                let message = ProviderAccountsModel.words(refusal, cli: account.type) ?? Strings.ProviderAccounts.keptLogin
                // Nothing a second try could change: only Close.
                let final = refusal == .ownerOnly || refusal == .notInstalled || refusal == .notSupported
                renderFailure(title: Strings.ProviderAccounts.signInFailed, message: message, retry: !final)
            }
        }
    }

    /// Reads the sign-in every 3 seconds until it ends: events can be
    /// missed, a read can't.
    private func follow() {
        following?.cancel()
        let client = client, id = account.id
        following = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled else { return }
                let read = try? await client.providerSignIn(id)
                guard let self, !Task.isCancelled else { return }
                if let read { adopt(read) }
                if current?.operation?.ended == true { return }
            }
        }
    }

    private func listen() {
        guard let store else { return }
        let id = account.id
        listening = Task { @MainActor [weak self] in
            for await event in await store.events(matching: [ProviderSignIn.updatedEvent]) {
                guard let self, !Task.isCancelled else { return }
                guard case .event(let envelope) = event, let signIn = ProviderSignIn.fromEvent(envelope), signIn.providerId == id else { continue }
                adopt(signIn)
            }
        }
    }

    /// A newer object for this account. Before the start answers, and for
    /// an operation that isn't this one's, an end is someone else's: only
    /// another running one is joined.
    private func adopt(_ signIn: ProviderSignIn) {
        guard signIn.isNewer(than: current) else { return }
        guard let operation = signIn.operation else { return }
        if operation.id != operationId {
            guard !operation.ended else { return }
            operationId = operation.id
        }
        current = signIn
        changed(signIn)
        if submitting, operation.ended || !operation.acceptsCode { submitting = false }
        render(signIn.phase)
    }

    // MARK: Drawing

    private func render(_ phase: ProviderSignIn.Phase) {
        typealias Text = Strings.ProviderAccounts
        if phase == .cancelled {
            following?.cancel()
            navigationController?.popViewController(animated: true)
            return
        }
        let status = submitting ? Text.checking : phase == .starting ? nil : Text.waiting
        guard phase != shown else { return page.showStatus(status) }
        shown = phase
        let cancel = AccountSignInView.Button(title: Strings.Common.cancel, id: "account-sign-in-cancel") { [weak self] in self?.cancel() }
        let state: AccountSignInView.State
        switch phase {
        case .starting:
            state = .init(heading: Text.starting, waiting: true, status: status, buttons: [nil, nil, cancel])
        case .device(let code, let url):
            state = .init(heading: Text.deviceInstructions, code: code ?? "····-····", waiting: true, status: status, buttons: [
                .init(title: Strings.Providers.copy, id: "account-sign-in-copy", enabled: code != nil) { [weak self] in self?.copyCode(code) },
                .init(title: Text.openPage, prominent: true, id: "account-sign-in-open", enabled: url != nil) { url.map { UIApplication.shared.open($0) } },
                cancel,
            ])
        case .pasteCode(let url):
            state = .init(heading: Text.browserInstructions, asksCode: true, waiting: true, status: status, buttons: [
                .init(title: Text.openPage, prominent: true, id: "account-sign-in-open", enabled: url != nil) { url.map { UIApplication.shared.open($0) } },
                .init(title: Text.submitCode, id: "account-sign-in-submit") { [weak self] in self?.submitCode() },
                cancel,
            ])
        case .onComputer:
            state = .init(heading: Text.finishOnComputerTitle, message: Text.finishOnComputer, waiting: true, status: status, buttons: [nil, nil, cancel])
        case .succeeded(let signedIn):
            let line = [signedIn?.email, signedIn?.plan].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
            state = .init(heading: Text.signedIn, message: line, buttons: [nil, nil, .init(title: Text.done, prominent: true, id: "account-sign-in-done") { [weak self] in
                self?.navigationController?.popViewController(animated: true)
            }])
        case .failed(let code, let message):
            return renderFailure(title: Text.failure(code), message: message ?? Text.keptLogin, retry: true)
        case .cancelled:
            return
        }
        page.show(state, animated: true)
    }

    /// A sign-in that ended badly, or never started: its words, the
    /// daemon's, and a way to start over where one could help.
    private func renderFailure(title: String, message: String, retry: Bool) {
        typealias Text = Strings.ProviderAccounts
        shown = .failed(code: nil, message: message)
        page.show(.init(heading: title, failed: true, message: message, buttons: [
            nil,
            retry ? .init(title: Text.tryAgain, prominent: true, id: "account-sign-in-retry") { [weak self] in self?.start() } : nil,
            .init(title: Text.close, id: "account-sign-in-close") { [weak self] in self?.navigationController?.popViewController(animated: true) },
        ]), animated: true)
    }

    // MARK: Actions

    private func copyCode(_ code: String?) {
        guard let code else { return }
        UIPasteboard.general.string = code
        page.buttons[0].title = Strings.Providers.copied
    }

    /// Types `code` into the field and sends it, as a person would: for the
    /// tests and the harness.
    func enterCode(_ code: String) {
        page.field.text = code
        submitCode()
    }

    /// The code from Claude's page, handed on once; the field is emptied.
    private func submitCode() {
        let code = (page.field.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty, !submitting else { return }
        submitting = true
        page.field.text = nil
        page.field.resignFirstResponder()
        page.showStatus(Strings.ProviderAccounts.checking)
        let client = client, id = account.id, cli = account.type
        Task { @MainActor [weak self] in
            do {
                let next = try await client.sendProviderSignInCode(id, code: code)
                self?.adopt(next)
            } catch {
                guard let self else { return }
                submitting = false
                page.showStatus(Strings.ProviderAccounts.waiting)
                let refusal = ProviderSignInRefusal(error)
                refused(refusal)
                if refusal == .conflict, let read = try? await client.providerSignIn(id) { return adopt(read) }
                Alerts.show(Strings.ProviderAccounts.signInFailed, ProviderAccountsModel.words(refusal, cli: cli), on: self)
            }
        }
    }

    private func cancel() {
        following?.cancel()
        let client = client, id = account.id
        let going = operationId != nil && current?.operation?.ended == false
        // Marked ended here, so leaving doesn't cancel it a second time.
        operationId = nil
        if going { Task { _ = try? await client.cancelProviderSignIn(id) } }
        navigationController?.popViewController(animated: true)
    }
}
#endif
