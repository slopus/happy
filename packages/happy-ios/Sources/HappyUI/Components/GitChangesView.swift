#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// "≈ +12 -3" on a checkout.
final class GitChangesView: UIView {
    let approximate: StyledLabel
    let added: StyledLabel
    let removed: StyledLabel

    var changes: GitLineChanges? {
        didSet { if changes != oldValue { apply() } }
    }

    /// The project list's styles unless told otherwise.
    init(approximateStyle: TextStyle = TextStyles.gitApproximate, countStyle: TextStyle = TextStyles.gitLineCount) {
        approximate = StyledLabel(style: approximateStyle, color: Palette.textSecondary, lines: 1)
        added = StyledLabel(style: countStyle, color: Palette.gitAddedText, lines: 1)
        removed = StyledLabel(style: countStyle, color: Palette.gitRemovedText, lines: 1)
        super.init(frame: .zero)
        approximate.string = "≈"
        for label in [approximate, added, removed] { addSubview(label) }
        isUserInteractionEnabled = false
        apply()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func apply() {
        approximate.isHidden = changes?.approximate != true
        added.string = "+" + GitLineChanges.compact(changes?.insertions ?? 0)
        added.isHidden = (changes?.insertions ?? 0) <= 0
        removed.string = "-" + GitLineChanges.compact(changes?.deletions ?? 0)
        removed.isHidden = (changes?.deletions ?? 0) <= 0
        setNeedsLayout()
    }

    private var layout: GitChangesLayout {
        let unbounded = CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
        return GitChangesLayout(
            approximate: approximate.isHidden ? nil : approximate.sizeThatFits(unbounded),
            added: added.isHidden ? nil : added.sizeThatFits(unbounded),
            removed: removed.isHidden ? nil : removed.sizeThatFits(unbounded)
        )
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout.size
    }

    /// The parts shown, as VoiceOver reads them.
    var spoken: String {
        [approximate, added, removed].filter { !$0.isHidden }.map(\.string).joined(separator: " ")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout
        if let frame = layout.approximate { approximate.setLayoutFrame(frame) }
        if let frame = layout.added { added.setLayoutFrame(frame) }
        if let frame = layout.removed { removed.setLayoutFrame(frame) }
    }
}
#endif
