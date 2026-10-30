#if canImport(UIKit)
import HappyLayout
import UIKit

/// Child containment keeps the composer's responder and keyboard window in
/// place. Only the panel scrolls; opening it never changes the chat's insets.
@MainActor
final class ComposerPanelPresenter {
    private weak var host: UIViewController?
    private weak var anchor: UIView?
    private let content: UIViewController
    private let height: CGFloat
    private let backdrop = ComposerPanelBackdrop()
    private let scroll = UIScrollView()
    var onOutside: (() -> Void)?

    init(content: UIViewController, height: CGFloat, host: UIViewController, anchor: UIView) {
        self.content = content
        self.height = height
        self.host = host
        self.anchor = anchor
        backdrop.onOutside = { [weak self] in self?.onOutside?() }
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.keyboardDismissMode = .none
        scroll.layer.cornerRadius = 24
        scroll.layer.cornerCurve = .continuous
        scroll.clipsToBounds = true
        scroll.backgroundColor = UIColor(Palette.attachGround)
        backdrop.panel = scroll
        backdrop.addSubview(scroll)
        backdrop.onLayout = { [weak self] in self?.follow() }
    }

    func show() {
        guard let host, backdrop.superview == nil else { return }
        host.addChild(content)
        scroll.addSubview(content.view)
        host.view.addSubview(backdrop)
        backdrop.frame = host.view.bounds
        backdrop.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        content.didMove(toParent: host)
        content.view.accessibilityViewIsModal = true
        follow()
        UIAccessibility.post(notification: .screenChanged, argument: content.view)
    }

    func follow() {
        guard let anchor, backdrop.superview != nil else { return }
        let bottom = anchor.convert(anchor.bounds, to: backdrop).maxY
        let layout = ComposerPanelLayout(size: backdrop.bounds.size, safeArea: LayoutInsets(backdrop.safeAreaInsets), bottom: bottom, contentHeight: height)
        scroll.setLayoutFrame(layout.frame)
        content.view.setLayoutFrame(layout.content)
        scroll.contentSize = layout.content.size
    }

    func close(completion: (() -> Void)? = nil) {
        guard backdrop.superview != nil else { completion?(); return }
        content.view.accessibilityViewIsModal = false
        content.willMove(toParent: nil)
        content.view.removeFromSuperview()
        content.removeFromParent()
        backdrop.removeFromSuperview()
        UIAccessibility.post(notification: .screenChanged, argument: anchor)
        completion?()
    }
}

private final class ComposerPanelBackdrop: UIView, UIGestureRecognizerDelegate {
    weak var panel: UIView?
    var onOutside: (() -> Void)?
    var onLayout: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        let tap = UITapGestureRecognizer(target: self, action: #selector(outside))
        tap.delegate = self
        addGestureRecognizer(tap)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
    @objc private func outside() { onOutside?() }
    override func accessibilityPerformEscape() -> Bool { onOutside?(); return true }
    override func layoutSubviews() { super.layoutSubviews(); onLayout?() }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool { touch.view === self }
}
#endif