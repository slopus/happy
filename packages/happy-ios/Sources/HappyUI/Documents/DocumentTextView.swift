#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A block without text, drawn in its paragraph's one U+FFFC: a divider's
/// line, a picture, a table's cells, or a note that something can't be
/// shown here. Read-only; Backspace removes it whole.
final class DocumentObjectAttachment: NSTextAttachment, @unchecked Sendable {
    let line: DocumentLine
    private let style: DocumentStyle
    /// A picture once read (`DocumentTextView.loadPictures`).
    var picture: UIImage?

    /// Pictures read so far, by URL; shared by every document.
    nonisolated(unsafe) static let pictures = NSCache<NSString, UIImage>()

    init(line: DocumentLine, style: DocumentStyle) {
        self.line = line
        self.style = style
        super.init(data: nil, ofType: nil)
        if let url = line.block.props["url"]?.stringValue { picture = Self.pictures.object(forKey: url as NSString) }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    /// The same block drawn the same way: a paragraph built again equals the one shown.
    override func isEqual(_ object: Any?) -> Bool {
        guard let other = object as? DocumentObjectAttachment else { return false }
        return other.line == line && other.picture === picture
    }

    override var hash: Int { line.id.hashValue }

    var url: String? { line.block.props["url"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } }
    var caption: String { line.block.props["caption"]?.stringValue ?? "" }

    private var rows: [[String]] {
        guard case let .table(rows) = line.block.content else { return [] }
        return rows.map { $0.map { $0.map(\.text).joined() } }
    }

    private var kind: DocumentObjectLayout.Kind {
        switch line.block.type {
        case "divider": .divider(line: style.scaled(DocumentTokens.bodyLineHeight))
        case "image": .picture(picture?.size)
        case "table": .table(rows: rows.count, row: style.scaled(32))
        default: .unsupported(height: style.scaled(44))
        }
    }

    func size(width: CGFloat) -> CGSize {
        DocumentObjectLayout.size(kind, width: width, depth: line.depth)
    }

    override func attachmentBounds(for attributes: [NSAttributedString.Key: Any], location: any NSTextLocation, textContainer: NSTextContainer?, proposedLineFragment: CGRect, position: CGPoint) -> CGRect {
        CGRect(origin: .zero, size: size(width: proposedLineFragment.width))
    }

    override func image(for bounds: CGRect, attributes: [NSAttributedString.Key: Any], location: any NSTextLocation, textContainer: NSTextContainer?) -> UIImage? {
        let format = UIGraphicsImageRendererFormat.preferred()
        let traits = style.traits
        return UIGraphicsImageRenderer(size: bounds.size, format: format).image { context in
            traits.performAsCurrent { self.draw(in: CGRect(origin: .zero, size: bounds.size), context: context.cgContext) }
        }
    }

    private func draw(in rect: CGRect, context: CGContext) {
        let secondary: [NSAttributedString.Key: Any] = [.font: style.bodyFont, .foregroundColor: UIColor(Palette.documentSecondary)]
        switch line.block.type {
        case "divider":
            UIColor(Palette.documentRule).setFill()
            context.fill(DocumentObjectLayout.rule(in: rect.size))
        case "image":
            let shape = UIBezierPath(roundedRect: rect, cornerRadius: DocumentObjectLayout.Metrics.corner)
            if let picture {
                shape.addClip()
                picture.draw(in: rect)
            } else {
                UIColor(Palette.documentCodeFill).setFill()
                shape.fill()
                let label = (caption.isEmpty ? (line.block.props["name"]?.stringValue ?? Strings.Documents.picture) : caption) as NSString
                label.draw(at: DocumentObjectLayout.centered(label.size(withAttributes: secondary), in: rect.size).origin, withAttributes: secondary)
            }
        case "table":
            let rows = rows
            let font = style.scaled(.systemFont(ofSize: 15))
            let table = DocumentObjectLayout.Table(rows: rows.count, columns: rows.map(\.count).max() ?? 1, size: rect.size, textHeight: ceil(font.lineHeight))
            UIColor(Palette.documentRule).setStroke()
            let grid = UIBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), cornerRadius: DocumentObjectLayout.Metrics.tableCorner)
            for y in table.rowLines { grid.move(to: CGPoint(x: 0, y: y)); grid.addLine(to: CGPoint(x: rect.width, y: y)) }
            for x in table.columnLines { grid.move(to: CGPoint(x: x, y: 0)); grid.addLine(to: CGPoint(x: x, y: rect.height)) }
            grid.lineWidth = 1
            grid.stroke()
            let text: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor(Palette.documentText)]
            for (row, frames) in zip(rows, table.cells) {
                for (cell, frame) in zip(row, frames) {
                    NSAttributedString(string: cell, attributes: text).draw(with: frame, options: [.truncatesLastVisibleLine, .usesLineFragmentOrigin], context: nil)
                }
            }
        default:
            UIColor(Palette.documentCodeFill).setFill()
            UIBezierPath(roundedRect: rect, cornerRadius: DocumentObjectLayout.Metrics.corner).fill()
            let label = Strings.Documents.unsupported as NSString
            label.draw(at: DocumentObjectLayout.note(label.size(withAttributes: secondary), in: rect.size).origin, withAttributes: secondary)
        }
    }

    var accessibilityName: String {
        switch line.block.type {
        case "divider": Strings.Documents.dividerLine
        case "image": caption.isEmpty ? Strings.Documents.picture : "\(Strings.Documents.picture), \(caption)"
        case "table": Strings.Documents.table
        default: Strings.Documents.unsupported
        }
    }
}

/// A paragraph's marker drawn beside its text: a list's bullet or number,
/// a task's box, a quote's bar, a code block's fill (`DocumentMarkerLayout`).
final class DocumentLayoutFragment: NSTextLayoutFragment, @unchecked Sendable {
    var info: DocumentLineInfo?
    var numberFont: UIFont = .systemFont(ofSize: 17)

    private func marker() -> DocumentMarkerLayout? {
        guard let info, let first = textLineFragments.first, let last = textLineFragments.last else { return nil }
        return DocumentMarkerLayout(kind: info.kind, depth: info.line.depth, firstLine: first.typographicBounds, lastLine: last.typographicBounds,
                                    origin: layoutFragmentFrame.minX, width: textLayoutManager?.textContainer?.size.width ?? layoutFragmentFrame.maxX)
    }

    /// Where a tap toggles this task, in the fragment's coordinates.
    var checkTarget: CGRect? { marker()?.target }

    override var renderingSurfaceBounds: CGRect {
        // The marker column, left of the text, and a code block's fill past it.
        let whole = super.renderingSurfaceBounds.union(CGRect(origin: .zero, size: layoutFragmentFrame.size))
        guard let layout = marker() else { return whole }
        return [layout.marker, layout.decoration].compactMap { $0 }.reduce(whole) { $0.union($1.insetBy(dx: -1, dy: -1)) }
    }

    override func draw(at point: CGPoint, in context: CGContext) {
        if let info, let layout = marker() {
            context.saveGState()
            switch info.kind {
            case .bullet:
                if let rect = layout.marker {
                    UIColor(Palette.documentText).setFill()
                    let dot = rect.offsetBy(dx: point.x, dy: point.y)
                    if info.line.depth % 2 == 1 {
                        UIColor(Palette.documentText).setStroke()
                        let ring = UIBezierPath(ovalIn: dot.insetBy(dx: 0.75, dy: 0.75))
                        ring.lineWidth = 1.5
                        ring.stroke()
                    } else {
                        context.fillEllipse(in: dot)
                    }
                }
            case .numbered:
                if let rect = layout.marker, let number = info.number {
                    let attributes: [NSAttributedString.Key: Any] = [.font: numberFont, .foregroundColor: UIColor(Palette.documentSecondary)]
                    let place = DocumentMarkerLayout.number((number as NSString).size(withAttributes: attributes), in: rect.offsetBy(dx: point.x, dy: point.y))
                    (number as NSString).draw(at: place.origin, withAttributes: attributes)
                }
            case .check:
                if let rect = layout.marker {
                    let box = UIBezierPath(roundedRect: rect.offsetBy(dx: point.x, dy: point.y).insetBy(dx: 0.75, dy: 0.75), cornerRadius: DocumentMarkerLayout.Metrics.checkCorner)
                    if info.line.block.checked {
                        UIColor(Palette.documentCheck).setFill()
                        box.fill()
                        let tick = UIBezierPath()
                        let r = rect.offsetBy(dx: point.x, dy: point.y)
                        tick.move(to: CGPoint(x: r.minX + r.width * 0.26, y: r.minY + r.height * 0.52))
                        tick.addLine(to: CGPoint(x: r.minX + r.width * 0.43, y: r.minY + r.height * 0.69))
                        tick.addLine(to: CGPoint(x: r.minX + r.width * 0.75, y: r.minY + r.height * 0.33))
                        tick.lineWidth = 2
                        tick.lineCapStyle = .round
                        tick.lineJoinStyle = .round
                        UIColor(Palette.documentCheckTick).setStroke()
                        tick.stroke()
                    } else {
                        box.lineWidth = 1.5
                        UIColor(Palette.documentSecondary).setStroke()
                        box.stroke()
                    }
                }
            case .quote:
                if let rect = layout.decoration {
                    UIColor(Palette.documentRule).setFill()
                    context.fill(rect.offsetBy(dx: point.x, dy: point.y))
                }
            case .code:
                if let rect = layout.decoration {
                    UIColor(Palette.documentCodeFill).setFill()
                    UIBezierPath(roundedRect: rect.offsetBy(dx: point.x, dy: point.y), cornerRadius: DocumentMarkerLayout.Metrics.codeCorner).fill()
                }
            case .text, .heading, .object:
                break
            }
            context.restoreGState()
        }
        super.draw(at: point, in: context)
    }
}

/// The document's text view: TextKit 2 (docs/DOCUMENT-EDITOR.md), one
/// paragraph per block, markers drawn by `DocumentLayoutFragment`.
final class DocumentTextView: UITextView, @preconcurrency NSTextLayoutManagerDelegate {
    var numberFont: UIFont = .systemFont(ofSize: 17)

    init() {
        super.init(frame: .zero, textContainer: nil)
        textLayoutManager?.delegate = self
        textContainer.lineFragmentPadding = 0
        alwaysBounceVertical = true
        keyboardDismissMode = .interactive
        smartDashesType = .no
        smartQuotesType = .default
        backgroundColor = UIColor(Palette.documentGround)
        tintColor = UIColor(Palette.documentLink)
        adjustsFontForContentSizeCategory = false
        accessibilityIdentifier = "document.text"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func textLayoutManager(_ textLayoutManager: NSTextLayoutManager, textLayoutFragmentFor location: any NSTextLocation, in textElement: NSTextElement) -> NSTextLayoutFragment {
        let fragment = DocumentLayoutFragment(textElement: textElement, range: textElement.elementRange)
        fragment.numberFont = numberFont
        if let paragraph = textElement as? NSTextParagraph, paragraph.attributedString.length > 0 {
            fragment.info = paragraph.attributedString.attribute(.documentLine, at: 0, effectiveRange: nil) as? DocumentLineInfo
        }
        return fragment
    }

    /// The task whose box is under `point`, if any.
    func task(at point: CGPoint) -> String? {
        guard let manager = textLayoutManager else { return nil }
        let inContainer = CGPoint(x: point.x - textContainerInset.left, y: point.y - textContainerInset.top)
        let probe = CGPoint(x: max(0, inContainer.x), y: inContainer.y)
        guard let fragment = manager.textLayoutFragment(for: probe) as? DocumentLayoutFragment ?? nearbyFragment(manager, probe),
              let info = fragment.info, info.line.block.type == "checkListItem", let target = fragment.checkTarget else { return nil }
        let local = CGPoint(x: inContainer.x - fragment.layoutFragmentFrame.minX, y: inContainer.y - fragment.layoutFragmentFrame.minY)
        return target.contains(local) ? info.id : nil
    }

    /// A tap a little above or below a short line still finds it.
    private func nearbyFragment(_ manager: NSTextLayoutManager, _ point: CGPoint) -> DocumentLayoutFragment? {
        for dy in [-8.0, 8.0] {
            if let found = manager.textLayoutFragment(for: CGPoint(x: point.x, y: point.y + dy)) as? DocumentLayoutFragment { return found }
        }
        return nil
    }

    // MARK: Keys

    /// Backspace with nothing selected; true when it was handled.
    var onBackspace: (() -> Bool)?
    var onTool: ((DocumentTool) -> Void)?
    /// A text style from the keyboard: 0 for text, else a heading level.
    var onStyle: ((Int) -> Void)?
    var onHardBreak: (() -> Void)?

    /// `insertText` from code or some hardware paths skips the delegate the
    /// keyboard asks first; it is asked here too, so Enter and the shortcuts
    /// behave the same whichever way the text came. Asking twice is harmless.
    override func insertText(_ text: String) {
        if markedTextRange == nil, delegate?.textView?(self, shouldChangeTextIn: selectedRange, replacementText: text) == false { return }
        super.insertText(text)
    }

    override func deleteBackward() {
        if selectedRange.length == 0, markedTextRange == nil, onBackspace?() == true { return }
        super.deleteBackward()
    }

    override func toggleBoldface(_ sender: Any?) { onTool?(.bold) }
    override func toggleItalics(_ sender: Any?) { onTool?(.italic) }

    /// Desktop's shortcuts (BlockNote's keyboard map), as an iPad's keyboard sends them.
    override var keyCommands: [UIKeyCommand]? {
        guard isFirstResponder else { return super.keyCommands }
        func command(_ input: String, _ flags: UIKeyModifierFlags, _ title: String, _ action: Selector) -> UIKeyCommand {
            let made = UIKeyCommand(title: title, action: action, input: input, modifierFlags: flags)
            made.wantsPriorityOverSystemBehavior = true
            return made
        }
        return [
            command("k", .command, Strings.Documents.link, #selector(keyLink)),
            command("s", [.command, .shift], Strings.Documents.strike, #selector(keyStrike)),
            command("e", .command, Strings.Documents.code, #selector(keyCode)),
            command("0", [.command, .alternate], Strings.Documents.text, #selector(keyText)),
            command("1", [.command, .alternate], Strings.Documents.heading(1), #selector(keyHeading1)),
            command("2", [.command, .alternate], Strings.Documents.heading(2), #selector(keyHeading2)),
            command("3", [.command, .alternate], Strings.Documents.heading(3), #selector(keyHeading3)),
            command("7", [.command, .shift], Strings.Documents.numbers, #selector(keyNumbers)),
            command("8", [.command, .shift], Strings.Documents.bullets, #selector(keyBullets)),
            command("9", [.command, .shift], Strings.Documents.checklist, #selector(keyChecklist)),
            command("\t", [], Strings.Documents.indent, #selector(keyIndent)),
            command("\t", .shift, Strings.Documents.outdent, #selector(keyOutdent)),
            command("\r", .shift, Strings.Documents.lineBreak, #selector(keyHardBreak)),
        ] + (super.keyCommands ?? [])
    }

    @objc private func keyLink() { onTool?(.link) }
    @objc private func keyStrike() { onTool?(.strike) }
    @objc private func keyCode() { onTool?(.code) }
    @objc private func keyText() { onStyle?(0) }
    @objc private func keyHeading1() { onStyle?(1) }
    @objc private func keyHeading2() { onStyle?(2) }
    @objc private func keyHeading3() { onStyle?(3) }
    @objc private func keyNumbers() { onTool?(.numbers) }
    @objc private func keyBullets() { onTool?(.bullets) }
    @objc private func keyChecklist() { onTool?(.checklist) }
    @objc private func keyIndent() { onTool?(.indent) }
    @objc private func keyOutdent() { onTool?(.outdent) }
    @objc private func keyHardBreak() { onHardBreak?() }

    /// The UTF-16 offset of a TextKit 2 location.
    func offset(_ location: any NSTextLocation) -> Int {
        guard let manager = textLayoutManager else { return 0 }
        return manager.offset(from: manager.documentRange.location, to: location)
    }
}
#endif
