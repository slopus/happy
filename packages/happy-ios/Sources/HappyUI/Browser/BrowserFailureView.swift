#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// The page the browser shows instead of one that didn't open, as Safari
/// and Telegram show theirs: a glyph, what went wrong, a sentence on what
/// to do, and Try Again. It covers the page whole, header area included,
/// on the screen's own surface, so the header floats over it as it does
/// over a page.
@MainActor
final class BrowserFailureView: UIView {
    private let icon = UIImageView()
    private let title = StyledLabel(style: TextStyles.browserFailureTitle, color: Palette.text, alignment: .center)
    private let message = StyledLabel(style: TextStyles.browserFailureMessage, color: Palette.textSecondary, alignment: .center)
    let retry = UIButton(configuration: .glass())
    var retried: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.surface)
        accessibilityIdentifier = "browser-error"
        icon.tintColor = UIColor(Palette.browserFailureIcon)
        icon.contentMode = .center
        icon.isAccessibilityElement = false
        title.accessibilityIdentifier = "browser-error-title"
        title.accessibilityTraits = .header
        message.accessibilityIdentifier = "browser-error-message"
        var configuration = UIButton.Configuration.glass()
        configuration.title = Strings.Browser.tryAgain
        configuration.buttonSize = .large
        configuration.cornerStyle = .capsule
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 24, bottom: 12, trailing: 24)
        configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = LegacyFonts.font(.semiBold, size: 17)
            return attributes
        }
        retry.configuration = configuration
        retry.accessibilityIdentifier = "browser-retry"
        retry.addAction(UIAction { [weak self] _ in self?.retried?() }, for: .primaryActionTriggered)
        for view in [icon, title, message, retry] { addSubview(view) }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// What it says, as the error page's title and message read (tests).
    var shownTitle: String { title.string }
    var shownMessage: String { message.string }

    func show(_ problem: BrowserProblem, computer: String, host: String?) {
        let words = Strings.Browser.failure(problem, computer: computer, host: host)
        title.string = words.title
        message.string = words.message
        icon.image = .icon(Self.glyph(problem), size: BrowserMetrics.failureIcon)
        setNeedsLayout()
    }

    static func glyph(_ problem: BrowserProblem) -> Icon {
        switch problem {
        case .noNetwork, .computerUnreachable: .ionicons("cloud-offline-outline")
        case .unavailable, .liveUnavailable: .ionicons("laptop-outline")
        case .hostNotFound: .ionicons("globe-outline")
        case .serverNotResponding: .ionicons("server-outline")
        case .timedOut: .ionicons("time-outline")
        case .insecure, .signInRequired: .ionicons("lock-closed-outline")
        case .tunnelsBlocked: .ionicons("shield-outline")
        case .crashed: .ionicons("bug-outline")
        case .unsupported: .ionicons("link-outline")
        case .http, .other: .ionicons("warning-outline")
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = BrowserFailureLayout(
            size: bounds.size,
            insets: LayoutInsets(safeAreaInsets),
            title: title.measurable,
            message: message.measurable,
            button: retry.sizeThatFits(bounds.size)
        )
        icon.setLayoutFrame(layout.icon)
        title.setLayoutFrame(layout.title)
        message.setLayoutFrame(layout.message)
        retry.setLayoutFrame(layout.button)
    }
}
#endif
