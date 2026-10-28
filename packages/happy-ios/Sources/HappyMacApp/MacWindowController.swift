import AppKit
import HappyCore
import HappyLayout
import HappyWire

@MainActor
final class MacWindowController: NSWindowController, NSMenuItemValidation {
    let account: AccountController
    let model = NativeSessionModel()
    let root = MacRootView()
    private var accountsObservation: AccountsObservation?
    private var busy = false
    private var selectedID: String?
    private var drafts: [String: String] = [:]

    init(account: AccountController) {
        self.account = account
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Happy"
        window.contentMinSize = MacDesktopLayout.minimumSize
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.setFrameAutosaveName("HappyNativeMain")
        window.center()
        super.init(window: window)
        window.contentView = root
        root.welcome.create.target = self; root.welcome.create.action = #selector(createAccount)
        root.welcome.restore.target = self; root.welcome.restore.action = #selector(restoreAccount)
        root.welcome.server.target = self; root.welcome.server.action = #selector(showSettings(_:))
        root.sidebar.footer.target = self; root.sidebar.footer.action = #selector(showSettings(_:))
        root.sidebar.onSelect = { [weak self] in self?.select($0) }
        root.conversation.onSend = { [weak self] in self?.sendMessage() }
        root.conversation.onPermission = { [weak self] id, allow in self?.perform { [weak self] in try await self?.model.permission(id, allow: allow) } }
        root.conversation.onRetry = { [weak self] id in self?.perform { [weak self] in try await self?.model.retry(id) } }
        root.conversation.more.target = self; root.conversation.more.action = #selector(loadOlder)
        root.conversation.stop.target = self; root.conversation.stop.action = #selector(stopTurn)
        model.onChange = { [weak self] change in self?.update(change) }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func start() {
        account.onChange = { [weak self] _ in self?.accountChanged() }
        accountsObservation = account.observeAccounts { [weak self] _ in self?.root.sidebar.footer.title = self?.account.session == nil ? "Account & settings" : "Account & settings…" }
        Task { await account.restore(); accountChanged() }
    }

    private func accountChanged() {
        selectedID = nil; drafts.removeAll(); root.conversation.composer.string = ""
        model.attach(account.session)
        let signedIn = account.session != nil
        root.welcome.isHidden = signedIn
        root.conversation.isHidden = !signedIn
        root.conversation.setEnabled(false)
        root.conversation.title.stringValue = "Select a session"
        root.sidebar.update([], signedIn: signedIn)
        root.welcome.status.stringValue = account.pendingServerConfirmation == nil
            ? "Native macOS · AppKit" : "Confirm this account's server in Settings before connecting."
    }

    private func update(_ change: NativeSessionModel.Change) {
        switch change {
        case .sessions:
            root.sidebar.update(model.sessions, signedIn: account.session != nil)
        case .conversation(let changes):
            root.conversation.update(model.rows, changes: changes, hasMore: model.hasMore)
            root.conversation.hint.stringValue = model.isLoaded ? "⌘ Return to send · End-to-end encrypted" : "Loading conversation…"
        case .status: break
        }
    }

    private func select(_ id: String) {
        if let selectedID { drafts[selectedID] = root.conversation.composer.string }
        selectedID = id
        root.conversation.composer.string = drafts[id] ?? ""
        root.conversation.setEnabled(true)
        root.conversation.title.stringValue = model.sessions.first(where: { $0.id == id })?.title ?? "New chat"
        model.select(id)
    }

    @objc private func createAccount() {
        perform { [weak self] in
            guard let self else { return }
            let credentials = try await self.account.authService.createAccount()
            try await self.account.signIn(credentials)
        }
    }

    @objc private func restoreAccount() {
        let field = NSSecureTextField()
        field.placeholderString = "Secret recovery key"
        field.frame.size = NSSize(width: 420, height: 28)
        let alert = NSAlert()
        alert.messageText = "Restore existing account"
        alert.informativeText = "Enter your Happy secret key. It stays in this Mac's Keychain."
        alert.accessoryView = field
        alert.addButton(withTitle: "Restore"); alert.addButton(withTitle: "Cancel")
        guard let window else { return }
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            let secret = field.stringValue; field.stringValue = ""
            self?.perform { [weak self] in
                guard let self else { return }
                let credentials = try await self.account.authService.restore(secretKey: secret)
                try await self.account.signIn(credentials)
            }
        }
    }

    @objc func showSettings(_ sender: Any?) {
        guard let window, window.attachedSheet == nil else { return }
        let server = NSTextField(string: account.serverConfig.serverURL.absoluteString)
        server.placeholderString = "https://your-happy-server"
        server.frame.size = NSSize(width: 460, height: 28)
        let alert = NSAlert()
        alert.messageText = "Account & server"
        alert.informativeText = account.pendingServerConfirmation != nil
            ? "Confirm the server that owns this account. Credentials are never sent to a new server until you confirm it."
            : "Server changes apply to the next sign-in, not existing accounts. Mac push, voice, stories, and direct connections are not available in this AppKit version."
        alert.accessoryView = server
        alert.addButton(withTitle: account.pendingServerConfirmation == nil ? "Save" : "Confirm Server")
        alert.addButton(withTitle: "Cancel")
        if account.session != nil { alert.addButton(withTitle: "Sign Out") }
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            if response == .alertThirdButtonReturn { self.confirmSignOut(); return }
            guard response == .alertFirstButtonReturn else { return }
            self.perform {
                if let pending = self.account.pendingServerConfirmation {
                    try await self.account.confirmServer(ServerConfig.validate(server.stringValue), for: pending.id)
                } else {
                    try self.account.serverConfig.setCustomServerURL(server.stringValue)
                }
            }
        }
    }

    private func confirmSignOut() {
        guard let window else { return }
        let alert = NSAlert(); alert.messageText = "Sign out of this account?"
        alert.informativeText = "Keep your recovery key before signing out."
        alert.addButton(withTitle: "Sign Out"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn, let self else { return }
            Task { await self.account.signOut() }
        }
    }

    @objc func pairComputer(_ sender: Any?) {
        guard account.session != nil, let window else { return }
        let field = NSTextField(); field.placeholderString = "happy://terminal?…"
        field.frame.size = NSSize(width: 460, height: 28)
        let alert = NSAlert(); alert.messageText = "Connect a computer"
        alert.informativeText = "Paste the pairing URL shown by Happy on your computer."
        alert.accessoryView = field; alert.addButton(withTitle: "Continue"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { [weak self] response in
            if response == .alertFirstButtonReturn { self?.openPairingURL(field.stringValue) }
        }
    }

    func openPairingURL(_ text: String) {
        guard let link = PairingLink(text) else { return showError("This is not a valid Happy pairing link.") }
        guard let session = account.session else { return showError("Sign in before connecting another device.") }
        guard let window else { return }
        let alert = NSAlert(); alert.messageText = "Connect this device to your account?"
        alert.informativeText = "Only approve a link you requested. The other device will be able to access this account."
        alert.addButton(withTitle: "Connect"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            self?.perform { _ = try await session.pairing.approve(link) }
        }
    }

    @objc func newSession(_ sender: Any?) {
        guard let session = account.session, let window else { return }
        let available = model.machines.filter { $0.active && !MachineChoice.isRigMachine($0.metadata) }
        guard !available.isEmpty else { return showError("Connect an online Happy CLI computer first. Happy Agent catalog session creation is not yet available in this Mac interface.") }
        let machine = NSPopUpButton(); machine.addItems(withTitles: available.map { $0.metadata?["displayName"]?.stringValue ?? $0.metadata?["host"]?.stringValue ?? $0.id })
        let directory = NSTextField(); directory.placeholderString = "Absolute project path on that computer"
        let agent = NSPopUpButton(); agent.addItems(withTitles: ["claude", "codex", "gemini", "openclaw"])
        let stack = NSStackView(views: [machine, directory, agent]); stack.orientation = .vertical; stack.spacing = 12
        stack.frame = NSRect(x: 0, y: 0, width: 460, height: 110)
        let alert = NSAlert(); alert.messageText = "New Session"; alert.accessoryView = stack
        alert.addButton(withTitle: "Start"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn, let self else { return }
            guard directory.stringValue.hasPrefix("/") else { return self.showError("Enter an absolute directory path.") }
            var options = SpawnSessionOptions(machineId: available[machine.indexOfSelectedItem].id, directory: directory.stringValue, agent: agent.titleOfSelectedItem)
            options.token = session.credentials.token
            options.clientRequestId = UUID().uuidString
            self.spawn(options, account: session)
        }
    }

    private func spawn(_ options: SpawnSessionOptions, account session: AccountSession) {
        perform { [weak self] in
            guard let self else { return }
            let result = await session.machineActions.machineSpawnNewSession(options: options)
            guard self.account.session === session else { return }
            switch result {
            case .success(let id):
                await session.sync.run(.sessions)
                self.select(id)
            case .requestToApproveDirectoryCreation(let directory):
                guard let window = self.window else { return }
                let alert = NSAlert(); alert.messageText = "Create directory?"; alert.informativeText = directory
                alert.addButton(withTitle: "Create"); alert.addButton(withTitle: "Cancel")
                alert.beginSheetModal(for: window) { [weak self] response in
                    guard response == .alertFirstButtonReturn else { return }
                    var approved = options; approved.approvedNewDirectoryCreation = true
                    self?.spawn(approved, account: session)
                }
            case .pending:
                self.showError("The computer is still starting the session. It will appear in the list when ready.")
            case .error(let message): self.showError(message)
            }
        }
    }

    private func sendMessage() {
        let text = root.conversation.composer.string
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, let id = selectedID, !busy else { return }
        perform { [weak self] in
            guard let self else { return }
            try await self.model.send(text)
            if self.selectedID == id, self.root.conversation.composer.string == text {
                self.root.conversation.composer.string = ""; self.drafts[id] = nil
            }
        }
    }
    @objc private func loadOlder() { Task { await model.older() } }
    @objc private func stopTurn() { perform { [weak self] in try await self?.model.stopTurn() } }

    private func perform(_ work: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true; root.welcome.create.isEnabled = false; root.welcome.restore.isEnabled = false
        root.welcome.status.stringValue = "Connecting…"
        Task { [weak self] in
            do { try await work() } catch { self?.showError(error.localizedDescription) }
            guard let self else { return }
            self.busy = false; self.root.welcome.create.isEnabled = true; self.root.welcome.restore.isEnabled = true
            self.root.welcome.status.stringValue = "Native macOS · AppKit"
        }
    }

    private func showError(_ text: String) {
        guard let window else { return }
        let alert = NSAlert(); alert.messageText = "Happy"; alert.informativeText = text
        alert.alertStyle = .warning; alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window)
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(newSession(_:)) || menuItem.action == #selector(pairComputer(_:)) {
            return account.session != nil && !busy && window?.attachedSheet == nil
        }
        return !busy && window?.attachedSheet == nil
    }
}