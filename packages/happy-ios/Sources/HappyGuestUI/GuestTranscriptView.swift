#if canImport(UIKit)
import HappyChatKit
import HappyIcons
import HappyLayout
import UIKit

/// Draws a `GuestRowPlan`. It measures nothing and places nothing itself.
final class GuestRowView: UIView {
    private(set) var plan: GuestRowPlan?

    func apply(_ plan: GuestRowPlan) {
        guard plan !== self.plan else { return }
        self.plan = plan
        subviews.forEach { $0.removeFromSuperview() }
        alpha = plan.alpha
        accessibilityLabel = plan.accessibilityLabel
        isAccessibilityElement = plan.accessibilityLabel != nil
        for item in plan.items {
            switch item {
            case .box(let box):
                let view = UIView()
                view.isUserInteractionEnabled = false
                view.backgroundColor = box.fill.map { UIColor($0) }
                view.layer.cornerRadius = box.radius
                view.layer.cornerCurve = .continuous
                view.layer.borderWidth = box.borderWidth
                view.layer.borderColor = box.border.map { UIColor($0).resolvedColor(with: traitCollection).cgColor }
                view.setLayoutFrame(box.frame)
                addSubview(view)
            case .text(let layout, let frame):
                let view = ChatTextView()
                view.isUserInteractionEnabled = false
                view.layout = layout
                view.setLayoutFrame(frame)
                addSubview(view)
            case .icon(let icon, let size, let frame, let tint):
                let view = IconView(size: size)
                view.icon = icon
                view.tintColor = UIColor(tint)
                view.isUserInteractionEnabled = false
                view.setLayoutFrame(frame)
                addSubview(view)
            case .scroller(let content, let frame, let radius):
                let scroll = UIScrollView()
                scroll.showsHorizontalScrollIndicator = false
                scroll.alwaysBounceHorizontal = false
                scroll.layer.cornerRadius = radius
                scroll.clipsToBounds = true
                let inner = GuestRowView()
                inner.apply(content)
                inner.frame = CGRect(origin: .zero, size: content.size)
                scroll.addSubview(inner)
                scroll.contentSize = content.size
                scroll.setLayoutFrame(frame)
                addSubview(scroll)
            }
        }
    }

    /// Box borders are CGColors: they follow light and dark by hand.
    override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        guard previous?.userInterfaceStyle != traitCollection.userInterfaceStyle, let plan else { return }
        self.plan = nil
        apply(plan)
    }

    func action(at point: CGPoint) -> GuestRowAction? {
        plan?.hits.first { $0.frame.contains(point) }?.action
    }

    func link(at point: CGPoint) -> String? {
        for case let text as ChatTextView in subviews where text.frame.contains(point) {
            if let url = text.link(at: convert(point, to: text)) { return url }
        }
        return nil
    }
}

/// The transcript: rows stacked oldest first in a vertical scroll view.
/// A reader at the newest row is carried along as rows arrive; a reader
/// further back keeps their place.
final class GuestTranscriptView: UIScrollView {
    var onAction: ((GuestRowAction) -> Void)?
    var onLink: ((URL) -> Void)?
    private var rows: [GuestRowView] = []
    private var layout = GuestTranscriptLayout(width: 0, heights: [])

    override init(frame: CGRect) {
        super.init(frame: frame)
        alwaysBounceVertical = true
        keyboardDismissMode = .interactive
        contentInsetAdjustmentBehavior = .never
        showsVerticalScrollIndicator = false
        accessibilityIdentifier = "guest.transcript"
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.cancelsTouchesInView = false
        addGestureRecognizer(tap)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    var isEmpty: Bool { rows.isEmpty }

    /// The width every row now showing was measured at.
    var measuredWidth: CGFloat { layout.contentSize.width }

    private var atNewest: Bool {
        contentOffset.y >= contentSize.height + contentInset.bottom - bounds.height - 24
    }

    /// Shows `plans`, oldest first. Rows whose plan is unchanged keep their
    /// views; only new or changed rows draw again.
    func apply(_ plans: [GuestRowPlan], width: CGFloat) {
        let follow = atNewest || rows.isEmpty
        while rows.count < plans.count {
            let row = GuestRowView()
            addSubview(row)
            rows.append(row)
        }
        while rows.count > plans.count { rows.removeLast().removeFromSuperview() }
        layout = GuestTranscriptLayout(width: width, heights: plans.map(\.size.height))
        for (row, (plan, frame)) in zip(rows, zip(plans, layout.rows)) {
            row.apply(plan)
            row.setLayoutFrame(frame)
        }
        contentSize = layout.contentSize
        if follow { scrollToNewest() }
    }

    func setInsets(oldest: CGFloat, newest: CGFloat) {
        let insets = UIEdgeInsets(top: oldest, left: 0, bottom: newest, right: 0)
        guard contentInset != insets else { return }
        let follow = atNewest
        contentInset = insets
        if follow { scrollToNewest() }
    }

    func scrollToNewest() {
        let y = max(-contentInset.top, contentSize.height + contentInset.bottom - bounds.height)
        contentOffset = CGPoint(x: 0, y: y)
    }

    @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
        let point = recognizer.location(in: self)
        guard let row = rows.first(where: { $0.frame.contains(point) }) else { return }
        let local = row.convert(point, from: self)
        if let link = row.link(at: local), let url = URL(string: link) {
            onLink?(url)
        } else if let action = row.action(at: local) {
            onAction?(action)
        }
    }
}
#endif
