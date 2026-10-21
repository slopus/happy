#if canImport(UIKit)
import HappyLayout
import UIKit

/// components/RoundButton.tsx: a filled pill or a text action, stretched to
/// the width it is given. `action` runs async and shows a spinner meanwhile;
/// `onTap` is the plain variant.
public final class RoundButton: UIControl {
    public var title: String {
        didSet { updateLabel() }
    }

    /// Shown beside the spinner while loading; without it the spinner
    /// replaces the title.
    public var loadingTitle: String? {
        didSet { updateLabel() }
    }

    public let size: RoundButtonSize
    public let display: RoundButtonDisplay
    public var onTap: (() -> Void)?
    public var action: (() async -> Void)?

    /// Set from outside (a screen-level busy state) or by `action`.
    public var isLoading = false {
        didSet { updateLabel(); updateSpinner() }
    }

    /// The label's size, measured off the main thread for the width the
    /// button is laid out at (`labelText`), so laying it out measures
    /// nothing. Nil: the label is measured here, as it is drawn. It is the
    /// title's size, so it is only for a button whose title stays and that
    /// never shows `loadingTitle`.
    var measuredLabelSize: CGSize? {
        didSet { if measuredLabelSize != oldValue { setNeedsLayout() } }
    }

    /// The label's style, lines and alignment for a button of `size` and
    /// `display`, for whoever measures it elsewhere.
    nonisolated static func labelText(_ size: RoundButtonSize, display: RoundButtonDisplay) -> (style: TextStyle, lines: Int, alignment: NSTextAlignment) {
        // Filled pills keep one line; text actions may wrap.
        (TextStyles.roundButton(size, display: display), display == .filled ? 1 : 0, .center)
    }

    let background = UIView()
    let label: StyledLabel
    let spinner = UIActivityIndicatorView(style: .medium)

    public init(title: String, size: RoundButtonSize = .large, display: RoundButtonDisplay = .filled) {
        self.title = title
        self.size = size
        self.display = display
        let text = Self.labelText(size, display: display)
        label = StyledLabel(
            style: text.style,
            color: display == .filled ? Palette.roundButtonText : Palette.textSecondary,
            lines: text.lines,
            alignment: text.alignment
        )
        super.init(frame: .zero)
        background.isUserInteractionEnabled = false
        label.isUserInteractionEnabled = false
        spinner.color = UIColor(display == .filled ? Palette.roundButtonText : Palette.textSecondary)
        spinner.hidesWhenStopped = true
        addSubview(background)
        addSubview(label)
        addSubview(spinner)
        updateBackground()
        updateLabel()
        isAccessibilityElement = true
        accessibilityTraits = .button
        addTarget(self, action: #selector(tapped), for: .touchUpInside)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private var inline: Bool {
        isLoading && loadingTitle != nil
    }

    public func layout(width: CGFloat) -> RoundButtonLayout {
        let spinnerSize = spinner.intrinsicContentSize
        let loading: RoundButtonLayout.Loading = !isLoading ? .none
            : inline ? .inline(spinner: spinnerSize)
            : .overlay(spinner: spinnerSize)
        let label = measuredLabelSize.map(Measurable.fixed) ?? label.measurable
        return RoundButtonLayout(.init(width: width, size: size, display: display, label: label, loading: loading))
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        background.setLayoutFrame(CGRect(origin: .zero, size: layout.size))
        background.layer.cornerRadius = layout.cornerRadius
        label.setLayoutFrame(layout.label)
        if let frame = layout.spinner { spinner.setLayoutFrame(frame) }
    }

    public override var isHighlighted: Bool {
        didSet { updateBackground() }
    }

    public override var isEnabled: Bool {
        didSet { alpha = isEnabled ? 1 : 0.5 }
    }

    /// Small buttons answer a little outside their frame, like hitSlop.
    public override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        let slop = RoundButtonMetrics.of(size).hitSlop
        return bounds.insetBy(dx: -slop, dy: -slop).contains(point)
    }

    private func updateBackground() {
        switch display {
        case .filled:
            background.backgroundColor = UIColor(isHighlighted ? Palette.roundButtonFillPressed : Palette.roundButtonFill)
        case .inverted:
            background.backgroundColor = isHighlighted ? UIColor(Palette.surfacePressedOverlay) : .clear
        }
    }

    private func updateLabel() {
        label.string = inline ? (loadingTitle ?? title) : title
        // The overlay spinner hides the title but keeps its space.
        label.alpha = isLoading && !inline ? 0 : 1
        accessibilityLabel = label.string
        accessibilityValue = isLoading ? "busy" : nil
        setNeedsLayout()
    }

    private func updateSpinner() {
        if isLoading { spinner.startAnimating() } else { spinner.stopAnimating() }
        setNeedsLayout()
    }

    @objc private func tapped() {
        guard !isLoading else { return }
        if let onTap {
            onTap()
            return
        }
        guard let action else { return }
        isLoading = true
        Task { @MainActor [weak self] in
            await action()
            self?.isLoading = false
        }
    }
}
#endif
