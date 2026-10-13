#if canImport(UIKit)
import HappyLayout
import UIKit

/// A UILabel that renders a `TextStyle` (face, size, fixed line height,
/// letter spacing, case) in a theme colour. Set `string`, not `text`.
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

    public init(style: TextStyle, color: ColorToken, lines: Int = 0, alignment: NSTextAlignment = .natural) {
        self.style = style
        self.color = color
        self.alignment = alignment
        super.init(frame: .zero)
        numberOfLines = lines
        render()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// One line of this label's style.
    public var lineHeight: CGFloat {
        style.lineHeightValue
    }

    private func render() {
        // Limited lines truncate with an ellipsis; unlimited ones wrap.
        let lineBreak: NSLineBreakMode = numberOfLines == 0 ? .byWordWrapping : .byTruncatingTail
        attributedText = style.attributedString(string, color: UIColor(color), alignment: alignment, lineBreakMode: lineBreak)
        accessibilityLabel = string
        setNeedsLayout()
        superview?.setNeedsLayout()
    }

    public override var numberOfLines: Int {
        didSet { if numberOfLines != oldValue { render() } }
    }
}
#endif
