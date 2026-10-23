#if canImport(UIKit)
import HappyChatKit
import HappyGuest
import HappyLayout
import UIKit

@MainActor private enum GuestServices {
    static let vault = GuestSessionVault(storage: GuestKeychainStorage())
}

/// Shared by the Clip and the installed parent; never uses owner credentials.
///
/// Drawn as the session screen is: the glass title capsule, the chat's rows
/// (`GuestRowRenderer`) and the composer card (`GuestComposerView`), in
/// HappyChatKit's fonts and the app's palette. Rows are measured off the
/// main thread; the main thread only applies them.
@MainActor public final class GuestChatViewController: UIViewController {
    private let capsule = HeaderGlassView()
    private let titleLabel = UILabel()
    private let subtitleLabel = UILabel()
    private let moreGlass = HeaderGlassView()
    private let moreButton = UIButton(type: .system)
    private let transcript = GuestTranscriptView()
    private let composer = GuestComposerView()
    private let retryButton = RoundButton(title: "Reconnect", size: .small)
    private let messageLabel = StyledLabel(style: TextStyles.onboardingProp, color: Palette.textSecondary, alignment: .center)
    private let onboardingTitle = StyledLabel(style: TextStyles.onboardingTitle, color: Palette.text, alignment: .center)
    private let onboardingSubtitle = StyledLabel(style: TextStyles.onboardingProp, color: Palette.textSecondary, alignment: .center)
    private let nameField = GuestNameField()
    private let joinButton = RoundButton(title: "Join")
    private let joinNotice = StyledLabel(style: TextStyles.promptHint, color: Palette.textSecondary, alignment: .center)
    private var nameInput: UITextField { nameField.field }
    private var botTitle = "Happy" { didSet { applyHeader() } }
    private var statusText = "Open a bot invitation to start chatting." { didSet { applyStatus() } }
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
    /// The conversation, oldest first, and its rows as last planned.
    private var messages: [GuestMessage] = []
    private var rows: [String: PlannedRow] = [:]
    private var planning: Task<Void, Never>?
    private var planGeneration = 0
    private var plannedWidth: CGFloat = 0
    private var plannedText: TextEnvironment?
    private var copiedMessageID: String?
    private var copiedReset: Task<Void, Never>?

    private struct PlannedRow: Sendable {
        var input: GuestRowInput
        var width: CGFloat
        var text: TextEnvironment?
        var plan: GuestRowPlan
    }

    deinit { opening?.cancel(); polling?.cancel(); sending?.cancel(); planning?.cancel(); copiedReset?.cancel() }

    public override func viewDidLoad() {
        super.viewDidLoad()
        Fonts.registerBundledFonts()
        followsTextSize()
        view.backgroundColor = UIColor(Palette.surface)

        transcript.onAction = { [weak self] action in self?.perform(action) }
        // Bot text is someone else's content: only web links open.
        transcript.onLink = { [weak self] url in
            guard ["http", "https"].contains(url.scheme?.lowercased()), url.host != nil else { return }
            self?.view.window?.windowScene?.open(url, options: nil)
        }
        view.addSubview(transcript)

        titleLabel.numberOfLines = 1
        subtitleLabel.numberOfLines = 1
        view.addSubview(capsule)
        view.addSubview(titleLabel)
        view.addSubview(subtitleLabel)
        moreButton.setImage(UIImage.symbol("ellipsis", pointSize: 17, weight: .semibold), for: .normal)
        moreButton.tintColor = UIColor(Palette.text)
        moreButton.accessibilityLabel = "More"
        moreButton.showsMenuAsPrimaryAction = true
        moreButton.menu = UIMenu(children: [
            UIAction(title: "Report conversation", image: UIImage(systemName: "flag")) { [weak self] _ in self?.report() },
            UIAction(title: "Leave conversation", image: UIImage(systemName: "rectangle.portrait.and.arrow.right"), attributes: .destructive) { [weak self] _ in self?.leave() },
        ])
        moreGlass.addSubview(moreButton)
        view.addSubview(moreGlass)

        messageLabel.numberOfLines = 0
        view.addSubview(messageLabel)
        onboardingTitle.string = "Join a Happy bot"
        onboardingSubtitle.numberOfLines = 0
        joinNotice.numberOfLines = 0
        joinNotice.string = "Everyone who joins this link can see this chat, including earlier messages.\nNames are chosen by members and aren’t verified."
        joinButton.accessibilityIdentifier = "guest.join"
        joinButton.onTap = { [weak self] in self?.join() }
        nameInput.addTarget(self, action: #selector(join), for: .editingDidEndOnExit)
        for child in [onboardingTitle, onboardingSubtitle, nameField, joinButton, joinNotice] as [UIView] { view.addSubview(child) }

        composer.onSend = { [weak self] in self?.send() }
        composer.onHeightChange = { [weak self] in self?.view.setNeedsLayout() }
        view.addSubview(composer)
        retryButton.onTap = { [weak self] in self?.reconnect() }
        retryButton.isHidden = true
        view.addSubview(retryButton)

        NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)),
                                               name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        registerForTraitChanges(UIView.textSizeTraits) { (self: Self, _) in self.view.setNeedsLayout() }
        applyHeader()
        applyStatus()
        updateComposer()
    }

    public override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); setActive(true) }
    public override func viewDidDisappear(_ animated: Bool) { super.viewDidDisappear(animated); setActive(false) }

    @objc private func keyboardChanged(_ notification: Notification) {
        let duration = notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
        view.setNeedsLayout()
        UIView.animate(withDuration: duration, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
            self.view.layoutIfNeeded()
        }
    }

    public override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let size = view.bounds.size
        let unbounded = CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
        let onboarding = onboardingInvitation != nil && !terminal
        let showsMessage = record == nil && !onboarding
        let layout = GuestChatLayout(.init(
            size: size,
            safeArea: LayoutInsets(view.safeAreaInsets),
            keyboardTop: view.keyboardLayoutGuide.layoutFrame.minY,
            title: titleLabel.sizeThatFits(unbounded),
            subtitle: subtitleLabel.isHidden ? nil : subtitleLabel.sizeThatFits(unbounded),
            composerHeight: record == nil ? nil : composer.composerHeight(fitting: size.width),
            retry: retryButton.isHidden ? nil : retryButton.sizeThatFits(unbounded),
            onboarding: onboarding ? GuestChatLayout.Onboarding(
                title: onboardingTitle.measurable, subtitle: onboardingSubtitle.measurable,
                joinHeight: joinButton.sizeThatFits(CGSize(width: size.width, height: .greatestFiniteMagnitude)).height,
                notice: joinNotice.measurable
            ) : nil,
            message: showsMessage ? messageLabel.measurable : nil
        ))
        capsule.setLayoutFrame(layout.capsule)
        titleLabel.setLayoutFrame(layout.title)
        if let frame = layout.subtitle { subtitleLabel.setLayoutFrame(frame) }
        moreGlass.setLayoutFrame(layout.more)
        moreButton.frame = moreGlass.bounds
        transcript.setLayoutFrame(layout.list)
        transcript.setInsets(oldest: layout.oldestInset, newest: layout.newestInset)
        if let frame = layout.composer { composer.setLayoutFrame(frame) }
        if let frame = layout.retry { retryButton.setLayoutFrame(frame) }
        if let frame = layout.message { messageLabel.setLayoutFrame(frame) }
        if let form = layout.onboarding {
            onboardingTitle.setLayoutFrame(form.title)
            onboardingSubtitle.setLayoutFrame(form.subtitle)
            nameField.setLayoutFrame(form.field)
            joinButton.setLayoutFrame(form.join)
            joinNotice.setLayoutFrame(form.notice)
        }
        if transcript.bounds.width != plannedWidth || transcript.traitCollection.textEnvironment != plannedText { replan() }
    }

    // MARK: Opening

    public func open(_ url: URL) {
        loadViewIfNeeded()
        guard let invitation = GuestInvitation(url: url) else {
            reset()
            terminal = true
            statusText = "This invitation link is invalid."
            updateComposer()
            return
        }
        if invitationID == invitation.identifier, !terminal { setActive(true); return }
        reset()
        invitationID = invitation.identifier
        statusText = "Opening invitation…"
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
                    self?.statusText = "Enter your name to start chatting."
                    self?.updateComposer()
                }
            } catch {
                guard self?.generation == generation else { return }
                self?.opening = nil
                self?.statusText = "Couldn't open the secure guest session. Try again."
                self?.retryButton.isHidden = false
                self?.view.setNeedsLayout()
            }
        }
    }

    @objc private func join() {
        guard opening == nil, let invitation = onboardingInvitation else { return }
        guard let name = GuestDisplayName.normalized(nameInput.text ?? "") else {
            statusText = "Use 1–40 letters or numbers. Spaces and . ' - _ are allowed."
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
        statusText = "Joining…"
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
                        self?.statusText = "Open an invitation for this server."
                        return
                    }
                    self?.opening = nil
                    self?.invitationID = stored.invitationID
                    self?.apply(stored)
                } else if let pending = try await vault.pendingRedemption() {
                    guard self?.generation == generation else { return }
                    guard Self.allowedStoredOrigin(pending.origin) else {
                        self?.opening = nil
                        self?.statusText = "Open an invitation for this server."
                        return
                    }
                    self?.opening = nil
                    self?.open(pending.invitationURL)
                } else { self?.opening = nil }
            } catch {
                if self?.generation == generation {
                    self?.opening = nil
                    self?.statusText = "Couldn't restore the secure guest session."
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
        botTitle = stored.session.botName
        composer.placeholder = stored.displayName.map { "Message as \($0)" } ?? "Message"
        composer.text = stored.pending?.text ?? ""
        statusText = isReadOnly ? "Read only · You can view this conversation." : "Connecting…"
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
                    let addition = await client.accept(page.messages)
                    guard self?.generation == generation, self?.terminal == false else { return }
                    self?.cursor = page.cursor
                    if !addition.isEmpty { self?.appendMessages(addition) }
                    if Task.isCancelled { return }
                    if self?.noticeUntil.map({ $0 > Date() }) != true {
                        self?.statusText = self?.isReadOnly == true ? "Read only · You can view this conversation." :
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

    private func send(_ option: String? = nil) {
        guard sending == nil, active, !terminal, !isReadOnly, let client, var stored = record else { return }
        let text = (option ?? composer.text).trimmingCharacters(in: .whitespacesAndNewlines)
        guard stored.pending != nil || !text.isEmpty else { return }
        guard text.utf16.count <= 4_000 else { showNotice("Use 4,000 characters or fewer."); return }
        if stored.pending == nil { stored.pending = GuestPendingMessage(localId: UUID().uuidString, text: text) }
        guard let pending = stored.pending else { return }
        record = stored
        let generation = self.generation
        let vault = self.vault
        let sentFromComposer = option == nil
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
                if sentFromComposer { self?.composer.text = "" }
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
        statusText = "Sending…"
        updateComposer()
    }

    private var isReadOnly: Bool { forcedReadOnly || record?.readOnlyOverride == true || record?.session.readOnly == true }

    // MARK: Drawing

    private func updateComposer() {
        let onboarding = onboardingInvitation != nil && !terminal
        for form in [onboardingTitle, onboardingSubtitle, nameField, joinButton, joinNotice] as [UIView] { form.isHidden = !onboarding }
        nameInput.isEnabled = opening == nil && redemptionName == nil
        joinButton.isEnabled = opening == nil
        transcript.isHidden = record == nil
        composer.isHidden = record == nil
        composer.showsCard = !isReadOnly
        let enabled = record != nil && !isReadOnly && !terminal && sending == nil
        composer.isEditable = enabled && record?.pending == nil
        composer.canSend = enabled
        moreGlass.isHidden = record == nil || terminal
        applyHeader()
        applyStatus()
        view.setNeedsLayout()
    }

    private func applyHeader() {
        let environment = view.traitCollection.textEnvironment
        titleLabel.attributedText = ChatTextStyles.headerTitle.string(botTitle, color: Palette.text, alignment: .center, lineBreakMode: .byTruncatingTail, in: environment)
        let subtitle = record.map { record in record.displayName.map { "Guest · \($0)" } ?? "Guest" }
        subtitleLabel.isHidden = subtitle == nil
        subtitleLabel.attributedText = subtitle.map {
            ChatTextStyles.headerSubtitle.string($0, color: Palette.textSecondary, alignment: .center, lineBreakMode: .byTruncatingTail, in: environment)
        }
        view.setNeedsLayout()
    }

    /// The status speaks where the screen is: in the composer's status row
    /// in a conversation, under the title while joining, centred otherwise.
    private func applyStatus() {
        let onboarding = onboardingInvitation != nil && !terminal
        onboardingSubtitle.string = onboarding ? statusText : ""
        messageLabel.string = record == nil && !onboarding ? statusText : ""
        messageLabel.isHidden = record != nil || onboarding
        composer.status = record == nil ? nil : GuestComposerView.Status(
            text: statusText, color: Self.tone(statusText), pulsing: statusText.hasSuffix("…") && !statusText.hasPrefix("Read only")
        )
        view.setNeedsLayout()
    }

    /// The composer status row's colours: connected, working, offline or
    /// failed.
    private static func tone(_ status: String) -> ColorToken {
        if status.hasPrefix("Guest conversation") { return Palette.statusConnected }
        if status.hasPrefix("Bot is offline") || status.hasPrefix("Read only") { return Palette.statusDisconnected }
        if status.hasSuffix("…") { return Palette.statusConnecting }
        if status.hasPrefix("Report sent") { return Palette.statusConnected }
        return Palette.statusError
    }

    private func appendMessages(_ addition: [GuestMessage]) {
        messages += addition
        transcript.accessibilityValue = GuestTranscript.text(messages, botName: record?.session.botName ?? botTitle)
        replan()
    }

    /// Plans every row off the main thread, measuring only rows whose input,
    /// width or text size changed, then shows them in one apply.
    private func replan() {
        let width = transcript.bounds.width
        let text = transcript.traitCollection.textEnvironment
        plannedWidth = width
        plannedText = text
        guard width > 0 else { return }
        let botName = record?.session.botName ?? botTitle
        let inputs = messages.map { GuestRowInput(message: $0, botName: botName, copied: $0.id == copiedMessageID) }
        let cached = rows
        planGeneration += 1
        let generation = planGeneration
        planning?.cancel()
        planning = Task { [weak self] in
            let planned = await Task.detached(priority: .userInitiated) { () -> [PlannedRow] in
                inputs.map { input in
                    if let row = cached[input.message.id], row.input == input, row.width == width, row.text == text { return row }
                    return PlannedRow(input: input, width: width, text: text, plan: GuestRowRenderer.plan(input, width: width, in: text))
                }
            }.value
            guard let self, self.planGeneration == generation else { return }
            self.rows = Dictionary(planned.map { ($0.input.message.id, $0) }, uniquingKeysWith: { first, _ in first })
            self.transcript.apply(planned.map(\.plan), width: width)
        }
    }

    private func perform(_ action: GuestRowAction) {
        switch action {
        case .copy(let id, let text):
            UIPasteboard.general.string = text
            copiedMessageID = id
            replan()
            copiedReset?.cancel()
            copiedReset = Task { [weak self] in
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled else { return }
                self?.copiedMessageID = nil
                self?.replan()
            }
        case .option(let text):
            send(text)
        }
    }

    // MARK: Errors and leaving

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
            statusText = "Use 1–40 letters or numbers. Spaces and . ' - _ are allowed."
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
            statusText = "Read only · You can view this conversation."
            updateComposer()
        default:
            statusText = record?.pending == nil ? "Connection lost. Reconnecting…" : "Message not confirmed. Reconnect to retry."
            retryButton.isHidden = false
            view.setNeedsLayout()
        }
        return false
    }

    private func terminate(_ text: String) async {
        let id = invitationID
        reset()
        let generation = self.generation
        terminal = true
        statusText = text
        updateComposer()
        if let id {
            do { try await vault.remove(invitationID: id) }
            catch {
                if self.generation == generation { statusText = "Access ended. Couldn't remove the saved guest session." }
            }
        }
    }

    private func reset() {
        generation = UUID()
        opening?.cancel(); opening = nil
        polling?.cancel(); polling = nil
        sending?.cancel(); sending = nil
        planning?.cancel(); planning = nil
        record = nil; client = nil; cursor = nil; invitationID = nil
        onboardingInvitation = nil
        redemptionName = nil
        terminal = false; forcedReadOnly = false
        noticeUntil = nil
        messages = []; rows = [:]; copiedMessageID = nil
        transcript.apply([], width: transcript.bounds.width)
        transcript.accessibilityValue = nil
        composer.text = ""; nameInput.text = ""; botTitle = "Happy"
        retryButton.isHidden = true
    }

    private func report() {
        guard let client, let session = record?.session else { return }
        let generation = self.generation
        Task { [weak self] in
            do {
                try await client.report(session: session)
                if self?.generation == generation { self?.showNotice("Report sent to the bot owner.") }
            } catch { if self?.generation == generation { self?.statusText = "Couldn't send the report. Try again." } }
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
        statusText = text
    }
}
#endif
