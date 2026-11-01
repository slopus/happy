import Foundation

/// A caret in the editor's terms: a block and a UTF-16 offset into its text,
/// where a hard break counts as one.
public struct DocumentCaret: Hashable, Sendable {
    public var id: String
    public var offset: Int

    public init(id: String, offset: Int) {
        self.id = id
        self.offset = offset
    }
}

/// Carets as relative positions, the way y-prosemirror makes them
/// (`absolutePositionToRelativePosition`, `relativePositionToAbsolutePosition`),
/// so a cursor sent from here lands where desktop draws it and back. They
/// also hold the local selection still while a remote edit merges.
extension DocumentEditor {
    public func relativePosition(_ caret: DocumentCaret) -> YRelativePosition? {
        guard let element = contentElement(caret.id) else { return nil }
        let children = element.children
        if children.isEmpty { return YRelativePosition(type: element.itemID, tname: nil, item: nil) }
        var remaining = max(0, caret.offset)
        for child in children {
            if child.isText {
                if child.length >= remaining { return YRelativePosition(child, index: remaining) }
                remaining -= child.length
            } else {
                remaining -= 1
            }
        }
        return YRelativePosition(element, index: children.count)
    }

    public func caret(_ position: YRelativePosition) -> DocumentCaret? {
        guard let (type, index) = position.resolve(in: doc) else { return nil }
        let element: YType
        var offset = 0
        if type.isText {
            guard let parent = type.parent else { return nil }
            element = parent
            for child in parent.children {
                if child === type { break }
                offset += child.isText ? child.length : 1
            }
            offset += index
        } else {
            element = type
            for child in type.children.prefix(index) { offset += child.isText ? child.length : 1 }
        }
        var node: YType? = type
        while let current = node {
            if current.item?.deleted == true { return nil }
            node = current.parent
        }
        guard let container = element.parent, container.nodeName == "blockContainer",
              let id = container.attribute("id")?.stringValue, let line = line(id) else { return nil }
        return DocumentCaret(id: id, offset: min(offset, line.length))
    }

    private func contentElement(_ id: String) -> YType? {
        guard let container = containers[id], let element = container.children.first, element.nodeName != "blockGroup" else { return nil }
        return element
    }
}
