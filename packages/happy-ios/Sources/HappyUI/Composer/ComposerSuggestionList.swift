#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// AgentInputAutocomplete.tsx on iOS: the suggestions on frosted glass
/// (24pt corners, a hairline rim, glass.shadow 0/16 radius 36), 48pt rows,
/// scrolling past 320. The highlighted row is `surfaceSelected`, a pressed
/// one `surfacePressed`. It fades and rises in (AnimatedPopup).
///
/// Behind the glass and its shadow, LocalBlurHalo blurs the chat for 35pt
/// around the list, fading out (`LocalBlurHaloLayout`), as the new-session
/// pickers' halo does. It is drawn outside the list's bounds and takes no
/// touches (`pointerEvents="none"`): a tap beside the list reaches
/// whatever is under it.
final class ComposerSuggestionListView: UIView {
    var onSelect: ((Int) -> Void)?

    private let halo = UIView()
    private let haloBlur = PartialBlurView(fraction: LocalBlurHaloLayout.autocomplete.intensity)
    private let haloDim = UIView()
    private let haloMask = CALayer()
    /// The glass's shadow, over the halo; the glass clips inside it.
    private let shadowHost = UIView()
    private let surface = UIView()
    private let material = PartialBlurView(fraction: AutocompleteShadow.materialFraction)
    private let fill = UIView()
    private let scrollView = UIScrollView()
    private var rows: [ComposerSuggestionRowView] = []
    private(set) var suggestions: [ComposerSuggestion] = []
    private(set) var selectedIndex = -1

    override init(frame: CGRect) {
        super.init(frame: frame)
        let haloLayout = LocalBlurHaloLayout.autocomplete
        halo.isUserInteractionEnabled = false
        halo.addSubview(haloBlur)
        haloDim.isUserInteractionEnabled = false
        halo.addSubview(haloDim)
        haloMask.backgroundColor = UIColor.white.cgColor
        haloMask.shadowColor = UIColor.white.cgColor
        haloMask.shadowOpacity = 1
        haloMask.shadowOffset = .zero
        haloMask.shadowRadius = haloLayout.feather
        haloMask.cornerRadius = haloLayout.borderRadius
        let maskHost = CALayer()
        maskHost.addSublayer(haloMask)
        halo.layer.mask = maskHost
        addSubview(halo)

        shadowHost.layer.shadowOpacity = 1
        shadowHost.layer.shadowOffset = CGSize(width: 0, height: AutocompleteShadow.offsetY)
        shadowHost.layer.shadowRadius = AutocompleteShadow.radius
        addSubview(shadowHost)
        surface.clipsToBounds = true
        surface.layer.cornerRadius = AgentInputLayout.Metrics.autocompleteRadius
        surface.layer.cornerCurve = .continuous
        shadowHost.addSubview(surface)
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
        shadowHost.layer.shadowColor = UIColor(Palette.glassShadow).resolvedColor(with: traitCollection).cgColor
        haloDim.backgroundColor = UIColor(Palette.composerHaloDim)
        fill.backgroundColor = UIColor(Palette.glassOverlay)
        surface.layer.borderWidth = hairline
        surface.layer.borderColor = UIColor(Palette.glassBorder).resolvedColor(with: traitCollection).cgColor
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let haloLayout = LocalBlurHaloLayout.autocomplete
        halo.frame = haloLayout.frame(popup: bounds)
        haloBlur.frame = halo.bounds
        haloDim.frame = halo.bounds
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        halo.layer.mask?.frame = halo.bounds
        haloMask.frame = haloLayout.maskCore(halo: halo.bounds)
        CATransaction.commit()
        shadowHost.frame = bounds
        shadowHost.layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: AgentInputLayout.Metrics.autocompleteRadius).cgPath
        surface.frame = bounds
        material.frame = surface.bounds
        fill.frame = surface.bounds
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
        registerForTraitChanges(UIView.textSizeTraits) { (self: Self, _) in
            self.syncTextSize()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// The person's text size, where the composer follows it: the text
    /// grows inside the fixed 48pt row (`itemHeight`), as RN's does.
    private var textScale: TextScale?

    private func style(_ style: TextStyle) -> TextStyle {
        textScale.map { style.scaled($0) } ?? style
    }

    /// Draws again when the text size here moved; true if it did.
    @discardableResult
    private func syncTextSize() -> Bool {
        let scale = traitCollection.textEnvironment?.scale
        guard scale != textScale else { return false }
        textScale = scale
        applyContent()
        return true
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
        textScale = traitCollection.textEnvironment?.scale
        applyBackground()
        iconCircle.backgroundColor = UIColor(Palette.surfaceHigh)
        switch suggestion?.kind {
        case .command(let name, let description):
            nameLabel.attributedText = style(TextStyles.suggestionCommand).attributedString("/\(name)", color: UIColor(Palette.text))
            detailLabel.attributedText = description.map {
                style(TextStyles.suggestionDescription).attributedString($0, color: UIColor(Palette.textSecondary), lineBreakMode: .byTruncatingTail)
            }
            nameLabel.isHidden = false
            detailLabel.isHidden = description == nil
            iconCircle.isHidden = true
            iconView.isHidden = true
            tagLabel.isHidden = true
            accessibilityLabel = description.map { "/\(name), \($0)" } ?? "/\(name)"
        case .file(let name, let path, let isFolder):
            let tag = isFolder ? Strings.Composer.folderLabel : Strings.Composer.fileLabel
            detailLabel.attributedText = style(TextStyles.suggestionFile).attributedString(
                path + name, color: UIColor(Palette.textSecondary), lineBreakMode: .byTruncatingTail
            )
            tagLabel.attributedText = style(TextStyles.suggestionLabel).attributedString(tag, color: UIColor(Palette.textSecondary))
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
        // Measured as drawn.
        syncTextSize()
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
