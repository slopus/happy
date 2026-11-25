#if canImport(UIKit)
import HappyLayout
import UIKit

/// Sign in again's page (`AccountSignInLayout`): a settings card holding
/// the account's name, the state's heading, the code, the paste field or the
/// computer's words, and the waiting line; three buttons under it. What a
/// state shows is swapped in place, cross-fading; nothing moves.
final class AccountSignInView: UIView {
    struct Button {
        var title: String
        var prominent = false
        var id: String
        var enabled = true
        var action: () -> Void
    }

    struct State {
        var heading: String
        var failed = false
        var code: String?
        var message: String?
        var asksCode = false
        var waiting = false
        var status: String?
        /// Three: nil leaves its place empty.
        var buttons: [Button?]
    }

    let card = UIView()
    let name = StyledLabel(style: TextStyles.inferenceSignInName, color: Palette.settingsSecondary, lines: 1, alignment: .center)
    let heading = StyledLabel(style: TextStyles.inferenceSignInHeading, color: Palette.settingsText, lines: Int(AccountSignInLayout.Metrics.headingLines), alignment: .center)
    let code = StyledLabel(style: TextStyles.inferenceSignInCode, color: Palette.settingsText, lines: 1, alignment: .center)
    let message = StyledLabel(style: TextStyles.inferenceSignInMessage, color: Palette.settingsSecondary, lines: Int(AccountSignInLayout.Metrics.messageLines), alignment: .center)
    let fieldBackground = UIView()
    let field = UITextField()
    let spinner = UIActivityIndicatorView(style: .medium)
    let status = StyledLabel(style: TextStyles.inferenceSignInStatus, color: Palette.settingsSecondary, lines: 1, alignment: .center)
    let buttons = (0..<3).map { _ in RoundButton(title: "", size: .large) }
    private var actions: [(() -> Void)?] = [nil, nil, nil]

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.settingsGround)
        card.backgroundColor = UIColor(Palette.settingsCard)
        card.layer.cornerRadius = AccountSignInLayout.Metrics.radius
        card.layer.cornerCurve = .continuous
        for label in [heading, message, status] { label.lineBreakMode = .byTruncatingTail }
        name.lineBreakMode = .byTruncatingTail
        code.adjustsFontSizeToFitWidth = true
        code.minimumScaleFactor = 0.5
        code.accessibilityIdentifier = "account-sign-in-code"
        fieldBackground.backgroundColor = UIColor(Palette.surfaceHigh)
        fieldBackground.layer.cornerRadius = ServerFormLayout.Metrics.fieldCornerRadius
        fieldBackground.layer.cornerCurve = .continuous
        field.font = TextStyles.serverInput.font
        field.textColor = UIColor(Palette.inputText)
        field.attributedPlaceholder = NSAttributedString(string: Strings.ProviderAccounts.codePlaceholder,
                                                         attributes: [.foregroundColor: UIColor(Palette.inputPlaceholder), .font: TextStyles.serverInput.font])
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.returnKeyType = .go
        field.accessibilityIdentifier = "account-sign-in-field"
        spinner.color = UIColor(Palette.settingsSecondary)
        spinner.hidesWhenStopped = false
        addSubview(card)
        for view in [name, heading, code, message, fieldBackground, field, spinner, status] as [UIView] { addSubview(view) }
        for (index, button) in buttons.enumerated() {
            button.onTap = { [weak self] in self?.actions[index]?() }
            addSubview(button)
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    var layout: AccountSignInLayout {
        AccountSignInLayout(.init(
            width: bounds.width, safeArea: LayoutInsets(safeAreaInsets),
            nameLine: name.style.lineHeightValue, headingLine: heading.style.lineHeightValue, codeLine: code.style.lineHeightValue,
            messageLine: message.style.lineHeightValue, statusLine: status.style.lineHeightValue,
            button: RoundButtonMetrics.of(.large).height
        ))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout
        card.setLayoutFrame(layout.card)
        name.setLayoutFrame(layout.name)
        heading.setLayoutFrame(layout.heading)
        code.setLayoutFrame(layout.middle)
        message.setLayoutFrame(layout.middle)
        fieldBackground.setLayoutFrame(layout.field)
        field.setLayoutFrame(layout.field.insetBy(dx: ServerFormLayout.Metrics.fieldPaddingHorizontal, dy: 0))
        spinner.setLayoutFrame(layout.spinner)
        status.setLayoutFrame(layout.status)
        for (button, frame) in zip(buttons, layout.buttons) { button.setLayoutFrame(frame) }
    }

    /// Where each place is: for the tests, the same in every state.
    var places: [CGRect] {
        layoutIfNeeded()
        return [card, name, heading, code, fieldBackground, spinner, status].map(\.frame) + buttons.map(\.frame)
    }

    func show(_ state: State, animated: Bool) {
        let fill = { [self] in
            heading.string = state.heading
            heading.color = state.failed ? Palette.settingsDestructive : Palette.settingsText
            heading.accessibilityIdentifier = state.failed ? "account-sign-in-failure" : nil
            code.string = state.code ?? ""
            code.isHidden = state.code == nil
            message.string = state.message ?? ""
            message.isHidden = state.message == nil
            field.isHidden = !state.asksCode
            fieldBackground.isHidden = !state.asksCode
            if !state.asksCode { field.text = nil; field.resignFirstResponder() }
            spinner.alpha = state.waiting ? 1 : 0
            if state.waiting { spinner.startAnimating() } else { spinner.stopAnimating() }
            status.string = state.status ?? ""
            for (index, (button, slot)) in zip(buttons, state.buttons).enumerated() {
                actions[index] = slot?.action
                button.isHidden = slot == nil
                button.accessibilityIdentifier = slot?.id
                guard let slot else { continue }
                button.title = slot.title
                button.glass = slot.prominent ? .prominent : .regular
                button.isEnabled = slot.enabled
            }
        }
        guard animated, window != nil else { return fill() }
        UIView.transition(with: self, duration: 0.2, options: [.transitionCrossDissolve, .allowUserInteraction], animations: fill)
    }

    /// Only what waits changes: "Checking…" while a pasted code is read.
    func showStatus(_ text: String?) {
        status.string = text ?? ""
    }
}
#endif
