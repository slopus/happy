import Foundation

/// One line of the editor: a block without its children, at its depth.
public struct DocumentLine: Equatable, Sendable {
    public var block: DocumentBlock
    public var depth: Int
    /// A numbered item's number.
    public var number: Int?

    public init(block: DocumentBlock, depth: Int = 0, number: Int? = nil) {
        self.block = block
        self.depth = depth
        self.number = number
    }

    public var id: String { block.id }
    /// UTF-16 length of what the line shows: its text, or one unit for a block without text.
    public var length: Int { block.isInline ? block.plainText.utf16.count : 1 }
}

/// What a transaction changed in the lines: `old` lines replaced by `new` ones.
public struct DocumentLinesChange: Equatable, Sendable {
    public var range: Range<Int>
    public var lines: [DocumentLine]
    public var local: Bool
}

/// A document Surface open for editing: the Yjs document and the blocks
/// read from it, with every edit the editor makes written as the Yjs
/// structure y-prosemirror writes for the same edit in BlockNote, so
/// desktop reads exactly what was typed here.
///
/// Belongs to one thread (the main thread in the app).
public final class DocumentEditor {
    public let doc: YDoc
    public private(set) var blocks: [DocumentBlock] = []
    public private(set) var lines: [DocumentLine] = []
    /// Every local change, as the update to send.
    public var onLocalUpdate: (([UInt8]) -> Void)?
    /// Lines that changed, local or remote, after each transaction.
    public var onLinesChange: ((DocumentLinesChange) -> Void)?

    private var cache: [YID: DocumentBlock] = [:]
    var containers: [String: YType] = [:]

    public init(doc: YDoc) {
        self.doc = doc
        doc.onTransaction = { [weak self] result in self?.transactionEnded(result) }
        reread(dirty: nil)
        lines = Self.flatten(blocks)
    }

    // MARK: Reading

    private var fragment: YType { doc.getXmlFragment(DocumentSchema.fragment) }
    private var rootGroup: YType? { fragment.children.first { $0.nodeName == "blockGroup" } }

    private func transactionEnded(_ result: YTransactionResult) {
        if result.local { onLocalUpdate?(result.update) }
        var dirty = Set<YID>()
        for type in result.changed {
            var current: YType? = type
            while let node = current {
                if node.nodeName == "blockContainer", let id = node.itemID { dirty.insert(id) }
                current = node.parent
            }
        }
        let before = lines
        reread(dirty: dirty)
        let after = Self.flatten(blocks)
        lines = after
        if let change = Self.diff(before, after, local: result.local) { onLinesChange?(change) }
    }

    /// Reads blocks again, reusing those no change touched.
    private func reread(dirty: Set<YID>?) {
        var nextCache: [YID: DocumentBlock] = [:]
        var nextContainers: [String: YType] = [:]
        func read(_ group: YType) -> [DocumentBlock] {
            group.children.compactMap { container -> DocumentBlock? in
                guard container.nodeName == "blockContainer" else { return nil }
                let key = container.itemID ?? YID(client: -1, clock: 0)
                var block: DocumentBlock
                if let dirty, !dirty.contains(key), let cached = cache[key] {
                    block = cached
                    reuse(container, block)
                } else {
                    block = DocumentReader.block(container: container)
                    if let group = container.children.dropFirst().first(where: { $0.nodeName == "blockGroup" }) {
                        block.children = read(group)
                    } else {
                        block.children = []
                    }
                }
                nextCache[key] = block
                nextContainers[block.id] = container
                return block
            }
        }
        // A reused block's descendants stay as they were; index them too.
        func reuse(_ container: YType, _ block: DocumentBlock) {
            guard !block.children.isEmpty, let group = container.children.dropFirst().first(where: { $0.nodeName == "blockGroup" }) else { return }
            for (child, childBlock) in zip(group.children.filter { $0.nodeName == "blockContainer" }, block.children) {
                if let key = child.itemID { nextCache[key] = childBlock }
                nextContainers[childBlock.id] = child
                reuse(child, childBlock)
            }
        }
        blocks = rootGroup.map(read) ?? []
        cache = nextCache
        containers = nextContainers
    }

    public static func flatten(_ blocks: [DocumentBlock], depth: Int = 0) -> [DocumentLine] {
        var out: [DocumentLine] = []
        var number = 0
        for block in blocks {
            if block.type == "numberedListItem" {
                if number == 0, let start = block.props["start"]?.numberValue { number = Int(start) } else { number += 1 }
            } else {
                number = 0
            }
            var bare = block
            bare.children = []
            out.append(DocumentLine(block: bare, depth: depth, number: block.type == "numberedListItem" ? number : nil))
            out += flatten(block.children, depth: depth + 1)
        }
        return out
    }

    static func diff(_ old: [DocumentLine], _ new: [DocumentLine], local: Bool) -> DocumentLinesChange? {
        var prefix = 0
        while prefix < old.count, prefix < new.count, old[prefix] == new[prefix] { prefix += 1 }
        if prefix == old.count, prefix == new.count { return nil }
        var suffix = 0
        while suffix < old.count - prefix, suffix < new.count - prefix, old[old.count - 1 - suffix] == new[new.count - 1 - suffix] { suffix += 1 }
        return DocumentLinesChange(range: prefix..<(old.count - suffix), lines: Array(new[prefix..<(new.count - suffix)]), local: local)
    }

    public func line(_ id: String) -> DocumentLine? { lines.first { $0.id == id } }
    public func lineIndex(_ id: String) -> Int? { lines.firstIndex { $0.id == id } }

    // MARK: Remote

    /// Applies a change from the computer or another replica.
    public func apply(remote update: [UInt8]) throws {
        try doc.applyUpdate(update, origin: "remote")
    }

    // MARK: Editing

    /// Sets a line's text and formats, writing only the difference.
    public func setRuns(_ id: String, _ runs: [DocumentRun]) {
        guard let container = containers[id], let element = container.children.first, let line = line(id), line.block.isInline else { return }
        let code = line.block.type == "codeBlock"
        doc.transact { tr in
            writeInline(tr, element, runs: Self.normalized(runs), code: code)
        }
    }

    /// Changes a line's type, keeping its text (a paragraph made a heading).
    public func setType(_ id: String, _ type: String, props: [String: YAny] = [:]) {
        guard let line = line(id) else { return }
        var block = line.block
        if block.type == type {
            setProps(id, props)
            return
        }
        block.type = type
        block.props = Self.carriedProps(from: line.block, to: type).merging(props) { _, new in new }
        if type == "codeBlock" { block.content = .inline([DocumentRun(line.block.plainText)]) }
        replaceContent(id, with: block)
    }

    public func setProps(_ id: String, _ props: [String: YAny]) {
        guard let container = containers[id], let element = container.children.first else { return }
        doc.transact { tr in
            for (key, value) in props.sorted(by: { $0.key < $1.key }) where element.attribute(key) != value {
                element.setAttribute(tr, key, value)
            }
        }
    }

    public func toggleChecked(_ id: String) {
        guard let line = line(id), line.block.type == "checkListItem" else { return }
        setProps(id, ["checked": .bool(!line.block.checked)])
    }

    /// Replaces the lines in `range` with `new` ones: the one primitive
    /// every structural edit (split, join, paste, indent, delete) goes
    /// through. Lines keep their IDs where they stay; the tree is written
    /// as the difference from what the document holds.
    public func replaceLines(_ range: Range<Int>, with new: [DocumentLine]) {
        var all = lines
        all.replaceSubrange(range, with: new)
        reconcile(Self.tree(all))
    }

    /// The tree flat lines describe: a line deeper than the one before is its child.
    public static func tree(_ lines: [DocumentLine]) -> [DocumentBlock] {
        var index = 0
        func build(_ depth: Int) -> [DocumentBlock] {
            var out: [DocumentBlock] = []
            while index < lines.count {
                let line = lines[index]
                let lineDepth = min(line.depth, out.isEmpty ? depth : depth + 1)
                if lineDepth < depth { break }
                if lineDepth > depth {
                    out[out.count - 1].children += build(depth + 1)
                    continue
                }
                var block = line.block
                block.children = []
                out.append(block)
                index += 1
            }
            return out
        }
        return build(0)
    }

    public static func newID() -> String { UUID().uuidString.lowercased() }

    // MARK: Writing the tree

    /// Writes `desired` as the difference from the current blocks.
    public func reconcile(_ desired: [DocumentBlock]) {
        doc.transact { tr in
            let group: YType
            if let existing = rootGroup {
                group = existing
            } else {
                group = YDoc.element("blockGroup")
                fragment.insert(tr, at: fragment.length, [group])
            }
            reconcile(tr, group: group, current: blocks, desired: desired)
        }
    }

    private func reconcile(_ tr: YTransaction, group: YType, current: [DocumentBlock], desired: [DocumentBlock]) {
        let kept = Self.keptIDs(current.map(\.id), desired.map(\.id))
        // Blocks that leave this group, or move within it, go; a move is written as a new copy.
        for block in current where !kept.contains(block.id) {
            if let container = containers[block.id], let index = group.index(of: container) {
                group.delete(tr, at: index, count: 1)
            }
        }
        let currentByID = Dictionary(current.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var previous: YType?
        for block in desired {
            if kept.contains(block.id), let container = containers[block.id], let old = currentByID[block.id] {
                update(tr, container, from: old, to: block)
                previous = container
            } else {
                let container = makeContainer(block)
                group.insert(tr, after: previous?.item ?? nil, [container])
                fill(tr, container, block)
                previous = container
            }
        }
    }

    /// IDs both lists hold in the same relative order (a longest increasing run).
    static func keptIDs(_ current: [String], _ desired: [String]) -> Set<String> {
        let positions = Dictionary(current.enumerated().map { ($0.element, $0.offset) }, uniquingKeysWith: { a, _ in a })
        let sequence = desired.compactMap { id in positions[id].map { (id, $0) } }
        // Patience sorting for the longest increasing subsequence of positions.
        var tails: [Int] = []
        var tailIndex: [Int] = []
        var parent = Array(repeating: -1, count: sequence.count)
        for (i, item) in sequence.enumerated() {
            var low = 0
            var high = tails.count
            while low < high {
                let mid = (low + high) / 2
                if tails[mid] < item.1 { low = mid + 1 } else { high = mid }
            }
            if low > 0 { parent[i] = tailIndex[low - 1] }
            if low == tails.count { tails.append(item.1); tailIndex.append(i) } else { tails[low] = item.1; tailIndex[low] = i }
        }
        var kept = Set<String>()
        var k = tailIndex.last ?? -1
        while k >= 0 {
            kept.insert(sequence[k].0)
            k = parent[k]
        }
        return kept
    }

    private func update(_ tr: YTransaction, _ container: YType, from old: DocumentBlock, to new: DocumentBlock) {
        var oldBare = old
        oldBare.children = []
        var newBare = new
        newBare.children = []
        if oldBare != newBare {
            if case .unsupported = old.content {
                // Never written over: what this editor can't read stays as it is.
            } else if old.type == new.type, let element = container.children.first {
                for (key, value) in new.props.sorted(by: { $0.key < $1.key }) where element.attribute(key) != value {
                    element.setAttribute(tr, key, value)
                }
                if old.content != new.content, case let .inline(runs) = new.content {
                    writeInline(tr, element, runs: Self.normalized(runs), code: new.type == "codeBlock")
                }
            } else {
                container.delete(tr, at: 0, count: 1)
                let element = makeElement(new)
                container.insert(tr, at: 0, [element])
                fillElement(tr, element, new)
            }
        }
        let group = container.children.dropFirst().first { $0.nodeName == "blockGroup" }
        if new.children.isEmpty {
            if let group, let index = container.index(of: group) { container.delete(tr, at: index, count: 1) }
        } else if let group {
            reconcile(tr, group: group, current: old.children, desired: new.children)
        } else {
            let group = YDoc.element("blockGroup")
            container.insert(tr, at: container.length, [group])
            for child in new.children.reversed() {
                let childContainer = makeContainer(child)
                group.insert(tr, at: 0, [childContainer])
                fill(tr, childContainer, child)
            }
        }
    }

    private func replaceContent(_ id: String, with block: DocumentBlock) {
        guard let container = containers[id], let key = container.itemID, let old = cache[key] else { return }
        var next = block
        next.children = old.children
        doc.transact { tr in update(tr, container, from: old, to: next) }
    }

    private func makeContainer(_ block: DocumentBlock) -> YType { YDoc.element("blockContainer") }

    /// Writes a new container's ID, content and children; it is in the document already.
    private func fill(_ tr: YTransaction, _ container: YType, _ block: DocumentBlock) {
        let element = makeElement(block)
        container.insert(tr, at: 0, [element])
        fillElement(tr, element, block)
        if !block.children.isEmpty {
            let group = YDoc.element("blockGroup")
            container.insert(tr, at: 1, [group])
            var previous: YType?
            for child in block.children {
                let childContainer = makeContainer(child)
                group.insert(tr, after: previous?.item ?? nil, [childContainer])
                fill(tr, childContainer, child)
                previous = childContainer
            }
        }
        container.setAttribute(tr, "id", .string(block.id))
    }

    private func makeElement(_ block: DocumentBlock) -> YType { YDoc.element(block.type) }

    /// A new content element's attributes and text, as y-prosemirror writes
    /// a new node: every attribute the schema has, then the given ones.
    private func fillElement(_ tr: YTransaction, _ element: YType, _ block: DocumentBlock) {
        if case let .inline(runs) = block.content {
            writeInline(tr, element, runs: Self.normalized(runs), code: block.type == "codeBlock")
        }
        var written = Set<String>()
        for (key, value) in DocumentSchema.defaults(block.type) {
            let final = block.props[key] ?? value
            written.insert(key)
            if final != .undefined { element.setAttribute(tr, key, final) }
        }
        for (key, value) in block.props.sorted(by: { $0.key < $1.key }) where !written.contains(key) && value != .undefined {
            element.setAttribute(tr, key, value)
        }
    }

    /// What a line keeps when it becomes another type: colors carry, the rest is the new type's.
    static func carriedProps(from block: DocumentBlock, to type: String) -> [String: YAny] {
        var props: [String: YAny] = [:]
        let keys = Set(DocumentSchema.defaults(type).map(\.0))
        for (key, value) in block.props where keys.contains(key) && ["backgroundColor", "textColor", "textAlignment"].contains(key) {
            props[key] = value
        }
        return props
    }

    // MARK: Inline content

    /// Runs joined where their formats match, empty ones dropped.
    static func normalized(_ runs: [DocumentRun]) -> [DocumentRun] {
        var out: [DocumentRun] = []
        for run in runs { DocumentReader.append(&out, run) }
        return out
    }

    private enum Segment {
        case text([DocumentRun])
        case hardBreak
    }

    /// Text pieces between hard breaks; a code block's newlines stay in its text.
    private static func segments(_ runs: [DocumentRun], code: Bool) -> [Segment] {
        if code { return runs.isEmpty ? [] : [.text(runs)] }
        var out: [Segment] = []
        var pending: [DocumentRun] = []
        for run in runs {
            let parts = run.text.components(separatedBy: "\n")
            for (index, part) in parts.enumerated() {
                if index > 0 {
                    if !pending.isEmpty { out.append(.text(pending)); pending = [] }
                    out.append(.hardBreak)
                }
                if !part.isEmpty { DocumentReader.append(&pending, DocumentRun(part, marks: run.marks)) }
            }
        }
        if !pending.isEmpty { out.append(.text(pending)) }
        return out
    }

    /// Makes an element's text and hard breaks say `runs`: text the
    /// element keeps is diffed in place, the rest replaced.
    private func writeInline(_ tr: YTransaction, _ element: YType, runs: [DocumentRun], code: Bool) {
        let wanted = Self.segments(runs, code: code)
        let children = element.children
        func isText(_ t: YType) -> Bool { t.isText }
        func kindMatches(_ child: YType, _ segment: Segment) -> Bool {
            switch segment {
            case .text: return child.isText
            case .hardBreak: return child.nodeName == "hardBreak"
            }
        }
        var prefix = 0
        while prefix < children.count, prefix < wanted.count, kindMatches(children[prefix], wanted[prefix]) { prefix += 1 }
        var suffix = 0
        while suffix < children.count - prefix, suffix < wanted.count - prefix,
              kindMatches(children[children.count - 1 - suffix], wanted[wanted.count - 1 - suffix]) { suffix += 1 }
        for i in 0..<prefix { if case let .text(r) = wanted[i] { diffText(tr, children[i], r) } }
        for i in 0..<suffix {
            let child = children[children.count - 1 - i]
            if case let .text(r) = wanted[wanted.count - 1 - i] { diffText(tr, child, r) }
        }
        let removeCount = children.count - prefix - suffix
        if removeCount > 0 { element.delete(tr, at: prefix, count: removeCount) }
        var at = prefix
        for segment in wanted[prefix..<(wanted.count - suffix)] {
            switch segment {
            case .hardBreak:
                element.insert(tr, at: at, [YDoc.element("hardBreak")])
            case let .text(r):
                let text = YDoc.text()
                element.insert(tr, at: at, [text])
                var index = 0
                for run in r {
                    text.insertText(tr, at: index, run.text, attributes: Self.pairs(run.marks))
                    index += run.text.utf16.count
                }
            }
            at += 1
        }
    }

    static func pairs(_ marks: [String: YAny]) -> [(String, YAny)] { marks.sorted { $0.key < $1.key }.map { ($0.key, $0.value) } }

    /// Writes the difference between a text's content and `runs`: the
    /// changed middle replaced, then formats fixed where only they changed.
    private func diffText(_ tr: YTransaction, _ text: YType, _ runs: [DocumentRun]) {
        let old = text.toDelta().compactMap { op -> DocumentRun? in
            if case let .text(s) = op.insert { return DocumentRun(s, marks: op.attributes) }
            return nil
        }
        if old == runs { return }
        let oldUnits = Array(old.map(\.text).joined().utf16)
        let newUnits = Array(runs.map(\.text).joined().utf16)
        let oldMarks = Self.markIndex(old)
        let newMarks = Self.markIndex(runs)
        var prefix = 0
        while prefix < oldUnits.count, prefix < newUnits.count, oldUnits[prefix] == newUnits[prefix] { prefix += 1 }
        // Never split a surrogate pair: back off to the pair's start or end.
        if prefix > 0, (0xD800...0xDBFF).contains(oldUnits[prefix - 1]) { prefix -= 1 }
        var suffix = 0
        while suffix < oldUnits.count - prefix, suffix < newUnits.count - prefix, oldUnits[oldUnits.count - 1 - suffix] == newUnits[newUnits.count - 1 - suffix] { suffix += 1 }
        if suffix > 0, (0xDC00...0xDFFF).contains(oldUnits[oldUnits.count - suffix]) { suffix -= 1 }
        let deleteCount = oldUnits.count - prefix - suffix
        let insertEnd = newUnits.count - suffix
        // Formats in the kept parts first, while positions still match the old text.
        fixFormats(tr, text, old: oldMarks, new: newMarks, oldRange: 0..<prefix, newStart: 0, runsOld: old, runsNew: runs)
        fixFormats(tr, text, old: oldMarks, new: newMarks, oldRange: (oldUnits.count - suffix)..<oldUnits.count, newStart: insertEnd, runsOld: old, runsNew: runs)
        if deleteCount > 0 { text.deleteText(tr, at: prefix, length: deleteCount) }
        if insertEnd > prefix {
            var index = prefix
            var position = 0
            for run in runs {
                let length = run.text.utf16.count
                let start = max(position, prefix)
                let end = min(position + length, insertEnd)
                if start < end {
                    let units = Array(run.text.utf16)[(start - position)..<(end - position)]
                    text.insertText(tr, at: index, String(decoding: units, as: UTF16.self), attributes: Self.pairs(run.marks))
                    index += end - start
                }
                position += length
            }
        }
    }

    /// For each UTF-16 unit, which run it belongs to.
    private static func markIndex(_ runs: [DocumentRun]) -> [Int] {
        var out: [Int] = []
        for (i, run) in runs.enumerated() { out += Array(repeating: i, count: run.text.utf16.count) }
        return out
    }

    private func fixFormats(_ tr: YTransaction, _ text: YType, old: [Int], new: [Int], oldRange: Range<Int>, newStart: Int, runsOld: [DocumentRun], runsNew: [DocumentRun]) {
        var i = oldRange.lowerBound
        while i < oldRange.upperBound {
            let target = runsNew[new[newStart + i - oldRange.lowerBound]].marks
            guard runsOld[old[i]].marks != target else { i += 1; continue }
            var end = i + 1
            while end < oldRange.upperBound, runsNew[new[newStart + end - oldRange.lowerBound]].marks == target, runsOld[old[end]].marks != target { end += 1 }
            var attributes = Self.pairs(target)
            var removed = Set<String>()
            for k in i..<end { for key in runsOld[old[k]].marks.keys where target[key] == nil { removed.insert(key) } }
            for key in removed.sorted() { attributes.append((key, .null)) }
            text.format(tr, at: i, length: end - i, attributes)
            i = end
        }
    }
}
