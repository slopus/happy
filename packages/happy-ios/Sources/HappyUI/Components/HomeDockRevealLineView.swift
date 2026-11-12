#if canImport(UIKit)
import UIKit

/// One line over the open composer that reveals in turn and refuses
/// presses while a session starts (`FocusConfigRevealRow`): a press
/// anywhere on it shakes it. A line over the backdrop lets the backdrop
/// have every touch its controls don't take (`box-none`).
final class HomeDockRevealLineView: UIView {
    let blocker = UIControl()
    private let passesThrough: Bool

    init(passesThrough: Bool) {
        self.passesThrough = passesThrough
        super.init(frame: .zero)
        blocker.isHidden = true
        addSubview(blocker)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    var refusing = false {
        didSet { blocker.isHidden = !refusing }
    }

    /// Keeps the blocker over whatever is added.
    override func didAddSubview(_ subview: UIView) {
        super.didAddSubview(subview)
        if subview !== blocker { bringSubviewToFront(blocker) }
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return passesThrough && hit === self ? nil : hit
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        blocker.frame = bounds
    }
}
#endif
