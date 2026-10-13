#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

/// The one cell every row uses: it draws a `ChatRowPlan` with a pool of
/// plain views (boxes, text, icons) it reuses from row to row. It measures
/// nothing and lays out nothing of its own.
final class ChatRowCell: UICollectionViewCell {
    static let reuseIdentifier = "ChatRowCell"

    private(set) var plan: ChatRowPlan?
    private var boxes: [UIView] = []
    private var texts: [ChatTextView] = []
    private var icons: [UIImageView] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        contentView.backgroundColor = .clear
        isAccessibilityElement = true
        accessibilityTraits = .staticText
        // CGColor borders don't follow the appearance by themselves.
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            guard let plan = self.plan else { return }
            self.plan = nil
            self.apply(plan)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func apply(_ plan: ChatRowPlan) {
        guard plan !== self.plan else { return }
        self.plan = plan
        contentView.alpha = plan.alpha
        accessibilityLabel = plan.accessibilityLabel

        // Views are taken in draw order; keeping them in one subview order
        // means a box always sits under the text that follows it.
        var boxIndex = 0
        var textIndex = 0
        var iconIndex = 0
        var order: [UIView] = []
        for item in plan.items {
            switch item {
            case .box(let box):
                let view = take(&boxes, &boxIndex) { UIView() }
                view.setLayoutFrame(box.frame)
                view.backgroundColor = box.fill.map { UIColor($0) } ?? .clear
                view.layer.cornerRadius = box.radius
                view.layer.cornerCurve = .continuous
                view.layer.borderWidth = box.borderWidth
                view.layer.borderColor = box.border.map { UIColor($0).resolvedColor(with: traitCollection).cgColor }
                order.append(view)
            case .text(let layout, let frame):
                let view = take(&texts, &textIndex) { ChatTextView() }
                view.isAccessibilityElement = false
                view.setLayoutFrame(frame)
                view.layout = layout
                order.append(view)
            case .icon(let icon, let size, let frame, let tint):
                let view = take(&icons, &iconIndex) { UIImageView() }
                view.contentMode = .center
                view.image = .icon(icon, size: size)
                view.tintColor = UIColor(tint)
                view.setLayoutFrame(frame)
                order.append(view)
            }
        }
        for view in boxes[boxIndex...] { view.isHidden = true }
        for view in texts[textIndex...] { view.isHidden = true }
        for view in icons[iconIndex...] { view.isHidden = true }
        for view in order {
            view.isHidden = false
            contentView.bringSubviewToFront(view)
        }
    }

    private func take<View: UIView>(_ pool: inout [View], _ index: inout Int, make: () -> View) -> View {
        if index == pool.count {
            let view = make()
            pool.append(view)
            contentView.addSubview(view)
        }
        defer { index += 1 }
        return pool[index]
    }

    /// What a tap at `point` (in this cell) does, if anything.
    func action(at point: CGPoint) -> ChatRowAction? {
        guard let plan else { return nil }
        return plan.hits.first { $0.frame.contains(point) }?.action
    }

    /// The link under `point`, if the tap landed on one.
    func link(at point: CGPoint) -> String? {
        for view in texts where !view.isHidden && view.frame.contains(point) {
            if let link = view.link(at: CGPoint(x: point.x - view.frame.minX, y: point.y - view.frame.minY)) {
                return link
            }
        }
        return nil
    }
}
#endif
