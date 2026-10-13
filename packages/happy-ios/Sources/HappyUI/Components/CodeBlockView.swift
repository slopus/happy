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
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func layout(width: CGFloat) -> CodeBlockLayout {
        CodeBlockLayout(width: width, text: label.measurable)
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
        label.attributedText = Self.attributed(code)
        setNeedsLayout()
        superview?.setNeedsLayout()
    }

    /// `fontFamily: Menlo` at 12 with an 18pt line, in the text colour.
    static func attributed(_ code: String) -> NSAttributedString {
        typealias M = CodeBlockLayout.Metrics
        let font = UIFont(name: "Menlo", size: M.fontSize) ?? .monospacedSystemFont(ofSize: M.fontSize, weight: .regular)
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = M.lineHeight
        paragraph.maximumLineHeight = M.lineHeight
        paragraph.lineBreakMode = .byWordWrapping
        return NSAttributedString(string: code, attributes: [
            .font: font,
            .foregroundColor: UIColor(Palette.text),
            .paragraphStyle: paragraph,
            .baselineOffset: (M.lineHeight - font.lineHeight) / 4,
        ])
    }
}
#endif
