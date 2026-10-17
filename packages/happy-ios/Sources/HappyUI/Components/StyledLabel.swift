#if canImport(UIKit)
import HappyLayout
import UIKit

/// A UILabel that renders a `TextStyle` (face, size, fixed line height,
/// letter spacing, case) in a theme colour. Set `string`, not `text`.
///
/// On a screen that follows the person's text size (`FollowsTextSize`) the
/// style is drawn scaled as React Native scales it, and drawn again when the
/// size changes; everywhere else it is drawn as designed.
///
/// A new label draws nothing until it is first measured, laid out, drawn,
/// read or put on a window, so one made and set up before it joins its
/// screen draws once, at the screen's text size, not once as designed and
/// again when the screen's size reaches it. Rendering for measurement or a
/// read does not ask its container for another layout while it is measuring.
public final class StyledLabel: UILabel {
    public var string: String = "" {
        didSet {
            guard string != oldValue else { return }
            accessibilityLabel = string
            render()
        }
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

    /// Whether the label has drawn its text yet (`renderFirst`).
    private var rendered = false

    public init(style: TextStyle, color: ColorToken, lines: Int = 0, alignment: NSTextAlignment = .natural) {
        self.style = style
        self.color = color
        self.alignment = alignment
        super.init(frame: .zero)
        numberOfLines = lines
        accessibilityLabel = string
        registerForTraitChanges(UIView.textSizeTraits, action: #selector(textSizeChanged))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// The style as drawn: scaled where the label follows the text size.
    public var renderedStyle: TextStyle {
        renderFirst(invalidating: false)
        return textScale.map { style.scaled($0) } ?? style
    }

    /// One line of this label's style, as drawn.
    public var lineHeight: CGFloat {
        renderedStyle.lineHeightValue
    }

    #if DEBUG
    /// How many times this label has measured itself (tests): a screen
    /// that measures off the main thread checks it never does.
    private(set) var measurements = 0
    /// How many times it has drawn its text (tests).
    private(set) var renders = 0
    #endif

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        #if DEBUG
        measurements += 1
        #endif
        // Measured before its first trait update: measure what it will draw.
        if rendered { syncTextSize(invalidating: false) } else { renderFirst(invalidating: false) }
        return super.sizeThatFits(size)
    }

    public override var intrinsicContentSize: CGSize {
        renderFirst(invalidating: false)
        return super.intrinsicContentSize
    }

    public override func textRect(forBounds bounds: CGRect, limitedToNumberOfLines numberOfLines: Int) -> CGRect {
        renderFirst(invalidating: false)
        return super.textRect(forBounds: bounds, limitedToNumberOfLines: numberOfLines)
    }

    public override func layoutSubviews() {
        renderFirst(invalidating: true)
        super.layoutSubviews()
    }

    public override func drawText(in rect: CGRect) {
        renderFirst(invalidating: false)
        super.drawText(in: rect)
    }

    /// Read as drawn. Set directly, it stands until the label next draws.
    public override var attributedText: NSAttributedString? {
        get {
            renderFirst(invalidating: false)
            return super.attributedText
        }
        set {
            rendered = true
            super.attributedText = newValue
        }
    }

    public override var text: String? {
        get {
            renderFirst(invalidating: false)
            return super.text
        }
        set {
            rendered = true
            super.text = newValue
        }
    }

    public override func didMoveToWindow() {
        super.didMoveToWindow()
        guard rendered else {
            if window != nil { renderFirst(invalidating: true) }
            return
        }
        if syncTextSize() { setNeedsLayoutUpTheTree() }
    }

    @objc private func textSizeChanged() {
        // Not drawn yet: the first draw reads the size then.
        guard rendered else { return }
        if syncTextSize() { setNeedsLayoutUpTheTree() }
    }

    /// Draws again when the text size here changed; true when it did.
    @discardableResult
    private func syncTextSize(invalidating: Bool = true) -> Bool {
        let scale = traitCollection.textEnvironment?.scale
        guard scale != textScale else { return false }
        textScale = scale
        render(invalidating: invalidating)
        return true
    }

    /// Draws the text for the first time, at the text size here now: the
    /// traits UIKit would hand down before the next layout, taken now, as a
    /// label just put in its screen still has the ones it had before.
    private func renderFirst(invalidating: Bool) {
        guard !rendered else { return }
        updateTraitsIfNeeded()
        rendered = true
        textScale = traitCollection.textEnvironment?.scale
        render(invalidating: invalidating)
    }

    private func render(invalidating: Bool = true) {
        // Not drawn yet: the first draw takes everything set until then.
        guard rendered else {
            setNeedsLayout()
            superview?.setNeedsLayout()
            return
        }
        #if DEBUG
        renders += 1
        #endif
        // Limited lines truncate with an ellipsis; unlimited ones wrap.
        let lineBreak: NSLineBreakMode = numberOfLines == 0 ? .byWordWrapping : .byTruncatingTail
        let text = renderedStyle.attributedString(string, color: UIColor(color), alignment: alignment, lineBreakMode: lineBreak)
        if let decoration, let decorated = text.mutableCopy() as? NSMutableAttributedString {
            decoration(decorated)
            super.attributedText = decorated
        } else {
            super.attributedText = text
        }
        if invalidating {
            setNeedsLayout()
            superview?.setNeedsLayout()
        }
    }

    public override var numberOfLines: Int {
        didSet { if numberOfLines != oldValue { render() } }
    }
}
#endif
