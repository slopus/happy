#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

extension NSAttributedString.Key {
    /// The line a paragraph shows (`DocumentLineInfo`): on every character of it, its "\n" included.
    static let documentLine = NSAttributedString.Key("happy.documentLine")
    /// A run's formats exactly as the document stores them (`DocumentMarks`).
    static let documentMarks = NSAttributedString.Key("happy.documentMarks")
}

/// What the text view knows of the line a paragraph shows: enough to draw
/// its marker and to read it back.
final class DocumentLineInfo: NSObject, @unchecked Sendable {
    let line: DocumentLine
    let kind: DocumentLineKind
    /// A numbered item's number as drawn.
    let number: String?

    init(line: DocumentLine, kind: DocumentLineKind, number: String?) {
        self.line = line
        self.kind = kind
        self.number = number
    }

    var id: String { line.id }

    override func isEqual(_ object: Any?) -> Bool {
        guard let other = object as? DocumentLineInfo else { return false }
        return other.line == line
    }

    override var hash: Int { line.id.hashValue }
}

final class DocumentMarks: NSObject, @unchecked Sendable {
    let marks: [String: YAny]
    init(_ marks: [String: YAny]) { self.marks = marks }
    override func isEqual(_ object: Any?) -> Bool { (object as? DocumentMarks)?.marks == marks }
    override var hash: Int { marks.keys.sorted().hashValue }
}

/// The colours the text carries, made once: a paragraph built again
/// compares equal to the one shown only if its colours are the same objects.
enum DocumentColors {
    static let text = UIColor(Palette.documentText)
    static let done = UIColor(Palette.documentDone)
    static let codeFill = UIColor(Palette.documentCodeFill)
    static let codeText = UIColor(Palette.documentCodeText)
    static let link = UIColor(Palette.documentLink)
    static let linkUnderline = UIColor(Palette.documentLink).withAlphaComponent(0.4)
    /// A CSS `#rrggbb` the document or a peer names; grey when it isn't one.
    static func css(_ hex: String) -> UIColor {
        let rgba = RGBA(hex: hex) ?? RGBA(red: 0.53, green: 0.53, blue: 0.53)
        return UIColor(ColorToken(light: rgba, dark: rgba))
    }

    static let named: [String: UIColor] = {
        var out: [String: UIColor] = [:]
        for (name, (text, fill)) in DocumentStyle.namedColors {
            out["text:" + name] = css(text)
            out["fill:" + name] = css(fill)
        }
        return out
    }()
}

/// Turns lines into the text view's attributed paragraphs and back. Pure
/// and thread-safe: the whole document is built off the main thread when
/// it opens; the main thread builds only the lines a change touched.
struct DocumentStyle: @unchecked Sendable {
    let traits: UITraitCollection

    init(traits: UITraitCollection) {
        self.traits = traits
    }

    func scaled(_ font: UIFont, _ style: UIFont.TextStyle = .body) -> UIFont {
        UIFontMetrics(forTextStyle: style).scaledFont(for: font, compatibleWith: traits)
    }

    func scaled(_ value: CGFloat) -> CGFloat {
        UIFontMetrics(forTextStyle: .body).scaledValue(for: value, compatibleWith: traits)
    }

    var bodyFont: UIFont { scaled(.systemFont(ofSize: DocumentTokens.bodySize)) }

    func baseFont(_ line: DocumentLine) -> UIFont {
        switch line.block.type {
        case "heading":
            let level = line.block.level
            return scaled(.systemFont(ofSize: DocumentTokens.headingSize(level), weight: level == 1 ? .bold : .semibold), .title1)
        case "codeBlock":
            return scaled(.monospacedSystemFont(ofSize: DocumentTokens.codeSize, weight: .regular))
        default:
            return bodyFont
        }
    }

    func lineHeight(_ line: DocumentLine) -> CGFloat {
        switch line.block.type {
        case "heading": scaled(DocumentTokens.headingLineHeight(line.block.level))
        case "codeBlock": scaled(22)
        default: scaled(DocumentTokens.bodyLineHeight)
        }
    }

    func kind(_ line: DocumentLine, numberWidth: CGFloat = 0) -> DocumentLineKind {
        switch line.block.type {
        case "heading": .heading(line.block.level)
        case "bulletListItem", "toggleListItem": .bullet
        case "numberedListItem": .numbered(width: numberWidth)
        case "checkListItem": .check
        case "quote": .quote
        case "codeBlock": .code
        default: line.block.isInline ? .text : .object
        }
    }

    var numberFont: UIFont { scaled(.monospacedDigitSystemFont(ofSize: DocumentTokens.bodySize, weight: .regular)) }

    func numberText(_ line: DocumentLine) -> String? { line.number.map { "\($0)." } }

    /// One line as its paragraph, its "\n" included.
    func paragraph(_ line: DocumentLine, previous: DocumentLine?) -> NSAttributedString {
        let number = numberText(line)
        let numberWidth = number.map { ceil(($0 as NSString).size(withAttributes: [.font: numberFont]).width) } ?? 0
        let kind = kind(line, numberWidth: numberWidth)
        let info = DocumentLineInfo(line: line, kind: kind, number: number)
        let indent = DocumentIndent(kind: kind, depth: line.depth)
        let style = NSMutableParagraphStyle()
        let height = lineHeight(line)
        style.minimumLineHeight = height
        style.maximumLineHeight = height
        style.firstLineHeadIndent = indent.firstLine
        style.headIndent = indent.head
        style.tailIndent = -indent.tail
        style.paragraphSpacingBefore = spacingBefore(line, previous: previous)
        let base = baseFont(line)
        let paragraphAttributes: [NSAttributedString.Key: Any] = [
            .paragraphStyle: style, .documentLine: info, .font: base, .foregroundColor: DocumentColors.text,
            .baselineOffset: (height - base.lineHeight) / 4,
        ]
        let out = NSMutableAttributedString()
        switch line.block.content {
        case .inline(let runs):
            for run in runs {
                var attributes = paragraphAttributes
                attributes[.documentMarks] = DocumentMarks(run.marks)
                apply(run.marks, to: &attributes, base: base, code: line.block.type == "codeBlock")
                if line.block.type == "checkListItem", line.block.checked {
                    attributes[.foregroundColor] = DocumentColors.done
                    attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
                }
                out.append(NSAttributedString(string: run.text.replacingOccurrences(of: "\n", with: String(DocumentText.lineBreak)), attributes: attributes))
            }
        default:
            var attributes = paragraphAttributes
            attributes[.attachment] = DocumentObjectAttachment(line: line, style: self)
            out.append(NSAttributedString(string: String(DocumentText.object), attributes: attributes))
        }
        var end = paragraphAttributes
        end[.documentMarks] = DocumentMarks(line.block.runs.last?.marks.filter { $0.key != "link" && $0.key != "code" } ?? [:])
        out.append(NSAttributedString(string: "\n", attributes: end))
        return out
    }

    func spacingBefore(_ line: DocumentLine, previous: DocumentLine?) -> CGFloat {
        guard let previous else { return 0 }
        if line.block.type == "heading" { return scaled(DocumentTokens.headingSpacing) }
        if line.block.type == "codeBlock" || previous.block.type == "codeBlock" { return scaled(DocumentTokens.blockSpacing) + DocumentMarkerLayout.Metrics.codeVertical * 2 }
        let list = DocumentSchema.listTypes
        if list.contains(line.block.type), list.contains(previous.block.type) { return scaled(2) }
        return scaled(DocumentTokens.blockSpacing)
    }

    private func apply(_ marks: [String: YAny], to attributes: inout [NSAttributedString.Key: Any], base: UIFont, code: Bool) {
        var traits: UIFontDescriptor.SymbolicTraits = base.fontDescriptor.symbolicTraits
        if marks["bold"] != nil { traits.insert(.traitBold) }
        if marks["italic"] != nil { traits.insert(.traitItalic) }
        var font = base
        if marks["code"] != nil, !code {
            font = scaled(.monospacedSystemFont(ofSize: DocumentTokens.codeSize, weight: marks["bold"] != nil ? .semibold : .regular))
            attributes[.backgroundColor] = DocumentColors.codeFill
            attributes[.foregroundColor] = DocumentColors.codeText
        }
        if traits != font.fontDescriptor.symbolicTraits, let descriptor = font.fontDescriptor.withSymbolicTraits(traits) {
            font = UIFont(descriptor: descriptor, size: font.pointSize)
        }
        attributes[.font] = font
        if marks["strike"] != nil { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
        if marks["underline"] != nil { attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue }
        if marks["link"] != nil {
            attributes[.foregroundColor] = DocumentColors.link
            attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
            attributes[.underlineColor] = DocumentColors.linkUnderline
        }
        if let color = marks["textColor"]?["stringValue"]?.stringValue, let named = Self.color(color, text: true) { attributes[.foregroundColor] = named }
        if let color = marks["backgroundColor"]?["stringValue"]?.stringValue, let named = Self.color(color, text: false) { attributes[.backgroundColor] = named }
    }

    /// BlockNote's named colours (`COLORS_DEFAULT`).
    static let namedColors: [String: (String, String)] = [
        "gray": ("#9b9a97", "#ebeced"), "brown": ("#64473a", "#e9e5e3"), "red": ("#e03e3e", "#fbe4e4"),
        "orange": ("#d9730d", "#f6e9d9"), "yellow": ("#dfab01", "#fbf3db"), "green": ("#4d6461", "#ddedea"),
        "blue": ("#0b6e99", "#ddebf1"), "purple": ("#6940a5", "#eae4f2"), "pink": ("#ad1a72", "#f4dfeb"),
    ]

    static func color(_ name: String, text: Bool) -> UIColor? {
        DocumentColors.named[(text ? "text:" : "fill:") + name]
    }

    /// The whole document, for opening.
    func document(_ lines: [DocumentLine]) -> NSAttributedString {
        let out = NSMutableAttributedString()
        var previous: DocumentLine?
        for line in lines {
            out.append(paragraph(line, previous: previous))
            previous = line
        }
        return out
    }

    // MARK: Reading back

    /// A paragraph's runs, read from the text view's storage.
    static func runs(_ text: NSAttributedString, _ range: NSRange) -> [DocumentRun] {
        var out: [DocumentRun] = []
        text.enumerateAttribute(.documentMarks, in: range, options: []) { value, subrange, _ in
            let piece = (text.string as NSString).substring(with: subrange)
            let marks = (value as? DocumentMarks)?.marks ?? [:]
            DocumentReader.append(&out, DocumentRun(DocumentText.blockText(piece), marks: marks))
        }
        return out
    }
}
#endif
