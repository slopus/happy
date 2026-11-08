#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A signed-in server whose session ended, in home's place: its name and
/// one button to sign in again. Nothing of the server is shown, or kept
/// (`AgentConnections.sessionEnded`).
final class ServerSignedOutView: UIView {
    private let title = UILabel()
    private let body = UILabel()
    let button = UIButton(configuration: .prominentGlass())

    init(server: String, signIn: @escaping () -> Void) {
        super.init(frame: .zero)
        backgroundColor = UIColor(Palette.surface)
        accessibilityIdentifier = "server-signed-out"
        title.text = Strings.ServerSignIn.signedOutTitle(server)
        title.font = .preferredFont(forTextStyle: .title2).withTraits(.traitBold)
        title.textColor = UIColor(Palette.text)
        title.textAlignment = .center
        title.numberOfLines = 0
        title.adjustsFontForContentSizeCategory = true
        body.text = Strings.ServerSignIn.signedOutBody
        body.font = .preferredFont(forTextStyle: .body)
        body.textColor = UIColor(Palette.textSecondary)
        body.textAlignment = .center
        body.numberOfLines = 0
        body.adjustsFontForContentSizeCategory = true
        button.configuration?.title = Strings.ServerSignIn.signIn
        button.configuration?.buttonSize = .large
        button.accessibilityIdentifier = "server-signed-out-sign-in"
        button.addAction(UIAction { _ in signIn() }, for: .primaryActionTriggered)
        let stack = UIStackView(arrangedSubviews: [title, body, button])
        stack.axis = .vertical
        stack.alignment = .fill
        stack.spacing = 16
        stack.setCustomSpacing(28, after: body)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: safeAreaLayoutGuide.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: readableContentGuide.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: readableContentGuide.trailingAnchor, constant: -16),
            button.heightAnchor.constraint(greaterThanOrEqualToConstant: 50),
        ])
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
}

private extension UIFont {
    func withTraits(_ traits: UIFontDescriptor.SymbolicTraits) -> UIFont {
        fontDescriptor.withSymbolicTraits(traits).map { UIFont(descriptor: $0, size: 0) } ?? self
    }
}
#endif
