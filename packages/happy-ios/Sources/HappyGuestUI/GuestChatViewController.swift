#if canImport(UIKit)
import UIKit
#if canImport(HappyGuest) && !HAPPY_GUEST_STANDALONE
import HappyGuest
#endif
#if canImport(HappyLayout) && !HAPPY_GUEST_STANDALONE
import HappyLayout
#endif

@MainActor private enum GuestServices {
    static let vault = GuestSessionVault(storage: GuestKeychainStorage())
}

/// Shared by the Clip and the installed parent; never uses owner credentials.
@MainActor public final class GuestChatViewController: UIViewController {
    private let titleLabel = UILabel()
    private let statusLabel = UILabel()
    private let transcript = UITextView()
    private let input = UITextField()
    private let sendButton = UIButton(type: .system)
    private let retryButton = UIButton(type: .system)
    private let moreButton = UIButton(type: .system)
    private let nameInput = UITextField()
    private let joinButton = UIButton(type: .system)
    private let joinNotice = UILabel()
    private var onboardingInvitation: GuestInvitation?
    private var redemptionName: String?
    private let vault = GuestServices.vault
    private var invitationID: String?
    private var record: StoredGuestSession?
    private var client: GuestClient?
    private var cursor: String?
    private var opening: Task<Void, Never>?
    private var polling: Task<Void, Never>?
    private var sending: Task<Void, Never>?
    private var generation = UUID()
    private var pollID = UUID()
    private var active = true
    private var terminal = false
    private var forcedReadOnly = false
    private var noticeUntil: Date?

    deinit { opening?.cancel(); polling?.cancel(); sending?.cancel() }

    public override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        titleLabel.text = "Happy"
        titleLabel.font = .systemFont(ofSize: 28, weight: .bold)
        statusLabel.text = "Open a bot invitation to start chatting."
        statusLabel.font = .systemFont(ofSize: 15)
        statusLabel.textColor = .secondaryLabel
        statusLabel.numberOfLines = 2
        transcript.isEditable = false
        transcript.dataDetectorTypes = []
        transcript.backgroundColor = .secondarySystemBackground
        transcript.layer.cornerRadius = 16
        input.placeholder = "Message"
        input.borderStyle = .roundedRect
        input.accessibilityIdentifier = "guest.message"
        nameInput.placeholder = "Your name"
        nameInput.borderStyle = .roundedRect
        nameInput.textContentType = .name
        nameInput.autocapitalizationType = .words
        nameInput.autocorrectionType = .no
        nameInput.accessibilityIdentifier = "guest.name"
        joinButton.setTitle("Join", for: .normal)
        joinButton.accessibilityIdentifier = "guest.join"
        joinButton.addTarget(self, action: #selector(join), for: .touchUpInside)
        joinNotice.text = "Everyone who joins this link can see this chat, including earlier messages.\nNames are chosen by members and aren’t verified."
        joinNotice.font = .systemFont(ofSize: 13)
        joinNotice.textColor = .secondaryLabel
        joinNotice.numberOfLines = 4
        sendButton.setTitle("Send", for: .normal)
        sendButton.accessibilityIdentifier = "guest.send"
        sendButton.addTarget(self, action: #selector(send), for: .touchUpInside)
        retryButton.setTitle("Reconnect", for: .normal)
        retryButton.addTarget(self, action: #selector(reconnect), for: .touchUpInside)
        retryButton.isHidden = true
        moreButton.setTitle("More", for: .normal)
        moreButton.showsMenuAsPrimaryAction = true
        moreButton.menu = UIMenu(children: [
            UIAction(title: "Report conversation") { [weak self] _ in self?.report() },
            UIAction(title: "Leave conversation", attributes: .destructive) { [weak self] _ in self?.leave() },
        ])
        for child in [titleLabel, statusLabel, transcript, input, sendButton, retryButton, moreButton, nameInput, joinButton, joinNotice] { view.addSubview(child) }
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged),
                                               name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        updateComposer()
    }

    public override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); setActive(true) }
    public override func viewDidDisappear(_ animated: Bool) { super.viewDidDisappear(animated); setActive(false) }
    @objc private func keyboardChanged() { view.setNeedsLayout() }

    public override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let layout = GuestChatLayout(size: view.bounds.size, safeTop: view.safeAreaInsets.top,
                                     bottom: view.bounds.maxY - view.keyboardLayoutGuide.layoutFrame.minY,
                                     showsComposer: !isReadOnly)
        titleLabel.frame = layout.title; statusLabel.frame = layout.status
        transcript.frame = layout.messages; input.frame = layout.input
        sendButton.frame = layout.send; retryButton.frame = layout.retry; moreButton.frame = layout.more
        nameInput.frame = layout.name; joinButton.frame = layout.join
        joinNotice.frame = layout.joinNotice
    }

    public func open(_ url: URL) {
        loadViewIfNeeded()
        guard let invitation = GuestInvitation(url: url) else {
            reset()
            terminal = true
            statusLabel.text = "This invitation link is invalid."
            updateComposer()
            return
        }
        if invitationID == invitation.identifier, !terminal { setActive(true); return }
        reset()
        invitationID = invitation.identifier
        statusLabel.text = "Opening invitation…"
        let generation = self.generation
        let origin = Self.apiOrigin(for: invitation.origin)
        let vault = self.vault
        updateComposer()
        opening = Task { [weak self] in
            do {
                if let stored = try await vault.restore(invitationID: invitation.identifier), stored.origin == origin {
                    guard self?.generation == generation else { return }
                    try await vault.save(stored)
                    guard self?.generation == generation else { return }
                    self?.opening = nil
                    self?.apply(stored)
                } else if let pending = try await vault.pendingRedemption(invitationID: invitation.identifier), pending.nameRejected != true, let name = pending.displayName {
                    guard self?.generation == generation else { return }
                    self?.opening = nil
                    self?.redeem(invitation, displayName: name)
                } else {
                    guard self?.generation == generation else { return }
                    self?.opening = nil
                    self?.onboardingInvitation = invitation
                    self?.titleLabel.text = "Join a Happy bot"
                    self?.statusLabel.text = "Enter your name to start chatting."
                    self?.updateComposer()
                }
            } catch {
                guard self?.generation == generation else { return }
                self?.opening = nil
                self?.statusLabel.text = "Couldn't open the secure guest session. Try again."
                self?.retryButton.isHidden = false
            }
        }
    }

    @objc private func join() {
        guard opening == nil, let invitation = onboardingInvitation else { return }
        guard let name = GuestDisplayName.normalized(nameInput.text ?? "") else {
            statusLabel.text = "Use 1–40 letters or numbers. Spaces and . ' - _ are allowed."
            return
        }
        nameInput.text = name
        nameInput.resignFirstResponder()
        redeem(invitation, displayName: name)
    }

    private func redeem(_ invitation: GuestInvitation, displayName: String) {
        let generation = self.generation
        let origin = Self.apiOrigin(for: invitation.origin)
        let vault = self.vault
        redemptionName = displayName
        statusLabel.text = "Joining…"
        opening = Task { [weak self] in
            var backoff: Double = 1
            while !Task.isCancelled {
                do {
                    // Vault owns the durable handshake independently of this view.
                    let stored = try await vault.redeem(invitation, origin: origin, displayName: displayName)
                    guard self?.generation == generation else { return }
                    try await vault.save(stored)
                    guard self?.generation == generation else { return }
                    self?.opening = nil
                    self?.apply(stored)
                    return
                } catch {
                    guard self?.generation == generation else { return }
                    if error as? GuestError == .invalidName {
                        self?.onboardingInvitation = invitation
                        self?.redemptionName = nil
                        self?.nameInput.text = displayName
                    }
                    if await self?.handle(error) == true { return }
                    guard self?.active == true else { self?.opening = nil; return }
                    let delay: Double
                    if case let GuestError.retryAfter(seconds) = error { delay = seconds }
                    else { delay = backoff; backoff = min(30, backoff * 2) }
                    do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                }
            }
        }
        updateComposer()
    }

    public func restore() {
        loadViewIfNeeded()
        guard opening == nil, record == nil, invitationID == nil else { return }
        let generation = self.generation
        let vault = self.vault
        opening = Task { [weak self] in
            do {
                if let stored = try await vault.restore() {
                    guard self?.generation == generation else { return }
                    guard Self.allowedStoredOrigin(stored.origin) else {
                        self?.opening = nil
                        self?.statusLabel.text = "Open an invitation for this server."
                        return
                    }
                    self?.opening = nil
                    self?.invitationID = stored.invitationID
                    self?.apply(stored)
                } else if let pending = try await vault.pendingRedemption() {
                    guard self?.generation == generation else { return }
                    guard Self.allowedStoredOrigin(pending.origin) else {
                        self?.opening = nil
                        self?.statusLabel.text = "Open an invitation for this server."
                        return
                    }
                    self?.opening = nil
                    self?.open(pending.invitationURL)
                } else { self?.opening = nil }
            } catch {
                if self?.generation == generation {
                    self?.opening = nil
                    self?.statusLabel.text = "Couldn't restore the secure guest session."
                }
            }
        }
    }

    private static func apiOrigin(for origin: URL) -> URL {
        #if DEBUG
        if let value = ProcessInfo.processInfo.environment["HAPPY_GUEST_API_ORIGIN"], let candidate = URL(string: value),
           ["http", "https"].contains(candidate.scheme), candidate.host != nil,
           candidate.user == nil, candidate.password == nil, candidate.query == nil, candidate.fragment == nil,
           candidate.path.isEmpty || candidate.path == "/" { return candidate }
        #endif
        return origin
    }

    private static func allowedStoredOrigin(_ origin: URL) -> Bool {
        let trusted = URL(string: "https://app.happy.engineering")!
        let preview = URL(string: "https://" + GuestInvitation.previewHost)!
        return origin == trusted || (GuestInvitation.previewEnabled && origin == preview) || origin == apiOrigin(for: trusted)
    }

    private func apply(_ stored: StoredGuestSession) {
        record = stored
        onboardingInvitation = nil
        client = GuestClient(origin: stored.origin)
        titleLabel.text = stored.session.botName
        input.placeholder = stored.displayName.map { "Message as \($0)" } ?? "Message"
        input.text = stored.pending?.text
        statusLabel.text = isReadOnly ? "Read only · You can view this conversation." : "Connecting…"
        updateComposer()
        connect()
    }

    public func setActive(_ active: Bool) {
        self.active = active
        if active {
            if record == nil, opening == nil, onboardingInvitation == nil, invitationID != nil, !terminal { invitationID = nil; restore() }
            else { connect() }
        }
        else { polling?.cancel(); polling = nil }
    }

    private func connect() {
        guard active, !terminal, polling == nil, let client, let session = record?.session else { return }
        let generation = self.generation
        let pollID = UUID()
        self.pollID = pollID
        polling = Task { [weak self] in
            defer { if self?.pollID == pollID { self?.polling = nil } }
            var backoff: Double = 1
            while !Task.isCancelled {
                do {
                    let page = try await client.messages(session: session, after: self?.cursor)
                    try Task.checkCancellation()
                    guard self?.generation == generation, self?.terminal == false else { return }
                    let addition = await client.append(page.messages, botName: session.botName)
                    guard self?.generation == generation, self?.terminal == false else { return }
                    self?.cursor = page.cursor
                    if !addition.isEmpty { self?.appendMessages(addition) }
                    if Task.isCancelled { return }
                    if self?.noticeUntil.map({ $0 > Date() }) != true {
                        self?.statusLabel.text = self?.isReadOnly == true ? "Read only · You can view this conversation." :
                            self?.record?.pending != nil ? "Message not confirmed. Reconnect to retry." :
                            page.status == .offline ? "Bot is offline. Reconnecting…" : "Guest conversation · Invitation access only"
                    }
                    self?.retryButton.isHidden = self?.record?.pending == nil
                    self?.updateComposer()
                    backoff = 1
                    // Some offline/early-returning servers do not hold a poll.
                    // Empty successful pages must still have a bounded cadence.
                    if page.messages.isEmpty {
                        try await Task.sleep(for: .seconds(page.status == .offline ? 4 : 1))
                    }
                } catch {
                    guard !Task.isCancelled, self?.generation == generation else { return }
                    if await self?.handle(error) == true { return }
                    let delay: Double
                    if case let GuestError.retryAfter(seconds) = error { delay = seconds }
                    else { delay = backoff; backoff = min(30, backoff * 2) }
                    do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                }
            }
        }
    }

    @objc private func reconnect() {
        if record?.pending != nil { send() }
        else if record == nil, opening == nil { invitationID = nil; restore() }
        connect()
    }

    @objc private func send() {
        guard sending == nil, active, !terminal, !isReadOnly, let client, var stored = record else { return }
        let text = input.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard stored.pending != nil || !text.isEmpty else { return }
        guard text.utf16.count <= 4_000 else { showNotice("Use 4,000 characters or fewer."); return }
        if stored.pending == nil { stored.pending = GuestPendingMessage(localId: UUID().uuidString, text: text) }
        guard let pending = stored.pending else { return }
        record = stored
        let generation = self.generation
        let vault = self.vault
        sending = Task { [weak self] in
            defer { if self?.generation == generation { self?.sending = nil; self?.updateComposer() } }
            do {
                try await vault.save(stored, select: false)
                guard self?.generation == generation, self?.terminal == false else { return }
                try await client.send(session: stored.session, localId: pending.localId, text: pending.text)
                var acknowledged = stored
                acknowledged.pending = nil
                try await vault.save(acknowledged, select: false)
                guard self?.generation == generation, self?.terminal == false else { return }
                self?.record = acknowledged
                self?.input.text = ""
                self?.retryButton.isHidden = true
                self?.connect()
            } catch {
                guard self?.generation == generation else { return }
                if let rejection = error as? GuestSendRejection {
                    stored.pending = nil
                    if case .limitReached = rejection { stored.readOnlyOverride = true }
                    try? await vault.save(stored, select: false)
                    guard self?.generation == generation else { return }
                    self?.record = stored
                    if case .limitReached = rejection { self?.showNotice("Message limit reached. You can still read this conversation.") }
                    else { self?.showNotice("Message rejected. Edit it and send again (4,000 characters maximum).") }
                } else { _ = await self?.handle(error) }
            }
        }
        statusLabel.text = "Sending…"
        updateComposer()
    }

    private var isReadOnly: Bool { forcedReadOnly || record?.readOnlyOverride == true || record?.session.readOnly == true }

    private func updateComposer() {
        let onboarding = onboardingInvitation != nil && !terminal
        nameInput.isHidden = !onboarding; joinButton.isHidden = !onboarding
        joinNotice.isHidden = !onboarding
        nameInput.isEnabled = opening == nil && redemptionName == nil; joinButton.isEnabled = opening == nil
        transcript.isHidden = record == nil
        input.isHidden = isReadOnly || record == nil; sendButton.isHidden = isReadOnly || record == nil
        let enabled = record != nil && !isReadOnly && !terminal && sending == nil
        input.isEnabled = enabled && record?.pending == nil
        sendButton.isEnabled = enabled
        moreButton.isEnabled = record != nil && !terminal
        moreButton.isHidden = record == nil
        view.setNeedsLayout()
    }

    private func appendMessages(_ text: String) {
        let addition = (transcript.textStorage.length == 0 ? "" : "\n\n") + text
        transcript.textStorage.append(NSAttributedString(string: addition, attributes: [
            .font: UIFont.systemFont(ofSize: 17), .foregroundColor: UIColor.label,
        ]))
        transcript.scrollRangeToVisible(NSRange(location: transcript.textStorage.length - 1, length: 1))
    }

    @discardableResult private func handle(_ error: any Error) async -> Bool {
        let generation = self.generation
        #if DEBUG
        // Diagnostic codes only; never interpolate URLs, request bodies,
        // descriptions, invitations, or scoped credentials into logs.
        if let keychain = error as? GuestKeychainStorage.Failure {
            NSLog("Guest secure storage failed with OSStatus %d", keychain.status)
        } else {
            NSLog("Guest operation failed type=%@ code=%ld", String(reflecting: type(of: error)), (error as NSError).code)
        }
        #endif
        switch error as? GuestError {
        case .inviteFull: await terminate("This invite is full. There are no free seats."); return true
        case .invalidName:
            statusLabel.text = "Use 1–40 letters or numbers. Spaces and . ' - _ are allowed."
            opening = nil
            updateComposer()
            return true
        case .expired: await terminate("This invitation has expired. Ask the owner for a new link."); return true
        case .revoked: await terminate("This invitation is no longer available."); return true
        case .alreadyRedeemed: await terminate("This invitation was already used on another device."); return true
        case .readOnly:
            forcedReadOnly = true
            record?.pending = nil
            record?.readOnlyOverride = true
            if let record { try? await vault.save(record, select: false) }
            guard self.generation == generation else { return true }
            statusLabel.text = "Read only · You can view this conversation."
            updateComposer()
        default:
            statusLabel.text = record?.pending == nil ? "Connection lost. Reconnecting…" : "Message not confirmed. Reconnect to retry."
            retryButton.isHidden = false
        }
        return false
    }

    private func terminate(_ text: String) async {
        let id = invitationID
        reset()
        let generation = self.generation
        terminal = true
        statusLabel.text = text
        updateComposer()
        if let id {
            do { try await vault.remove(invitationID: id) }
            catch {
                if self.generation == generation { statusLabel.text = "Access ended. Couldn't remove the saved guest session." }
            }
        }
    }

    private func reset() {
        generation = UUID()
        opening?.cancel(); opening = nil
        polling?.cancel(); polling = nil
        sending?.cancel(); sending = nil
        record = nil; client = nil; cursor = nil; invitationID = nil
        onboardingInvitation = nil
        redemptionName = nil
        terminal = false; forcedReadOnly = false
        noticeUntil = nil
        transcript.text = ""; input.text = ""; nameInput.text = ""; titleLabel.text = "Happy"
        retryButton.isHidden = true
    }

    private func report() {
        guard let client, let session = record?.session else { return }
        let generation = self.generation
        Task { [weak self] in
            do {
                try await client.report(session: session)
                if self?.generation == generation { self?.showNotice("Report sent to the bot owner.") }
            } catch { if self?.generation == generation { self?.statusLabel.text = "Couldn't send the report. Try again." } }
        }
    }

    private func leave() {
        guard let client, let session = record?.session else { return }
        let generation = self.generation
        Task { [weak self] in
            do {
                try await client.block(session: session)
                if self?.generation == generation { await self?.terminate("You left this conversation.") }
            } catch { if self?.generation == generation { _ = await self?.handle(error) } }
        }
    }

    private func showNotice(_ text: String) {
        noticeUntil = Date().addingTimeInterval(5)
        statusLabel.text = text
    }
}
#endif