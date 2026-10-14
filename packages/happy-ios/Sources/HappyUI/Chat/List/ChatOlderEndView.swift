#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// ChatList's OlderEnd: past the oldest message, a spinner while the screen
/// waits on an older page it asked for, Retry after one failed, Load more
/// after five that showed nothing new (`ChatOlderPaging.status`). Always
/// the 32 pt slot (`ChatOlderEndLayout`), so a change of status never moves
/// the conversation.
///
/// Retry and Load more are RoundButton's small text action, which stretches
/// to the list's width and is 33 tall (17 and 8 above and below), centred
/// on the slot as RN centres it.
final class ChatOlderEndView: UIView {
    /// Retry or Load more was pressed; which one is `status`.
    var onAction: (() -> Void)?

    var status: ChatOlderPaging.Status = .idle {
        didSet { if status != oldValue { apply() } }
    }

    private let spinner = UIActivityIndicatorView(style: .medium)
    private let button = RoundButton(title: Strings.Chat.retry, size: .small, display: .inverted)

    override init(frame: CGRect) {
        super.init(frame: frame)
        spinner.hidesWhenStopped = true
        addSubview(spinner)
        button.onTap = { [weak self] in self?.onAction?() }
        addSubview(button)
        apply()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        CGSize(width: size.width, height: ChatOlderEndLayout.height)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        spinner.setLayoutFrame(ChatOlderEndLayout(width: bounds.width, control: spinner.intrinsicContentSize).control)
        let fitted = button.sizeThatFits(CGSize(width: bounds.width, height: .greatestFiniteMagnitude))
        button.setLayoutFrame(ChatOlderEndLayout(width: bounds.width, control: fitted).control)
    }

    private func apply() {
        if status == .loading { spinner.startAnimating() } else { spinner.stopAnimating() }
        switch status {
        case .error: button.title = Strings.Chat.retry
        case .loadMore: button.title = Strings.Chat.loadMore
        case .idle, .loading: break
        }
        button.isHidden = status != .error && status != .loadMore
        setNeedsLayout()
    }
}
#endif
