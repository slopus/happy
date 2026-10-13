#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import HappyStore
import HappyWire
import os
import UIKit

private let logger = Logger(subsystem: "engineering.happy", category: "composer")

/// The chat's composer: AgentInput.tsx as SessionView.tsx drives it on an
/// iPhone. The card (`AgentInputCardView`) with the connection status above
/// it and the week quota and context gauge under it; both rows fade while
/// the reader is back in history.
///
/// It keeps the draft (useDraft.ts), holds picked images (useImagePicker.ts),
/// suggests commands and files for the word at the caret (`/` and `@`),
/// sends through `environment.sender`, stops the agent, and shows the
/// permission, model and effort picks: the
/// session's own (its composer state) over the agent defaults over the
/// metadata (`ComposerModes`). A pick shows at once and goes out through
/// `sessionSetAgentModes`.
final class SessionComposerView: UIView, ChatComposerView, AgentInputCardDelegate {
    weak var composerDelegate: (any ChatComposerDelegate)?

    private let environment: ChatComposerEnvironment
    private let card: AgentInputCardView
    private let statusDot = StatusDotView()
    private let statusLabel = UILabel()
    private let weekButton = UIButton(type: .custom)
    private let weekLabel = UILabel()
    private let contextButton = ContextUsageControl()

    private var state: ChatComposerState?
    private var picks = ComposerPicks()
    private var modes: ComposerModes
    private var status: ComposerStatus?
    private var vibingWord = ComposerStatus.randomVibingWord()
    private var usage: ComposerUsage?
    private var showsPreciseContext = false
    private var detailsVisible = true

    private var autosave: DraftAutosave
    private var draftSave: Task<Void, Never>?
    private var isAborting = false
    /// Stop was pressed; Stop stays hidden until the agent stops working
    /// (`stopRequested`), so a late status update can't leave it up.
    private var stopRequested = false
    private var isSending = false
    private var knownFailedAttachments: Int
    /// Picked images wait here until the outbox has its own copies.
    private let staging: ComposerAttachmentStaging
    private let images: ComposerImagePicker

    /// useActiveSuggestions: the last list and its highlighted row, kept
    /// while the query moves, shown only while there is a query.
    private let suggestionList = ComposerSuggestionListView()
    private var suggestions: (items: [ComposerSuggestion], selected: Int) = ([], -1)
    private var activeQuery: String?
    private var suggestionTask: Task<Void, Never>?
    private var isSuggestionListShown = false

    private var statusSize: CGSize = .zero
    private var weekSize: CGSize = .zero

    private static let titles = ComposerChipSet.Titles(
        permission: Strings.Composer.permissionModeTitle,
        codexPermission: Strings.Composer.codexPermissionModeTitle,
        geminiPermission: Strings.Composer.geminiPermissionModeTitle,
        model: Strings.Composer.modelTitle,
        effort: Strings.Composer.effortTitle
    )

    init(environment: ChatComposerEnvironment) {
        self.environment = environment
        let sender = environment.account.sender
        let sessionId = environment.sessionId
        let draft = (try? sender.draft(sessionId: sessionId)) ?? ""
        autosave = DraftAutosave(loaded: draft)
        knownFailedAttachments = (try? sender.failedAttachmentCount(sessionId: sessionId)) ?? 0
        staging = ComposerAttachmentStaging(filesDirectory: environment.account.filesDirectory)
        images = ComposerImagePicker(staging: staging)
        modes = ComposerModes(metadata: nil, picks: ComposerPicks(), agentDefaultOverrides: [:])
        card = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: Strings.Composer.inputPlaceholder))
        super.init(frame: .zero)

        statusDot.isUserInteractionEnabled = false
        addSubview(statusDot)
        statusLabel.isUserInteractionEnabled = false
        addSubview(statusLabel)

        card.text = draft
        card.delegate = self
        addSubview(card)
        images.host = { [weak self] in self?.hostViewController }
        images.onChange = { [weak self] in self?.applyConfiguration() }

        weekLabel.isUserInteractionEnabled = false
        weekButton.addSubview(weekLabel)
        weekButton.showsMenuAsPrimaryAction = true
        weekButton.preferredMenuElementOrder = .fixed
        addSubview(weekButton)
        contextButton.addTarget(self, action: #selector(contextTapped), for: .touchUpInside)
        addSubview(contextButton)
        suggestionList.isHidden = true
        suggestionList.onSelect = { [weak self] index in self?.selectSuggestion(index) }
        addSubview(suggestionList)

        applyConfiguration()
        applyDetails()

        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(appWillResignActive), name: UIApplication.willResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(appWillResignActive), name: UIApplication.didEnterBackgroundNotification, object: nil)
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitHorizontalSizeClass.self]) { (self: Self, _) in
            self.applyDetails()
            self.composerDelegate?.composerDidInvalidateHeight(self)
        }
        registerForTraitChanges([ZenModeTrait.self]) { (self: Self, _) in
            self.applyConfiguration()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    // MARK: ChatComposerView

    func composerHeight(fitting width: CGFloat) -> CGFloat {
        layout(width: width).size.height
    }

    var cardOffset: CGFloat {
        layout(width: bounds.width).cardOffset
    }

    func update(_ state: ChatComposerState) {
        guard state != self.state else { return }
        let previous = self.state
        let before = (composerHeight(fitting: bounds.width), cardOffset)
        self.state = state
        let record = state.session.record

        // The session's picks live in its composer state, which
        // sessionSetAgentModes and the metadata reconciler both write.
        if previous?.session.record != record,
           let values = try? environment.account.sender.composerState(sessionId: environment.sessionId).values {
            picks = ComposerPicks(values: values)
        }
        recomputeModes()
        if previous?.session.record != record, RigCatalog.isRigV1(record?.metadata) {
            applyRemoteDraft()
        }

        if let record {
            let sessionState = SessionState(record)
            if sessionState != status?.state {
                vibingWord = ComposerStatus.randomVibingWord()
            }
            status = ComposerStatus(record: record, now: Self.now, vibingWord: vibingWord)
        } else {
            status = nil
        }
        usage = ComposerUsage(
            usage: state.usage,
            usageLimits: record?.agentState?["usageLimits"],
            alwaysShowContextSize: state.session.settings.bool("alwaysShowContextSize"),
            showRemaining: state.session.settings.bool("usageLimitShowRemaining")
        )
        if !SessionComposerRules.showsAbortButton(record) {
            stopRequested = false
        }
        // Nothing to attach to: a picked image would be dropped at send.
        if !SessionComposerRules.canUseAttachments(record), !images.images.isEmpty {
            images.clear()
        }
        if previous?.delivery != state.delivery {
            checkFailedAttachments()
        }

        applyDetails()
        applyConfiguration()
        if previous == nil {
            // A draft that ends in "/co" opens on its suggestions.
            updateActiveWord()
        }
        if before != (composerHeight(fitting: bounds.width), cardOffset) {
            composerDelegate?.composerDidInvalidateHeight(self)
        }
        setNeedsLayout()
    }

    func setDetailsVisible(_ visible: Bool, animated: Bool) {
        guard visible != detailsVisible else { return }
        detailsVisible = visible
        // AnimatedFade: 180ms in, 140ms out.
        let duration = visible ? AgentInputLayout.Metrics.fadeInDuration : AgentInputLayout.Metrics.fadeOutDuration
        UIView.animate(withDuration: animated ? duration : 0, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
            self.applyDetailsAlpha()
        }
    }

    var isTextFocused: Bool { card.isTextFocused }

    func focus() {
        card.focus()
    }

    func blur() {
        card.blur()
    }

    // MARK: Layout

    private var maxContentWidth: CGFloat {
        ContentWidth.maxWidth // Tablet (HappyUI/Tablet): layout.ts maxWidth, was 800 by size class.
    }

    private func layout(width: CGFloat) -> AgentInputLayout {
        let paddingH = AgentInputLayout.paddingH(screenWidth: width)
        let maxContentWidth = self.maxContentWidth
        let innerWidth = AgentInputLayout.innerWidth(width: width, paddingH: paddingH, maxContentWidth: maxContentWidth)
        return AgentInputLayout(.init(
            width: width,
            paddingH: paddingH,
            maxContentWidth: maxContentWidth,
            statusText: status == nil ? nil : statusSize,
            card: card.layoutInput(width: innerWidth),
            usageWeek: usage?.weekPercent == nil ? nil : weekSize,
            usageContext: usage?.context == nil ? nil : contextButton.labelSize
        ))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        if let row = layout.status {
            statusDot.setLayoutFrame(row.dot)
            statusLabel.setLayoutFrame(row.text)
        }
        card.setLayoutFrame(layout.card)
        if let week = layout.usage?.week {
            // The menu trigger is padded out 10 and pulled back in.
            let slop = AgentInputLayout.Metrics.usageWeekSlop
            weekButton.setLayoutFrame(week.insetBy(dx: -slop, dy: -slop))
            weekLabel.frame = CGRect(x: slop, y: slop, width: week.width, height: week.height)
        }
        if let context = layout.usage?.context, let text = layout.usage?.contextText, let gauge = layout.usage?.gauge {
            contextButton.setLayoutFrame(context)
            contextButton.place(
                label: text.offsetBy(dx: -context.minX, dy: -context.minY),
                gauge: gauge.offsetBy(dx: -context.minX, dy: -context.minY)
            )
        }
        if isSuggestionListShown {
            // Bounds and centre: the list may be mid-way through its rise.
            let frame = PixelGrid.snap(
                layout.autocomplete(rows: suggestionList.suggestions.count, border: suggestionList.border),
                scale: max(1, traitCollection.displayScale)
            )
            suggestionList.bounds = CGRect(origin: .zero, size: frame.size)
            suggestionList.center = CGPoint(x: frame.midX, y: frame.midY)
        }
    }

    /// The suggestion list hangs above the composer, outside its bounds.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        super.point(inside: point, with: event)
            || (isSuggestionListShown && suggestionList.frame.contains(point))
    }

    override func willMove(toWindow newWindow: UIWindow?) {
        super.willMove(toWindow: newWindow)
        if newWindow == nil {
            flushDraft()
        }
    }

    // MARK: Modes

    private func recomputeModes() {
        modes = ComposerModes(
            metadata: state?.session.record?.metadata,
            picks: picks,
            agentDefaultOverrides: state?.session.settings.agentDefaultOverrides ?? [:]
        )
    }

    func agentInputCard(_ card: AgentInputCardView, didSelect key: String, in chip: AgentInputChip) {
        guard let record = state?.session.record else { return }
        let patch: SessionAgentModesPatch
        switch chip {
        case .permission:
            guard let mode = modes.availableModes.first(where: { $0.key == key }) else { return }
            patch = ComposerModes.patch(selectingPermission: mode)
        case .model:
            guard let model = modes.availableModels.first(where: { $0.key == key }) else { return }
            patch = ComposerModes.patch(
                selectingModel: model,
                flavor: record.metadata?["flavor"]?.stringValue,
                metadata: record.metadata,
                sessionEffortLevel: picks.effortLevel
            )
        case .effort:
            guard let level = modes.availableEffortLevels.first(where: { $0.key == key }) else { return }
            patch = ComposerModes.patch(selectingEffort: level)
        }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        // Shown at once; the op writes the composer state, then the metadata.
        picks = picks.applying(patch)
        recomputeModes()
        applyConfiguration()
        let account = environment.account
        let sessionId = environment.sessionId
        Task {
            do {
                try await account.actions.sessionSetAgentModes(sessionId: sessionId, patch: patch, transport: account.realtime)
            } catch {
                logger.error("sessionSetAgentModes failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    // MARK: Card

    private func applyConfiguration() {
        let record = state?.session.record
        let chips = ComposerChipSet(modes: modes, record: record, titles: Self.titles)
        let canAttach = SessionComposerRules.canUseAttachments(record)
        let primary = AgentInputPrimaryAction.resolve(
            hasComposerContent: hasComposerContent,
            isSendBlocked: SessionComposerRules.isSendBlocked(record),
            isSendDisabled: false,
            showAbortButton: SessionComposerRules.showsAbortButton(record),
            canAbort: SessionComposerRules.canAbort(record) && !stopRequested
        )
        var configuration = card.configuration
        configuration.permission = chips.permission.map(Self.chip)
        configuration.model = Self.chip(chips.model)
        configuration.effort = chips.effort.map(Self.chip)
        configuration.primaryAction = primary
        configuration.isPrimaryBusy = isAborting
        configuration.showsAdd = canAttach
        // localSettings.zenMode, as SessionView passes it.
        configuration.zenMode = traitCollection.isZenMode
        configuration.attachments = canAttach
            ? images.images.map { AgentInputAttachmentPreview(id: $0.id, fileURL: $0.attachment.fileURL) }
            : []
        card.configuration = configuration
    }

    /// Text or a picked image (`hasComposerContent`), read live.
    private var hasComposerContent: Bool {
        Self.hasContent(card.text) || !images.images.isEmpty
    }

    private static func chip(_ chip: ComposerChipSet.Chip) -> AgentInputChipConfiguration {
        AgentInputChipConfiguration(
            content: chip.label.map { .label($0) } ?? .icon(.ionicons("shield-outline")),
            accessibilityLabel: chip.accessibilityLabel,
            menu: chip.sections.map { sections in
                AgentInputMenu(
                    sections: sections.map { section in
                        AgentInputMenu.Section(
                            title: section.title,
                            options: section.options.map { .init(key: $0.key, label: $0.label, isDisabled: $0.isDisabled) }
                        )
                    },
                    selectedKey: chip.selectedKey
                )
            }
        )
    }

    private static func hasContent(_ text: String) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func agentInputCardDidChangeText(_ card: AgentInputCardView) {
        draftChanged(card.text)
        applyDeferredRemoteDraft()
        applyConfiguration()
        updateActiveWord()
    }

    func agentInputCardDidChangeSelection(_ card: AgentInputCardView) {
        applyDeferredRemoteDraft()
        updateActiveWord()
    }

    /// Return picks the highlighted suggestion (or the first) instead of
    /// starting a line.
    func agentInputCardShouldInsertNewline(_ card: AgentInputCardView) -> Bool {
        guard activeQuery != nil, !suggestions.items.isEmpty else { return true }
        selectSuggestion(max(0, suggestions.selected))
        return false
    }

    func agentInputCardDidChangeFocus(_ card: AgentInputCardView) {
        if !card.isTextFocused {
            flushDraft()
        }
        applyDeferredRemoteDraft()
        composerDelegate?.composerDidChangeFocus(self)
    }

    func agentInputCardDidInvalidateHeight(_ card: AgentInputCardView) {
        UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
            self.composerDelegate?.composerDidInvalidateHeight(self)
        }
    }

    /// Stop and send share the button; which one fires comes from the live
    /// text, not the configuration, which can lag a fast type-then-tap.
    func agentInputCardDidPressPrimary(_ card: AgentInputCardView) {
        if !hasComposerContent, card.configuration.primaryAction == .stop {
            abort()
            return
        }
        sendPressed()
    }

    func agentInputCardDidPressAdd(_ card: AgentInputCardView) {
        images.attach()
    }

    func agentInputCard(_ card: AgentInputCardView, didRemoveAttachment id: String) {
        images.remove(id: id)
    }

    // MARK: Send

    private func sendPressed() {
        let record = state?.session.record
        if SessionComposerRules.isSendBlocked(record) {
            // The agent refuses steering while it works.
            guard Self.hasContent(card.text), !isSending else { return }
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            card.shake()
            return
        }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        guard hasComposerContent else { return }
        stopRequested = false
        send()
    }

    private func send() {
        guard !isSending else { return }
        let text = card.text
        let sessionId = environment.sessionId
        let picked = images.images
        let message = OutgoingMessage(text: text, attachments: picked.map(\.attachment))
        // sync.ts: images the agent can't take are named before anything
        // goes; with nothing else to send, nothing does.
        if !picked.isEmpty,
           let plan = try? environment.account.sender.attachmentPlan(message, sessionId: sessionId),
           plan.shouldShowUnsupportedAlert {
            alert(Strings.ImageUpload.notSupportedTitle, Strings.ImageUpload.notSupportedMessage)
            if !plan.shouldSendText || (!Self.hasContent(text) && plan.accepted.isEmpty) {
                return
            }
        }
        isSending = true
        let sender = environment.sender
        // The outbox copies the staged files; they outlive a composer
        // closed mid-send.
        let staging = staging
        Task { [weak self] in
            do {
                let localId = try await sender.send(message, sessionId: sessionId)
                withExtendedLifetime(staging) {}
                guard let self else { return }
                self.isSending = false
                // Only clear what was sent: typing may have gone on.
                if self.card.text == text {
                    self.clearDraft(stored: !RigCatalog.isRigV1(self.state?.session.record?.metadata))
                    self.card.text = ""
                }
                self.images.removeSent(picked.map(\.id))
                self.applyConfiguration()
                self.composerDelegate?.composer(self, didSend: localId)
            } catch {
                self?.isSending = false
                logger.error("send failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    // MARK: Stop

    private func abort() {
        guard !isAborting else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.error)
        stopRequested = true
        isAborting = true
        applyConfiguration()
        let controls = environment.controls
        let sessionId = environment.sessionId
        let start = ContinuousClock.now
        Task { [weak self] in
            do {
                try await controls.abort(sessionId: sessionId)
                // At least 300ms of spinner.
                let elapsed = ContinuousClock.now - start
                if elapsed < .milliseconds(300) {
                    try? await Task.sleep(for: .milliseconds(300) - elapsed)
                }
            } catch {
                self?.stopRequested = false
                self?.card.shakePrimary()
                logger.error("abort failed: \(String(describing: error), privacy: .public)")
            }
            self?.isAborting = false
            self?.applyConfiguration()
        }
    }

    // MARK: Draft

    private func draftChanged(_ text: String) {
        draftSave?.cancel()
        draftSave = nil
        let synced = RigCatalog.isRigV1(state?.session.record?.metadata)
        switch autosave.textChanged(text, synced: synced) {
        case .none:
            break
        case .saveNow(let value):
            saveDraft(value)
        case .saveLater(let value):
            draftSave = Task { [weak self] in
                try? await Task.sleep(for: DraftAutosave.interval)
                guard !Task.isCancelled, let self else { return }
                self.autosave.saved(value)
                self.saveDraft(value)
            }
        }
    }

    private func flushDraft() {
        draftSave?.cancel()
        draftSave = nil
        if let value = autosave.flush() {
            saveDraft(value)
        }
    }

    /// `stored`: also delete the stored draft. A Happy Agent session's
    /// send already cleared it, unless writing began during the send.
    private func clearDraft(stored: Bool) {
        draftSave?.cancel()
        draftSave = nil
        autosave.clear()
        if stored {
            saveDraft("")
        }
    }

    /// useDraft's store subscription: another device edited a Happy Agent
    /// session's draft. It replaces the text, caret at the end, but not
    /// under an input method's composition, which it would cut off.
    private func applyRemoteDraft() {
        guard let draft = try? environment.account.sender.draft(sessionId: environment.sessionId),
              let remote = autosave.storeChanged(draft, composing: card.hasMarkedText) else { return }
        draftSave?.cancel()
        draftSave = nil
        card.text = remote
    }

    /// The composition a remote edit waited for has ended (committed,
    /// cancelled or blurred). The text change runs first, so a committed
    /// edit is saved before the store is read and stays.
    private func applyDeferredRemoteDraft() {
        guard autosave.remoteDeferred, !card.hasMarkedText else { return }
        applyRemoteDraft()
    }

    private func saveDraft(_ text: String) {
        try? environment.account.sender.saveDraft(sessionId: environment.sessionId, text: text)
    }

    @objc private func appWillResignActive() {
        flushDraft()
    }

    // MARK: Autocomplete

    /// useActiveWord and useActiveSuggestions: the prefixed word at the
    /// caret is the query; its suggestions replace the list when they
    /// arrive (a newer query drops older answers).
    private func updateActiveWord() {
        let query = ComposerAutocomplete.findActiveWord(
            card.text, selection: card.selectedRange, prefixes: ComposerAutocomplete.chatPrefixes
        )?.activeWord
        guard query != activeQuery else { return }
        activeQuery = query
        suggestionTask?.cancel()
        suggestionTask = nil
        applySuggestions()
        guard let query else { return }
        let metadata = state?.session.record?.metadata
        let sessionId = environment.sessionId
        let actions = environment.account.actions
        suggestionTask = Task { [weak self] in
            let results: [ComposerSuggestion]
            if query.hasPrefix("/") {
                results = ComposerCommands.suggestions(query, metadata: metadata)
            } else if query.hasPrefix("@") {
                results = await ComposerFileIndex.shared.suggestions(query, sessionId: sessionId) { id in
                    try? await actions.sessionRipgrep(sessionId: id, args: ComposerFileIndex.ripgrepArguments)
                }
            } else {
                results = []
            }
            guard !Task.isCancelled, let self, self.activeQuery == query else { return }
            let selected = ComposerAutocomplete.selection(
                previous: self.suggestions.selected, previousCount: self.suggestions.items.count, count: results.count
            )
            self.suggestions = (results, selected)
            self.applySuggestions()
        }
    }

    private func applySuggestions() {
        let visible = activeQuery == nil ? [] : suggestions.items
        guard !visible.isEmpty else {
            guard isSuggestionListShown else { return }
            isSuggestionListShown = false
            suggestionList.animateOut { [weak self] in
                guard let self, !self.isSuggestionListShown else { return }
                self.suggestionList.isHidden = true
            }
            return
        }
        suggestionList.set(visible, selected: suggestions.selected)
        if !isSuggestionListShown {
            isSuggestionListShown = true
            suggestionList.isHidden = false
            setNeedsLayout()
            layoutIfNeeded()
            suggestionList.animateIn()
        } else {
            setNeedsLayout()
        }
    }

    /// `handleSuggestionSelect`: the whole active word becomes the pick and
    /// a space, the caret after it.
    private func selectSuggestion(_ index: Int) {
        guard activeQuery != nil, index < suggestions.items.count else { return }
        let result = ComposerAutocomplete.applySuggestion(
            card.text,
            selection: card.selectedRange,
            suggestion: suggestions.items[index].text,
            prefixes: ComposerAutocomplete.chatPrefixes,
            addSpace: true
        )
        card.setText(result.text, selection: NSRange(location: result.cursor, length: 0))
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    // MARK: Attachments

    /// A failed upload is only known once the outbox gives up on it; the
    /// alert counts the files that failed since the last look.
    private func checkFailedAttachments() {
        guard let count = try? environment.account.sender.failedAttachmentCount(sessionId: environment.sessionId) else { return }
        if count > knownFailedAttachments {
            alert(Strings.ImageUpload.uploadFailedTitle, Strings.ImageUpload.uploadFailedMessage(count - knownFailedAttachments))
        }
        knownFailedAttachments = count
    }

    private func alert(_ title: String, _ message: String) {
        guard let host = hostViewController else { return }
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Common.ok, style: .cancel))
        host.present(alert, animated: true)
    }

    private var hostViewController: UIViewController? {
        var responder: UIResponder? = self
        while let next = responder?.next {
            if let controller = next as? UIViewController {
                return controller
            }
            responder = next
        }
        return nil
    }

    // MARK: Status and usage

    private func applyDetails() {
        let style = TextStyles.composerStatus
        if let status {
            let color = UIColor(Self.color(status.tone))
            statusLabel.attributedText = style.attributedString(Self.text(status.text), color: color, lineBreakMode: .byTruncatingTail)
            statusSize = statusLabel.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
            statusDot.backgroundColor = color
            statusDot.isPulsing = status.isPulsing
        }
        statusDot.isHidden = status == nil
        statusLabel.isHidden = status == nil

        if let percent = usage?.weekPercent {
            weekLabel.attributedText = style.attributedString(Strings.Composer.percentWeek(percent), color: UIColor(Palette.textSecondary))
            weekSize = weekLabel.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
        }
        weekButton.isHidden = usage?.weekPercent == nil
        weekButton.menu = usage.flatMap(Self.usageMenu)
        weekButton.isUserInteractionEnabled = weekButton.menu != nil

        if let context = usage?.context {
            let text = showsPreciseContext
                ? Strings.Composer.detailContext(
                    used: ComposerUsage.formatTokenCount(context.used),
                    total: ComposerUsage.formatTokenCount(context.total)
                )
                : Strings.Composer.percentContext(context.percent)
            let color: ColorToken = context.level == .critical ? Palette.warningCritical : Palette.textSecondary
            contextButton.configure(text: style.attributedString(text, color: UIColor(color)), percent: context.percent)
        }
        contextButton.isHidden = usage?.context == nil
        applyDetailsAlpha()
    }

    private func applyDetailsAlpha() {
        let alpha: CGFloat = detailsVisible ? 1 : 0
        for view in [statusDot, statusLabel, weekButton, contextButton] as [UIView] {
            view.alpha = alpha
        }
    }

    @objc private func contextTapped() {
        // Swaps the percent for the exact token counts.
        showsPreciseContext.toggle()
        applyDetails()
        setNeedsLayout()
    }

    /// The week text's menu: Session and Week, each with when it resets.
    private static func usageMenu(_ usage: ComposerUsage) -> UIMenu? {
        guard !usage.menu.isEmpty else { return nil }
        return UIMenu(children: usage.menu.map { row in
            let label = row.kind == .session ? Strings.Composer.usageSession : Strings.Composer.usageWeek
            let action = UIAction(title: "\(label) · \(row.percent)%") { _ in }
            if let resetsAt = row.resetsAt {
                action.subtitle = Strings.Composer.usageResets(resetTime(resetsAt))
            }
            return action
        })
    }

    /// sessionStatusBar.ts `formatUsageLimitResetTime`: a clock time within
    /// 22 hours, a date beyond.
    private static func resetTime(_ ms: Double) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate(ms - Double(now) < 22 * 3_600_000 ? "hhmm" : "MMMd")
        return formatter.string(from: date)
    }

    private static func color(_ tone: ComposerStatus.Tone) -> ColorToken {
        switch tone {
        case .disconnected: Palette.sessionStatusDisconnected
        case .attention: Palette.sessionStatusAttention
        case .thinking: Palette.sessionStatusThinking
        case .online: Palette.sessionStatusOnline
        }
    }

    private static func text(_ text: ComposerStatus.Text) -> String {
        switch text {
        case .lastSeen(let lastSeen): Strings.Composer.lastSeen(Self.lastSeen(lastSeen))
        case .permissionRequired: Strings.Composer.permissionRequired
        case .inputRequired: Strings.Composer.inputRequired
        case .thinking(let word): word
        case .online: Strings.Composer.online
        }
    }

    private static func lastSeen(_ lastSeen: ComposerStatus.LastSeen) -> String {
        switch lastSeen {
        case .justNow: return Strings.Composer.justNow
        case .minutes(let count): return Strings.Composer.minutesAgo(count)
        case .hours(let count): return Strings.Composer.hoursAgo(count)
        case .days(let count): return Strings.Composer.daysAgo(count)
        case .date(let ms):
            let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
            let formatter = DateFormatter()
            let sameYear = Calendar.current.component(.year, from: date) == Calendar.current.component(.year, from: Date())
            formatter.setLocalizedDateFormatFromTemplate(sameYear ? "MMMd" : "yMMMd")
            return formatter.string(from: date)
        }
    }

    private static var now: Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }
}

/// The context percent and its gauge: one tap target, slopped out
/// (top 12, left 10, bottom 14, right 14).
final class ContextUsageControl: UIControl {
    private let label = UILabel()
    private let gauge = ContextGaugeView()
    private(set) var labelSize: CGSize = .zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        label.isUserInteractionEnabled = false
        addSubview(label)
        gauge.isUserInteractionEnabled = false
        addSubview(gauge)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func configure(text: NSAttributedString, percent: Int) {
        label.attributedText = text
        labelSize = label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
        gauge.percent = Double(percent)
        accessibilityLabel = text.string
    }

    func place(label frame: CGRect, gauge gaugeFrame: CGRect) {
        label.frame = frame
        gauge.frame = gaugeFrame
    }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.7 : 1 }
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        let slop = AgentInputLayout.Metrics.usageContextSlop
        return CGRect(
            x: -slop.left,
            y: -slop.top,
            width: bounds.width + slop.left + slop.right,
            height: bounds.height + slop.top + slop.bottom
        ).contains(point)
    }
}

/// ContextGaugeIcon: a 14pt ring that fills clockwise from the top and
/// darkens as the context fills.
final class ContextGaugeView: UIView {
    var percent: Double = 0 {
        didSet { applyProgress() }
    }

    private let track = CAShapeLayer()
    private let progress = CAShapeLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        for ring in [track, progress] {
            ring.fillColor = nil
            ring.lineWidth = ContextGauge.strokeWidth
            layer.addSublayer(ring)
        }
        progress.lineCap = .round
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.applyColors()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let radius = (min(bounds.width, bounds.height) - ContextGauge.strokeWidth) / 2
        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        let path = UIBezierPath(arcCenter: center, radius: radius, startAngle: -.pi / 2, endAngle: 3 * .pi / 2, clockwise: true).cgPath
        track.path = path
        progress.path = path
    }

    private func applyProgress() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        progress.strokeEnd = min(100, max(0, percent)) / 100
        CATransaction.commit()
        applyColors()
    }

    private func applyColors() {
        let dark = traitCollection.userInterfaceStyle == .dark
        let intensity = ContextGauge.intensity(percent: percent)
        track.strokeColor = UIColor(Palette.divider).resolvedColor(with: traitCollection).cgColor
        progress.strokeColor = UIColor(white: dark ? 1 : 0, alpha: intensity).cgColor
    }
}
#endif
