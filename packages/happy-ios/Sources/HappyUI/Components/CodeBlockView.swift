#if canImport(UIKit)
import HappyLayout
import UIKit

/// components/CodeView.tsx as info.tsx places it in a group: Menlo 12/18 on
/// `surfaceHigh`, radius 6, padding 12, inset 16 with 12 below.
final class CodeBlockView: UIView {
    var code: String {
        didSet { if code != oldValue { render() } }
    }

    private let box = UIView()
    private let label = UILabel()

    init(code: String) {
        self.code = code
        super.init(frame: .zero)
        box.backgroundColor = UIColor(Palette.surfaceHigh)
        box.layer.cornerRadius = CodeBlockLayout.Metrics.cornerRadius
        label.numberOfLines = 0
        addSubview(box)
        addSubview(label)
        render()
        registerForTraitChanges(UIView.textSizeTraits) { (self: Self, _) in
            self.syncTextSize()
        }
    }

    /// The text size it draws at; nil as designed.
    private(set) var textScale: TextScale?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        syncTextSize()
    }

    private func syncTextSize() {
        let scale = traitCollection.textEnvironment?.scale
        guard scale != textScale else { return }
        textScale = scale
        render()
        setNeedsLayoutUpTheTree()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func layout(width: CGFloat) -> CodeBlockLayout {
        // Measured before its first trait update: measure what it draws.
        syncTextSize()
        return CodeBlockLayout(width: width, text: label.measurable)
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        box.setLayoutFrame(layout.box)
        label.setLayoutFrame(layout.text)
    }

    private func render() {
        label.attributedText = Self.attributed(code, scale: textScale)
        setNeedsLayout()
        superview?.setNeedsLayout()
    }

    /// `fontFamily: Menlo` at 12 with an 18pt line, in the text colour;
    /// both × the text size's multiplier at `scale`, as RN scales them.
    static func attributed(_ code: String, scale: TextScale? = nil) -> NSAttributedString {
        typealias M = CodeBlockLayout.Metrics
        let m = scale?.multiplier ?? 1
        let size = M.fontSize * m
        let lineHeight = M.lineHeight * m
        let font = UIFont(name: "Menlo", size: size) ?? .monospacedSystemFont(ofSize: size, weight: .regular)
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = lineHeight
        paragraph.maximumLineHeight = lineHeight
        paragraph.lineBreakMode = .byWordWrapping
        return NSAttributedString(string: code, attributes: [
            .font: font,
            .foregroundColor: UIColor(Palette.text),
            .paragraphStyle: paragraph,
            .baselineOffset: (lineHeight - font.lineHeight) / 4,
        ])
    }
}
#endif
