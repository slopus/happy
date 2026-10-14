#if canImport(UIKit)
import HappyLayout
import UIKit

/// A UILabel that renders a `TextStyle` (face, size, fixed line height,
/// letter spacing, case) in a theme colour. Set `string`, not `text`.
///
/// On a screen that follows the person's text size (`FollowsTextSize`) the
/// style is drawn scaled as React Native scales it, and drawn again when the
/// size changes; everywhere else it is drawn as designed.
public final class StyledLabel: UILabel {
    public var string: String = "" {
        didSet { if string != oldValue { render() } }
    }

    public var style: TextStyle {
        didSet { if style != oldValue { render() } }
    }

    public var color: ColorToken {
        didSet { if color != oldValue { render() } }
    }

    public var alignment: NSTextAlignment {
        didSet { if alignment != oldValue { render() } }
    }

    /// Applied to the text each time it is drawn, for what a style can't
    /// say: a link's underline.
    public var decoration: ((NSMutableAttributedString) -> Void)? {
        didSet { render() }
    }

    /// The person's text size, where this label follows it.
    private var textScale: TextScale?

    public init(style: TextStyle, color: ColorToken, lines: Int = 0, alignment: NSTextAlignment = .natural) {
        self.style = style
        self.color = color
        self.alignment = alignment
        super.init(frame: .zero)
        numberOfLines = lines
        render()
        registerForTraitChanges(UIView.textSizeTraits, action: #selector(textSizeChanged))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// The style as drawn: scaled where the label follows the text size.
    public var renderedStyle: TextStyle {
        textScale.map { style.scaled($0) } ?? style
    }

    /// One line of this label's style, as drawn.
    public var lineHeight: CGFloat {
        renderedStyle.lineHeightValue
    }

    #if DEBUG
    /// How many times this label has measured itself (tests): a screen
    /// that measures off the main thread checks it never does.
    private(set) var measurements = 0
    #endif

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        #if DEBUG
        measurements += 1
        #endif
        // Measured before its first trait update: measure what it will draw.
        syncTextSize()
        return super.sizeThatFits(size)
    }

    public override func didMoveToWindow() {
        super.didMoveToWindow()
        if syncTextSize() { setNeedsLayoutUpTheTree() }
    }

    @objc private func textSizeChanged() {
        if syncTextSize() { setNeedsLayoutUpTheTree() }
    }

    /// Draws again when the text size here changed; true when it did.
    @discardableResult
    private func syncTextSize() -> Bool {
        let scale = traitCollection.textEnvironment?.scale
        guard scale != textScale else { return false }
        textScale = scale
        render()
        return true
    }

    private func render() {
        // Limited lines truncate with an ellipsis; unlimited ones wrap.
        let lineBreak: NSLineBreakMode = numberOfLines == 0 ? .byWordWrapping : .byTruncatingTail
        let text = renderedStyle.attributedString(string, color: UIColor(color), alignment: alignment, lineBreakMode: lineBreak)
        if let decoration, let decorated = text.mutableCopy() as? NSMutableAttributedString {
            decoration(decorated)
            attributedText = decorated
        } else {
            attributedText = text
        }
        accessibilityLabel = string
        setNeedsLayout()
        superview?.setNeedsLayout()
    }

    public override var numberOfLines: Int {
        didSet { if numberOfLines != oldValue { render() } }
    }
}
#endif
