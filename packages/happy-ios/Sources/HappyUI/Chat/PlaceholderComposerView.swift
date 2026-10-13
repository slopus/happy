#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// The composer the chat ships until the real one replaces it in
/// `ChatComposerFactory`: a text view that grows to five lines and a send
/// button, sending through `ChatSending`. While the agent is working and
/// the text is empty the button stops it instead. The draft is kept in the
/// account's store like happy-app's.
final class PlaceholderComposerView: UIView, ChatComposerView, UITextViewDelegate {
    weak var composerDelegate: (any ChatComposerDelegate)?

    private let environment: ChatComposerEnvironment
    private let card = UIView()
    private let textView = UITextView()
    private let placeholder = UILabel()
    private let sendButton = UIButton(type: .custom)
    private var state: ChatComposerState?
    private var sending = false
    private var draftSave: Task<Void, Never>?
    private var measured: (width: CGFloat, text: String, height: CGFloat)?

    private let style = ChatTextStyles.composerText

    init(environment: ChatComposerEnvironment) {
        self.environment = environment
        super.init(frame: .zero)

        card.backgroundColor = UIColor(Palette.inputBackground)
        card.layer.cornerRadius = ComposerPlaceholderLayout.Metrics.radius
        card.layer.cornerCurve = .continuous
        addSubview(card)

        textView.backgroundColor = .clear
        textView.textContainerInset = .zero
        textView.textContainer.lineFragmentPadding = 0
        textView.typingAttributes = style.attributes(color: UIColor(Palette.inputText))
        textView.font = style.font
        textView.textColor = UIColor(Palette.inputText)
        textView.delegate = self
        textView.isScrollEnabled = false
        textView.accessibilityLabel = Strings.Chat.inputPlaceholder
        card.addSubview(textView)

        placeholder.attributedText = style.string(Strings.Chat.inputPlaceholder, color: Palette.inputPlaceholder, lineBreakMode: .byTruncatingTail)
        placeholder.isAccessibilityElement = false
        card.addSubview(placeholder)

        sendButton.backgroundColor = UIColor(Palette.text)
        sendButton.tintColor = UIColor(Palette.surface)
        sendButton.layer.cornerRadius = ComposerPlaceholderLayout.Metrics.buttonSize / 2
        sendButton.addTarget(self, action: #selector(sendTapped), for: .touchUpInside)
        card.addSubview(sendButton)

        if let draft = try? environment.account.sender.draft(sessionId: environment.sessionId), !draft.isEmpty {
            textView.text = draft
        }
        updateControls()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.textView.typingAttributes = self.style.attributes(color: UIColor(Palette.inputText))
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

    var cardOffset: CGFloat { ComposerPlaceholderLayout.Metrics.marginTop }

    func update(_ state: ChatComposerState) {
        guard state != self.state else { return }
        self.state = state
        updateControls()
    }

    func setDetailsVisible(_ visible: Bool, animated: Bool) {
        // No status rows above the card yet.
    }

    var isTextFocused: Bool { textView.isFirstResponder }

    func focus() {
        textView.becomeFirstResponder()
    }

    func blur() {
        textView.resignFirstResponder()
    }

    // MARK: Layout

    private func layout(width: CGFloat) -> ComposerPlaceholderLayout {
        let text = textView.text ?? ""
        let height: CGFloat
        if let measured, measured.width == width, measured.text == text {
            height = measured.height
        } else {
            let textWidth = ComposerPlaceholderLayout.textWidth(for: width)
            height = ceil(textView.sizeThatFits(CGSize(width: textWidth, height: .greatestFiniteMagnitude)).height)
            measured = (width, text, height)
        }
        return ComposerPlaceholderLayout(width: width, textHeight: height, lineHeight: style.lineHeightValue)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        card.setLayoutFrame(layout.card)
        let text = layout.text.offsetBy(dx: -layout.card.minX, dy: -layout.card.minY)
        textView.setLayoutFrame(text)
        placeholder.setLayoutFrame(CGRect(x: text.minX, y: text.minY, width: text.width, height: style.lineHeightValue))
        sendButton.setLayoutFrame(layout.sendButton.offsetBy(dx: -layout.card.minX, dy: -layout.card.minY))
        if textView.isScrollEnabled != layout.textScrolls {
            textView.isScrollEnabled = layout.textScrolls
        }
    }

    // MARK: Text

    func textViewDidChange(_ textView: UITextView) {
        let before = bounds.width > 0 ? composerHeight(fitting: bounds.width) : 0
        measured = nil
        let after = bounds.width > 0 ? composerHeight(fitting: bounds.width) : 0
        updateControls()
        saveDraftSoon()
        if before != after {
            UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
                self.composerDelegate?.composerDidInvalidateHeight(self)
            }
        } else {
            setNeedsLayout()
        }
    }

    func textViewDidBeginEditing(_ textView: UITextView) {
        composerDelegate?.composerDidChangeFocus(self)
    }

    func textViewDidEndEditing(_ textView: UITextView) {
        composerDelegate?.composerDidChangeFocus(self)
    }

    private var trimmedText: String {
        (textView.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Send when there is text; stop when the agent is working and there
    /// is nothing to send.
    private var stops: Bool {
        trimmedText.isEmpty && (state?.session.thinking ?? false)
    }

    private func updateControls() {
        placeholder.isHidden = !(textView.text ?? "").isEmpty
        let icon: Icon = stops ? .octicons("stop") : .octicons("arrow-up")
        sendButton.setImage(.icon(icon, size: stops ? 14 : 16), for: .normal)
        sendButton.accessibilityLabel = stops ? "Stop" : "Send"
        let enabled = !sending && (stops || !trimmedText.isEmpty)
        sendButton.isEnabled = enabled
        sendButton.alpha = enabled ? 1 : 0.3
    }

    private func saveDraftSoon() {
        draftSave?.cancel()
        let sender = environment.account.sender
        let sessionId = environment.sessionId
        let text = textView.text ?? ""
        draftSave = Task {
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            try? sender.saveDraft(sessionId: sessionId, text: text)
        }
    }

    @objc private func sendTapped() {
        if stops {
            let controls = environment.controls
            let sessionId = environment.sessionId
            Task { try? await controls.abort(sessionId: sessionId) }
            return
        }
        let text = trimmedText
        guard !text.isEmpty, !sending else { return }
        sending = true
        updateControls()
        let sender = environment.sender
        let sessionId = environment.sessionId
        Task { [weak self] in
            do {
                let localId = try await sender.send(OutgoingMessage(text: text), sessionId: sessionId)
                guard let self else { return }
                self.sending = false
                // Only clear what was sent: typing may have continued.
                if self.trimmedText == text {
                    self.textView.text = ""
                    self.textViewDidChange(self.textView)
                }
                self.updateControls()
                self.composerDelegate?.composer(self, didSend: localId)
            } catch {
                self?.sending = false
                self?.updateControls()
            }
        }
    }
}
#endif
