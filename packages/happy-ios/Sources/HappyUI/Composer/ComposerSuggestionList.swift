#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// AgentInputAutocomplete.tsx on iOS: the suggestions on frosted glass
/// (24pt corners, a hairline rim, glass.shadow 0/16 radius 36), 48pt rows,
/// scrolling past 320. The highlighted row is `surfaceSelected`, a pressed
/// one `surfacePressed`. It fades and rises in (AnimatedPopup).
final class ComposerSuggestionListView: UIView {
    var onSelect: ((Int) -> Void)?

    private let surface = UIView()
    private let material = PartialBlurView(fraction: AutocompleteShadow.materialFraction)
    private let fill = UIView()
    private let scrollView = UIScrollView()
    private var rows: [ComposerSuggestionRowView] = []
    private(set) var suggestions: [ComposerSuggestion] = []
    private(set) var selectedIndex = -1

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.shadowColor = UIColor(Palette.glassShadow).cgColor
        layer.shadowOpacity = 1
        layer.shadowOffset = CGSize(width: 0, height: AutocompleteShadow.offsetY)
        layer.shadowRadius = AutocompleteShadow.radius
        surface.clipsToBounds = true
        surface.layer.cornerRadius = AgentInputLayout.Metrics.autocompleteRadius
        surface.layer.cornerCurve = .continuous
        addSubview(surface)
        material.clipsToBounds = true
        surface.addSubview(material)
        fill.isUserInteractionEnabled = false
        surface.addSubview(fill)
        scrollView.showsVerticalScrollIndicator = true
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.alwaysBounceVertical = false
        // `keyboardShouldPersistTaps="handled"`: a row takes the tap and
        // the keyboard stays.
        scrollView.delaysContentTouches = false
        surface.addSubview(scrollView)
        applyAppearance()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.applyAppearance()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// The rim, one hairline.
    var border: CGFloat { hairline }

    func set(_ suggestions: [ComposerSuggestion], selected: Int) {
        if suggestions != self.suggestions {
            self.suggestions = suggestions
            while rows.count < suggestions.count {
                let row = ComposerSuggestionRowView()
                row.addTarget(self, action: #selector(rowTapped(_:)), for: .touchUpInside)
                scrollView.addSubview(row)
                rows.append(row)
            }
            for (index, row) in rows.enumerated() {
                row.isHidden = index >= suggestions.count
                if index < suggestions.count {
                    row.suggestion = suggestions[index]
                }
            }
            setNeedsLayout()
        }
        selectedIndex = selected
        for (index, row) in rows.enumerated() {
            row.isSelectedRow = index == selected
        }
    }

    @objc private func rowTapped(_ row: ComposerSuggestionRowView) {
        guard let index = rows.firstIndex(where: { $0 === row }), index < suggestions.count else { return }
        onSelect?(index)
    }

    private func applyAppearance() {
        layer.shadowColor = UIColor(Palette.glassShadow).resolvedColor(with: traitCollection).cgColor
        fill.backgroundColor = UIColor(Palette.glassOverlay)
        surface.layer.borderWidth = hairline
        surface.layer.borderColor = UIColor(Palette.glassBorder).resolvedColor(with: traitCollection).cgColor
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        surface.frame = bounds
        material.frame = surface.bounds
        fill.frame = surface.bounds
        layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: AgentInputLayout.Metrics.autocompleteRadius).cgPath
        let rim = border
        scrollView.frame = bounds.insetBy(dx: rim, dy: rim)
        let frames = ComposerSuggestionListLayout.rows(count: suggestions.count, width: bounds.width, border: rim)
        for (row, frame) in zip(rows, frames) {
            row.setLayoutFrame(frame)
        }
        scrollView.contentSize = CGSize(width: scrollView.bounds.width, height: frames.last?.maxY ?? 0)
    }

    // MARK: AnimatedPopup

    /// FadeIn 190ms out-cubic from 0, scale 0.96, 8 lower.
    func animateIn() {
        alpha = 0
        transform = CGAffineTransform(translationX: 0, y: 8).scaledBy(x: 0.96, y: 0.96)
        let animator = UIViewPropertyAnimator(duration: 0.19, controlPoint1: CGPoint(x: 0.215, y: 0.61), controlPoint2: CGPoint(x: 0.355, y: 1)) {
            self.alpha = 1
            self.transform = .identity
        }
        animator.isUserInteractionEnabled = true
        animator.startAnimation()
    }

    /// FadeOut 140ms in-cubic.
    func animateOut(completion: @escaping () -> Void) {
        let animator = UIViewPropertyAnimator(duration: 0.14, controlPoint1: CGPoint(x: 0.55, y: 0.055), controlPoint2: CGPoint(x: 0.675, y: 0.19)) {
            self.alpha = 0
        }
        animator.addCompletion { _ in completion() }
        animator.startAnimation()
    }
}

/// AgentInputSuggestionView.tsx: CommandSuggestion or FileMentionSuggestion.
final class ComposerSuggestionRowView: UIControl {
    private let nameLabel = UILabel()
    private let detailLabel = UILabel()
    private let iconCircle = UIView()
    private let iconView = IconView(size: ComposerSuggestionRowLayout.Metrics.iconGlyphSize, tint: Palette.textSecondary)
    private let tagLabel = UILabel()

    var suggestion: ComposerSuggestion? {
        didSet {
            guard suggestion != oldValue else { return }
            applyContent()
        }
    }

    var isSelectedRow = false {
        didSet {
            guard isSelectedRow != oldValue else { return }
            applyBackground()
        }
    }

    override var isHighlighted: Bool {
        didSet {
            guard isHighlighted != oldValue else { return }
            applyBackground()
        }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        for view in [nameLabel, detailLabel, iconCircle, iconView, tagLabel] as [UIView] {
            view.isUserInteractionEnabled = false
            addSubview(view)
        }
        iconCircle.layer.cornerRadius = ComposerSuggestionRowLayout.Metrics.iconSize / 2
        isAccessibilityElement = true
        accessibilityTraits = .button
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.applyContent()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func applyBackground() {
        if isHighlighted {
            backgroundColor = UIColor(Palette.surfacePressed)
        } else if isSelectedRow {
            backgroundColor = UIColor(Palette.surfaceSelected)
        } else {
            backgroundColor = .clear
        }
    }

    private func applyContent() {
        applyBackground()
        iconCircle.backgroundColor = UIColor(Palette.surfaceHigh)
        switch suggestion?.kind {
        case .command(let name, let description):
            nameLabel.attributedText = TextStyles.suggestionCommand.attributedString("/\(name)", color: UIColor(Palette.text))
            detailLabel.attributedText = description.map {
                TextStyles.suggestionDescription.attributedString($0, color: UIColor(Palette.textSecondary), lineBreakMode: .byTruncatingTail)
            }
            nameLabel.isHidden = false
            detailLabel.isHidden = description == nil
            iconCircle.isHidden = true
            iconView.isHidden = true
            tagLabel.isHidden = true
            accessibilityLabel = description.map { "/\(name), \($0)" } ?? "/\(name)"
        case .file(let name, let path, let isFolder):
            let tag = isFolder ? Strings.Composer.folderLabel : Strings.Composer.fileLabel
            detailLabel.attributedText = TextStyles.suggestionFile.attributedString(
                path + name, color: UIColor(Palette.textSecondary), lineBreakMode: .byTruncatingTail
            )
            tagLabel.attributedText = TextStyles.suggestionLabel.attributedString(tag, color: UIColor(Palette.textSecondary))
            iconView.icon = .ionicons(isFolder ? "folder" : "document-text")
            nameLabel.isHidden = true
            detailLabel.isHidden = false
            iconCircle.isHidden = false
            iconView.isHidden = false
            tagLabel.isHidden = false
            accessibilityLabel = "\(path + name), \(tag)"
        case nil:
            break
        }
        setNeedsLayout()
    }

    private func natural(_ label: UILabel) -> CGSize {
        label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        switch suggestion?.kind {
        case .command(_, let description):
            let layout = ComposerSuggestionRowLayout(
                width: bounds.width,
                input: .command(name: natural(nameLabel), description: description == nil ? nil : natural(detailLabel))
            )
            nameLabel.setLayoutFrame(layout.name ?? .zero)
            if let frame = layout.description {
                detailLabel.setLayoutFrame(frame)
            }
        case .file:
            let layout = ComposerSuggestionRowLayout(
                width: bounds.width,
                input: .file(path: natural(detailLabel), label: natural(tagLabel))
            )
            iconCircle.setLayoutFrame(layout.icon ?? .zero)
            iconView.setLayoutFrame(layout.iconGlyph ?? .zero)
            detailLabel.setLayoutFrame(layout.path ?? .zero)
            tagLabel.setLayoutFrame(layout.label ?? .zero)
        case nil:
            break
        }
    }
}
#endif
