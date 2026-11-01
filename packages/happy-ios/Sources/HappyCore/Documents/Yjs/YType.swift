import Foundation

/// A shared type: a root of the document, or the content of an item.
/// One class serves every kind (yjs subclasses `AbstractType`), so a root
/// first met as a name in an update becomes a fragment or map when asked.
public final class YType {
    public enum Kind: Equatable {
        case array, map, text, xmlElement(String), xmlFragment, xmlHook(String), xmlText, unknown

        var ref: Int {
            switch self {
            case .array: return 0
            case .map: return 1
            case .text: return 2
            case .xmlElement: return 3
            case .xmlFragment, .unknown: return 4
            case .xmlHook: return 5
            case .xmlText: return 6
            }
        }
    }

    public internal(set) var kind: Kind
    var start: YItem?
    var map: [String: YItem] = [:]
    /// Visible countable length: children, or UTF-16 units of text.
    public internal(set) var length = 0
    /// The item holding this type; nil for a root.
    var item: YItem?
    weak var doc: YDoc?
    var rootName: String?
    var needsFormattingCleanup = false

    init(kind: Kind) { self.kind = kind }

    func integrate(doc: YDoc, item: YItem) {
        self.doc = doc
        self.item = item
    }

    /// An element's name, as `XmlElement.nodeName`.
    public var nodeName: String? { if case let .xmlElement(name) = kind { return name }; return nil }
    public var isText: Bool { kind == .xmlText || kind == .text }
    /// The ID of the item holding this type, the way an update names it.
    public var itemID: YID? { item?.id }
    public var parent: YType? { item?.parentType }

    // MARK: List

    /// Visible children of a fragment or element.
    public var children: [YType] {
        var out: [YType] = []
        var n = start
        while let item = n {
            if !item.deleted, case let .type(type) = item.content { out.append(type) }
            n = item.right
        }
        return out
    }

    public func child(at index: Int) -> YType? {
        var remaining = index
        var n = start
        while let item = n {
            if !item.deleted, item.countable {
                if remaining < item.length {
                    if case let .type(type) = item.content { return type }
                    return nil
                }
                remaining -= item.length
            }
            n = item.right
        }
        return nil
    }

    /// The visible index of a child type, or nil.
    public func index(of childType: YType) -> Int? {
        var index = 0
        var n = start
        while let item = n {
            if !item.deleted, item.countable {
                if case let .type(type) = item.content, type === childType { return index }
                index += item.length
            }
            n = item.right
        }
        return nil
    }

    /// Inserts new types at `index` (`typeListInsertGenerics`).
    public func insert(_ transaction: YTransaction, at index: Int, _ types: [YType]) {
        precondition(index <= length, "Yjs: insert past the end")
        var reference: YItem?
        if index > 0 {
            var remaining = index
            var n = start
            while let item = n {
                if !item.deleted, item.countable {
                    if remaining <= item.length {
                        if remaining < item.length {
                            _ = transaction.doc.store.itemCleanStart(transaction, YID(client: item.id.client, clock: item.id.clock + remaining))
                        }
                        break
                    }
                    remaining -= item.length
                }
                n = item.right
            }
            reference = n
        }
        insert(transaction, after: reference, types)
    }

    func insert(_ transaction: YTransaction, after reference: YItem?, _ types: [YType]) {
        var left = reference
        let right = reference == nil ? start : reference?.right
        let doc = transaction.doc
        for type in types {
            let item = YItem(
                id: YID(client: doc.clientID, clock: doc.store.state(doc.clientID)),
                left: left, origin: left?.lastId, right: right, rightOrigin: right?.id,
                parent: .type(self), parentSub: nil, content: .type(type)
            )
            item.integrate(transaction, offset: 0)
            left = item
        }
    }

    /// Deletes `count` visible children or units from `index` (`typeListDelete`).
    public func delete(_ transaction: YTransaction, at index: Int, count: Int) {
        guard count > 0 else { return }
        var remaining = index
        var left = count
        var n = start
        let store = transaction.doc.store
        while let item = n, remaining > 0 {
            if !item.deleted, item.countable {
                if remaining < item.length {
                    _ = store.itemCleanStart(transaction, YID(client: item.id.client, clock: item.id.clock + remaining))
                }
                remaining -= min(remaining, item.length)
            }
            n = item.right
        }
        while let item = n, left > 0 {
            if !item.deleted {
                if left < item.length {
                    _ = store.itemCleanStart(transaction, YID(client: item.id.client, clock: item.id.clock + left))
                }
                item.delete(transaction)
                left -= item.length
            }
            n = item.right
        }
    }

    // MARK: Map

    public func attribute(_ key: String) -> YAny? {
        guard let item = map[key], !item.deleted else { return nil }
        switch item.content {
        case let .any(values): return values.last
        case let .json(values): return values.last
        case let .embed(value): return value
        case let .binary(bytes): return .bytes(bytes)
        default: return nil
        }
    }

    /// The map's typed child under `key`, such as a nested map.
    public func mapType(_ key: String) -> YType? {
        guard let item = map[key], !item.deleted, case let .type(type) = item.content else { return nil }
        return type
    }

    public var attributes: [String: YAny] {
        var out: [String: YAny] = [:]
        for key in map.keys { if let value = attribute(key) { out[key] = value } }
        return out
    }

    public var mapKeys: [String] { map.compactMap { !$0.value.deleted ? $0.key : nil } }

    /// Sets a value under `key`, replacing the last one (`typeMapSet`).
    public func setAttribute(_ transaction: YTransaction, _ key: String, _ value: YAny) {
        let left = map[key]
        let doc = transaction.doc
        let content: YContent
        if case let .bytes(bytes) = value { content = .binary(bytes) } else { content = .any([value]) }
        let item = YItem(
            id: YID(client: doc.clientID, clock: doc.store.state(doc.clientID)),
            left: left, origin: left?.lastId, right: nil, rightOrigin: nil,
            parent: .type(self), parentSub: key, content: content
        )
        item.integrate(transaction, offset: 0)
    }

    public func removeAttribute(_ transaction: YTransaction, _ key: String) {
        map[key]?.delete(transaction)
    }

    // MARK: Text

    /// One run of text, an embed or a type, with the formats over it (`toDelta`).
    public struct DeltaOp: Equatable {
        public enum Insert: Equatable {
            case text(String)
            case embed(YAny)
            case type(ObjectIdentifier)
        }
        public var insert: Insert
        public var attributes: [String: YAny]
    }

    public func toDelta() -> [DeltaOp] {
        var ops: [DeltaOp] = []
        var current = Attributes()
        var units: [UInt16] = []
        func pack() {
            guard !units.isEmpty else { return }
            ops.append(DeltaOp(insert: .text(String(decoding: units, as: UTF16.self)), attributes: current.dictionary))
            units.removeAll(keepingCapacity: true)
        }
        var n = start
        while let item = n {
            if !item.deleted {
                switch item.content {
                case let .string(s): units += s
                case let .embed(value):
                    pack()
                    ops.append(DeltaOp(insert: .embed(value), attributes: current.dictionary))
                case let .type(type):
                    pack()
                    ops.append(DeltaOp(insert: .type(ObjectIdentifier(type)), attributes: current.dictionary))
                case let .format(key, value):
                    pack()
                    current.update(key, value)
                default: break
                }
            }
            n = item.right
        }
        pack()
        return ops
    }

    /// The text alone.
    public var string: String {
        var units: [UInt16] = []
        var n = start
        while let item = n {
            if !item.deleted, case let .string(s) = item.content { units += s }
            n = item.right
        }
        return String(decoding: units, as: UTF16.self)
    }

    /// Ordered attributes, as a JavaScript `Map` keeps them.
    struct Attributes {
        var pairs: [(String, YAny)] = []
        func get(_ key: String) -> YAny? { pairs.first { $0.0 == key }?.1 }
        mutating func set(_ key: String, _ value: YAny) {
            if let i = pairs.firstIndex(where: { $0.0 == key }) { pairs[i].1 = value } else { pairs.append((key, value)) }
        }
        mutating func remove(_ key: String) { pairs.removeAll { $0.0 == key } }
        /// A format item: null ends it.
        mutating func update(_ key: String, _ value: YAny) { if value == .null { remove(key) } else { set(key, value) } }
        var dictionary: [String: YAny] { Dictionary(pairs, uniquingKeysWith: { _, b in b }) }
    }

    struct TextPosition {
        var left: YItem?
        var right: YItem?
        var index: Int
        var attributes: Attributes

        mutating func forward() {
            guard let item = right else { return }
            if case let .format(key, value) = item.content {
                if !item.deleted { attributes.update(key, value) }
            } else if !item.deleted, item.countable {
                index += item.length
            }
            left = item
            right = item.right
        }
    }

    private static func equalAttrs(_ a: YAny?, _ b: YAny?) -> Bool {
        (a ?? .null) == (b ?? .null)
    }

    func findPosition(_ transaction: YTransaction, _ index: Int) -> TextPosition {
        var pos = TextPosition(left: nil, right: start, index: 0, attributes: Attributes())
        var count = index
        let store = transaction.doc.store
        while let item = pos.right, count > 0 {
            if case let .format(key, value) = item.content {
                if !item.deleted { pos.attributes.update(key, value) }
            } else if !item.deleted, item.countable {
                if count < item.length {
                    _ = store.itemCleanStart(transaction, YID(client: item.id.client, clock: item.id.clock + count))
                }
                pos.index += item.length
                count -= item.length
            }
            pos.left = item
            pos.right = item.right
        }
        return pos
    }

    private func newItem(_ transaction: YTransaction, _ pos: TextPosition, _ content: YContent) -> YItem {
        let doc = transaction.doc
        let item = YItem(
            id: YID(client: doc.clientID, clock: doc.store.state(doc.clientID)),
            left: pos.left, origin: pos.left?.lastId, right: pos.right, rightOrigin: pos.right?.id,
            parent: .type(self), parentSub: nil, content: content
        )
        item.integrate(transaction, offset: 0)
        return item
    }

    private func minimizeAttributeChanges(_ pos: inout TextPosition, _ attributes: [(String, YAny)]) {
        while let item = pos.right {
            if item.deleted {
                pos.forward()
                continue
            }
            if case let .format(key, value) = item.content,
               Self.equalAttrs(attributes.first(where: { $0.0 == key })?.1, value) {
                pos.forward()
                continue
            }
            break
        }
    }

    private func insertAttributes(_ transaction: YTransaction, _ pos: inout TextPosition, _ attributes: [(String, YAny)]) -> Attributes {
        var negated = Attributes()
        for (key, value) in attributes {
            let current = pos.attributes.get(key) ?? .null
            if !Self.equalAttrs(current, value) {
                negated.set(key, current)
                pos.right = newItem(transaction, pos, .format(key: key, value: value))
                pos.forward()
            }
        }
        return negated
    }

    private func insertNegatedAttributes(_ transaction: YTransaction, _ pos: inout TextPosition, _ negated: Attributes) {
        var negated = negated
        while let item = pos.right {
            if item.deleted {
                pos.forward()
                continue
            }
            if case let .format(key, value) = item.content, let wanted = negated.get(key), Self.equalAttrs(wanted, value) {
                negated.remove(key)
                pos.forward()
                continue
            }
            break
        }
        for (key, value) in negated.pairs {
            pos.right = newItem(transaction, pos, .format(key: key, value: value))
            pos.forward()
        }
    }

    /// Inserts text formatted exactly with `attributes`; formats around it
    /// that it does not name end before it (`insertText`).
    public func insertText(_ transaction: YTransaction, at index: Int, _ text: String, attributes: [(String, YAny)] = []) {
        guard !text.isEmpty else { return }
        var pos = findPosition(transaction, index)
        insertContent(transaction, &pos, .string(Array(text.utf16)), attributes: attributes)
    }

    public func insertEmbed(_ transaction: YTransaction, at index: Int, _ value: YAny, attributes: [(String, YAny)] = []) {
        var pos = findPosition(transaction, index)
        insertContent(transaction, &pos, .embed(value), attributes: attributes)
    }

    private func insertContent(_ transaction: YTransaction, _ pos: inout TextPosition, _ content: YContent, attributes: [(String, YAny)]) {
        var attributes = attributes
        for (key, _) in pos.attributes.pairs where !attributes.contains(where: { $0.0 == key }) {
            attributes.append((key, .null))
        }
        minimizeAttributeChanges(&pos, attributes)
        let negated = insertAttributes(transaction, &pos, attributes)
        pos.right = newItem(transaction, pos, content)
        pos.forward()
        insertNegatedAttributes(transaction, &pos, negated)
    }

    /// Deletes `length` units of text from `index` (`deleteText`).
    public func deleteText(_ transaction: YTransaction, at index: Int, length: Int) {
        guard length > 0 else { return }
        var pos = findPosition(transaction, index)
        var remaining = length
        let startAttributes = pos.attributes
        let first = pos.right
        let store = transaction.doc.store
        while remaining > 0, let item = pos.right {
            if !item.deleted {
                switch item.content {
                case .string, .embed, .type:
                    if remaining < item.length {
                        _ = store.itemCleanStart(transaction, YID(client: item.id.client, clock: item.id.clock + remaining))
                    }
                    remaining -= item.length
                    item.delete(transaction)
                default: break
                }
            }
            pos.forward()
        }
        if let first { cleanupFormattingGap(transaction, first, pos.right, startAttributes, &pos.attributes) }
    }

    /// Sets formats over a range; null removes one (`formatText`).
    public func format(_ transaction: YTransaction, at index: Int, length: Int, _ attributes: [(String, YAny)]) {
        guard length > 0 else { return }
        var pos = findPosition(transaction, index)
        var remaining = length
        minimizeAttributeChanges(&pos, attributes)
        var negated = insertAttributes(transaction, &pos, attributes)
        let store = transaction.doc.store
        loop: while let item = pos.right, remaining > 0 || (!negated.pairs.isEmpty && (item.deleted || { if case .format = item.content { return true }; return false }())) {
            if !item.deleted {
                if case let .format(key, value) = item.content {
                    if let wanted = attributes.first(where: { $0.0 == key })?.1 {
                        if Self.equalAttrs(wanted, value) {
                            negated.remove(key)
                        } else {
                            if remaining == 0 { break loop }
                            negated.set(key, value)
                        }
                        item.delete(transaction)
                    } else {
                        pos.attributes.set(key, value)
                    }
                } else if item.countable {
                    if remaining < item.length {
                        _ = store.itemCleanStart(transaction, YID(client: item.id.client, clock: item.id.clock + remaining))
                    }
                    remaining -= item.length
                }
            }
            pos.forward()
        }
        insertNegatedAttributes(transaction, &pos, negated)
    }

    /// Removes formats a deletion left with nothing to format (`cleanupFormattingGap`).
    private func cleanupFormattingGap(_ transaction: YTransaction, _ startItem: YItem, _ curr: YItem?, _ startAttributes: Attributes, _ currAttributes: inout Attributes) {
        var end: YItem? = startItem
        var endFormats: [String: ObjectIdentifier] = [:]
        while let item = end, !item.countable || item.deleted {
            if !item.deleted, case let .format(key, _) = item.content { endFormats[key] = ObjectIdentifier(item) }
            end = item.right
        }
        var reachedCurr = false
        var cursor: YItem? = startItem
        while let item = cursor, item !== end {
            if curr === item { reachedCurr = true }
            if !item.deleted, case let .format(key, value) = item.content {
                let startValue = startAttributes.get(key) ?? .null
                if endFormats[key] != ObjectIdentifier(item) || startValue == value {
                    item.delete(transaction)
                    if !reachedCurr, (currAttributes.get(key) ?? .null) == value, startValue != value {
                        if startValue == .null { currAttributes.remove(key) } else { currAttributes.set(key, startValue) }
                    }
                }
                if !reachedCurr, !item.deleted { currAttributes.update(key, value) }
            }
            cursor = item.right
        }
    }
}

extension YDoc {
    /// A new, not yet inserted element, text or map, to insert with `insert`.
    public static func element(_ name: String) -> YType { YType(kind: .xmlElement(name)) }
    public static func text() -> YType { YType(kind: .xmlText) }
}
