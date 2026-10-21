#if canImport(UIKit)
import Foundation
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// DiffFileHeader.tsx's content, measured.
struct DiffHeaderPlan: @unchecked Sendable {
    /// The last path component, which also picks the file icon.
    let name: String
    let dir: NSAttributedString
    let fileName: NSAttributedString
    let badge: NSAttributedString?
    let additions: NSAttributedString?
    let deletions: NSAttributedString?
    let chevron: Icon
    let layout: DiffFileHeaderLayout

    /// `toggles: false` is a header without `onToggle`, so without the
    /// chevron (the chat's patch cards). `scale` is the screen's, for the
    /// chevron; `text` the text size the header draws at (nil, the
    /// designed size): the path, badge and counts grow with it, the
    /// chevron, the file icon and the paddings keep their size.
    init(path: String, kind: FileChangeKind, additions: Int, deletions: Int, collapsed: Bool, width: CGFloat, scale: CGFloat, toggles: Bool = true, text: TextEnvironment? = nil) {
        let textScale = DiffStyle.textScale(text)
        let lastSlash = path.lastIndex(of: "/")
        let tail = lastSlash.map { String(path[path.index(after: $0)...]) } ?? path
        let name = tail.isEmpty ? path : tail
        let dirText = String(path.dropLast(name.count))
        self.name = name
        let dirStyle = DiffTextStyles.headerDir.scaled(textScale)
        let nameStyle = DiffTextStyles.headerFileName.scaled(textScale)
        dir = dirStyle.attributedString(dirText, color: UIColor(DiffStyle.textSecondary), lineBreakMode: .byTruncatingHead)
        fileName = nameStyle.attributedString(name, color: UIColor(DiffStyle.text), lineBreakMode: .byTruncatingTail)
        let badgeStyle = DiffTextStyles.headerBadge.scaled(textScale)
        switch kind {
        case .added: badge = badgeStyle.attributedString(Strings.DiffDetail.badgeNew, color: UIColor(DiffPalette.markerAdded))
        case .deleted: badge = badgeStyle.attributedString(Strings.DiffDetail.badgeDeleted, color: UIColor(DiffPalette.markerRemoved))
        case .renamed: badge = badgeStyle.attributedString(Strings.DiffDetail.badgeRenamed, color: UIColor(DiffStyle.textSecondary))
        default: badge = nil
        }
        let countStyle = DiffTextStyles.headerCount.scaled(textScale)
        self.additions = additions > 0 ? countStyle.attributedString("+\(additions)", color: UIColor(DiffPalette.markerAdded)) : nil
        self.deletions = deletions > 0 ? countStyle.attributedString("−\(deletions)", color: UIColor(DiffPalette.markerRemoved)) : nil
        chevron = .ionicons(collapsed ? "chevron-forward" : "chevron-down")
        let chevronSize = chevron.layout(size: DiffFileHeaderLayout.Metrics.chevronSize, scale: scale)?.size
            ?? CGSize(width: DiffFileHeaderLayout.Metrics.chevronSize, height: DiffFileHeaderLayout.Metrics.chevronSize)
        func box(_ text: NSAttributedString, _ style: TextStyle) -> DiffTextBox {
            let size = DiffStyle.size(text)
            return DiffTextBox(
                size: CGSize(width: text.length == 0 ? 0 : size.width, height: max(size.height, DiffStyle.lineHeight(style))),
                baseline: style.font.ascender
            )
        }
        layout = DiffFileHeaderLayout(.init(
            width: width,
            chevron: toggles ? chevronSize : nil,
            dir: box(dir, dirStyle),
            fileName: box(fileName, nameStyle),
            badge: badge.map(DiffStyle.size),
            additions: self.additions.map(DiffStyle.size),
            deletions: self.deletions.map(DiffStyle.size)
        ))
    }
}

/// components/diff/DiffFileHeader.tsx: chevron, file icon, path, change
/// badge and counts on `hunkBg`. Tapping it toggles the file.
final class DiffFileHeaderView: UIControl {
    private let chevron = IconView(size: DiffFileHeaderLayout.Metrics.chevronSize, tint: DiffStyle.textSecondary)
    private let icon = FileIconView()
    private let dir = UILabel()
    private let fileName = UILabel()
    private let badge = UILabel()
    private let additions = UILabel()
    private let deletions = UILabel()
    private var plan: DiffHeaderPlan?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(DiffStyle.hunkBackground)
        for label in [dir, fileName, badge, additions, deletions] {
            label.numberOfLines = 1
            label.isUserInteractionEnabled = false
            addSubview(label)
        }
        chevron.isUserInteractionEnabled = false
        icon.isUserInteractionEnabled = false
        addSubview(chevron)
        addSubview(icon)
        accessibilityTraits = .button
        isAccessibilityElement = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func apply(_ plan: DiffHeaderPlan, path: String) {
        self.plan = plan
        chevron.icon = plan.chevron
        icon.fileName = plan.name
        dir.attributedText = plan.dir
        fileName.attributedText = plan.fileName
        badge.attributedText = plan.badge
        additions.attributedText = plan.additions
        deletions.attributedText = plan.deletions
        accessibilityLabel = path
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let layout = plan?.layout else { return }
        if let frame = layout.chevron { chevron.setLayoutFrame(frame) }
        chevron.isHidden = layout.chevron == nil
        icon.setLayoutFrame(layout.icon)
        dir.setLayoutFrame(layout.dir)
        fileName.setLayoutFrame(layout.fileName)
        place(badge, layout.badge)
        place(additions, layout.additions)
        place(deletions, layout.deletions)
    }

    private func place(_ label: UILabel, _ frame: CGRect?) {
        label.isHidden = frame == nil
        if let frame { label.setLayoutFrame(frame) }
    }
}

/// components/diff/DiffImageView.tsx's panes: Before and After side by
/// side, each a label over a bordered 160-tall box with the picture fitted.
final class DiffImagePanesView: UIView {
    private var labels: [StyledLabel] = []
    private var boxes: [UIView] = []
    private var images: [UIImageView] = []
    private var layout: DiffImageLayout?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(DiffStyle.surface)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.setNeedsLayout()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// `sides` are (label, tint, picture), in order; `textScale` is the
    /// text size the plan measured them at, which the labels draw at
    /// rather than their traits'.
    func apply(sides: [(String, ColorToken, UIImage?)], layout: DiffImageLayout, textScale: TextScale = .standard) {
        self.layout = layout
        while labels.count < sides.count {
            let label = StyledLabel(style: DiffTextStyles.imageLabel, color: DiffStyle.textSecondary, lines: 1)
            label.traitOverrides.followsTextSize = false
            let box = UIView()
            box.backgroundColor = UIColor(DiffStyle.hunkBackground)
            box.layer.borderWidth = DiffImageLayout.Metrics.boxBorder
            box.layer.cornerRadius = DiffImageLayout.Metrics.boxRadius
            box.clipsToBounds = true
            let image = UIImageView()
            image.contentMode = .scaleAspectFit
            addSubview(label)
            addSubview(box)
            box.addSubview(image)
            labels.append(label)
            boxes.append(box)
            images.append(image)
        }
        for index in labels.indices {
            let shown = index < sides.count
            labels[index].isHidden = !shown
            boxes[index].isHidden = !shown
            guard shown else { continue }
            labels[index].style = DiffTextStyles.imageLabel.scaled(textScale)
            labels[index].string = sides[index].0
            labels[index].color = sides[index].1
            images[index].image = sides[index].2
        }
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let layout else { return }
        for (index, pane) in layout.panes.enumerated() where index < labels.count {
            labels[index].setLayoutFrame(pane.label)
            boxes[index].setLayoutFrame(pane.box)
            boxes[index].layer.borderColor = UIColor(DiffStyle.divider).resolvedColor(with: traitCollection).cgColor
            images[index].frame = boxes[index].bounds.insetBy(dx: DiffImageLayout.Metrics.boxBorder, dy: DiffImageLayout.Metrics.boxBorder)
        }
    }
}
#endif
