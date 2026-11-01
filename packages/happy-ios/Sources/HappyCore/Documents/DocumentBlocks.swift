import Foundation

/// A document Surface's content as blocks: what BlockNote 0.51's
/// `docToBlocks` reads from the Yjs fragment, kept as values the editor
/// draws and compares. The Yjs document stays the authority; these are
/// rebuilt from it.
public struct DocumentBlock: Equatable, Sendable {
    public var id: String
    /// The content element's name: `paragraph`, `heading`, `checkListItem`…
    public var type: String
    /// The content element's attributes as stored (`level`, `checked`, …).
    public var props: [String: YAny]
    public var content: Content
    public var children: [DocumentBlock]

    public enum Content: Equatable, Sendable {
        /// Text with formats. A hard break, and a code block's newline, is "\n".
        case inline([DocumentRun])
        /// A block with no text (divider, image, file…).
        case none
        /// A table's cells, row by row, each cell's text.
        case table([[[DocumentRun]]])
        /// Something outside BlockNote's model, kept and never written over.
        case unsupported(String)
    }

    public init(id: String, type: String, props: [String: YAny] = [:], content: Content, children: [DocumentBlock] = []) {
        self.id = id
        self.type = type
        self.props = props
        self.content = content
        self.children = children
    }

    public var runs: [DocumentRun] { if case let .inline(runs) = content { return runs }; return [] }
    public var plainText: String { runs.map(\.text).joined() }
}

/// A run of text with the formats over it, as y-prosemirror stores marks:
/// `bold: {}`, `link: {href}`, `textColor: {stringValue}`.
public struct DocumentRun: Equatable, Sendable {
    public var text: String
    public var marks: [String: YAny]

    public init(_ text: String, marks: [String: YAny] = [:]) {
        self.text = text
        self.marks = marks
    }
}

/// What the editor knows of BlockNote 0.51.4's default schema.
public enum DocumentSchema {
    public static let fragment = "document"
    public static let threads = "threads"

    /// Block types whose content is inline text.
    public static let inlineTypes: Set<String> = [
        "paragraph", "heading", "bulletListItem", "numberedListItem", "checkListItem",
        "toggleListItem", "quote", "codeBlock",
    ]
    /// Block types with no content.
    public static let emptyTypes: Set<String> = ["divider", "image", "video", "audio", "file", "pageBreak"]
    public static let listTypes: Set<String> = ["bulletListItem", "numberedListItem", "checkListItem", "toggleListItem"]

    /// Each type's attributes and defaults, in the order the schema declares them.
    public static func defaults(_ type: String) -> [(String, YAny)] {
        let colors: [(String, YAny)] = [("backgroundColor", .string("default")), ("textColor", .string("default")), ("textAlignment", .string("left"))]
        switch type {
        case "paragraph", "bulletListItem", "toggleListItem": return colors
        case "numberedListItem": return colors + [("start", .undefined)]
        case "heading": return colors + [("level", .number(1)), ("isToggleable", .bool(false))]
        case "checkListItem": return colors + [("checked", .bool(false))]
        case "quote": return [("backgroundColor", .string("default")), ("textColor", .string("default"))]
        case "codeBlock": return [("language", .string("text"))]
        case "image", "video":
            return [("textAlignment", .string("left")), ("backgroundColor", .string("default")), ("name", .string("")), ("url", .string("")), ("caption", .string("")), ("showPreview", .bool(true)), ("previewWidth", .undefined)]
        case "audio": return [("backgroundColor", .string("default")), ("name", .string("")), ("url", .string("")), ("caption", .string("")), ("showPreview", .bool(true))]
        case "file": return [("backgroundColor", .string("default")), ("name", .string("")), ("url", .string("")), ("caption", .string(""))]
        default: return []
        }
    }

    /// The marks Markdown and the toolbar know; others are kept as they are.
    public static let booleanMarks: Set<String> = ["bold", "italic", "underline", "strike", "code"]
}

extension DocumentBlock {
    public var level: Int { Int(props["level"]?.numberValue ?? 1) }
    public var checked: Bool { props["checked"]?.boolValue ?? false }
    public var language: String { props["language"]?.stringValue ?? "text" }
    public var isInline: Bool { if case .inline = content { return true }; return false }
}

/// Reads blocks out of a document (`yXmlFragmentToBlocks`).
public enum DocumentReader {
    public static func blocks(_ doc: YDoc) -> [DocumentBlock] {
        let fragment = doc.getXmlFragment(DocumentSchema.fragment)
        guard let group = fragment.children.first(where: { $0.nodeName == "blockGroup" }) else { return [] }
        return blocks(group: group)
    }

    public static func blocks(group: YType) -> [DocumentBlock] {
        group.children.compactMap { container in
            container.nodeName == "blockContainer" ? block(container: container) : nil
        }
    }

    public static func block(container: YType) -> DocumentBlock {
        let id = container.attribute("id")?.stringValue ?? ""
        let parts = container.children
        guard let element = parts.first, let type = element.nodeName else {
            return DocumentBlock(id: id, type: "", content: .unsupported("empty"))
        }
        let children = parts.dropFirst().first(where: { $0.nodeName == "blockGroup" }).map(blocks(group:)) ?? []
        let props = element.attributes
        let content: DocumentBlock.Content
        if DocumentSchema.inlineTypes.contains(type) {
            content = inline(element) ?? .unsupported(type)
        } else if DocumentSchema.emptyTypes.contains(type) {
            content = element.children.isEmpty && element.length == 0 ? .none : .unsupported(type)
        } else if type == "table" {
            content = table(element) ?? .unsupported(type)
        } else {
            content = .unsupported(type)
        }
        return DocumentBlock(id: id, type: type, props: props, content: content, children: children)
    }

    /// Text and hard breaks; nil when the element holds something else.
    static func inline(_ element: YType) -> DocumentBlock.Content? {
        var runs: [DocumentRun] = []
        for child in element.children {
            if child.isText {
                for op in child.toDelta() {
                    guard case let .text(text) = op.insert else { return nil }
                    append(&runs, DocumentRun(text, marks: op.attributes))
                }
            } else if child.nodeName == "hardBreak" {
                append(&runs, DocumentRun("\n", marks: runs.last?.marks ?? [:]))
            } else {
                return nil
            }
        }
        return .inline(runs)
    }

    /// Joins a run onto the last one when their formats match.
    public static func append(_ runs: inout [DocumentRun], _ run: DocumentRun) {
        guard !run.text.isEmpty else { return }
        if let last = runs.last, last.marks == run.marks {
            runs[runs.count - 1].text += run.text
        } else {
            runs.append(run)
        }
    }

    static func table(_ element: YType) -> DocumentBlock.Content? {
        var rows: [[[DocumentRun]]] = []
        for row in element.children where row.nodeName == "tableRow" {
            var cells: [[DocumentRun]] = []
            for cell in row.children where cell.nodeName == "tableCell" || cell.nodeName == "tableHeader" {
                var runs: [DocumentRun] = []
                for paragraph in cell.children {
                    if case let .inline(more)? = inline(paragraph) {
                        if !runs.isEmpty { append(&runs, DocumentRun("\n")) }
                        for run in more { append(&runs, run) }
                    }
                }
                cells.append(runs)
            }
            rows.append(cells)
        }
        return .table(rows)
    }
}
