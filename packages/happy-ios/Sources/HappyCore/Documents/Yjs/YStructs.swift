import Foundation

/// One position in a Yjs document: a client and its own counter.
public struct YID: Hashable, Sendable, CustomStringConvertible {
    public var client: Int
    public var clock: Int
    public init(client: Int, clock: Int) { self.client = client; self.clock = clock }
    public var description: String { "\(client):\(clock)" }
}

/// What an item holds, numbered as Yjs numbers its content kinds.
/// Strings are UTF-16 code units, as Yjs counts them.
enum YContent {
    case deleted(Int)
    case json([YAny])
    case binary([UInt8])
    case string([UInt16])
    case embed(YAny)
    case format(key: String, value: YAny)
    case type(YType)
    case any([YAny])
    case doc(guid: String, opts: YAny)

    var ref: UInt8 {
        switch self {
        case .deleted: return 1
        case .json: return 2
        case .binary: return 3
        case .string: return 4
        case .embed: return 5
        case .format: return 6
        case .type: return 7
        case .any: return 8
        case .doc: return 9
        }
    }

    var length: Int {
        switch self {
        case let .deleted(n): return n
        case let .json(values): return values.count
        case let .string(units): return units.count
        case let .any(values): return values.count
        case .binary, .embed, .format, .type, .doc: return 1
        }
    }

    var countable: Bool {
        switch self {
        case .deleted, .format: return false
        default: return true
        }
    }

    /// Splits at `offset`: self keeps the left part, the right part is returned.
    mutating func splice(_ offset: Int) -> YContent {
        switch self {
        case let .deleted(n):
            self = .deleted(offset)
            return .deleted(n - offset)
        case let .json(values):
            self = .json(Array(values[..<offset]))
            return .json(Array(values[offset...]))
        case let .any(values):
            self = .any(Array(values[..<offset]))
            return .any(Array(values[offset...]))
        case var .string(units):
            var right = Array(units[offset...])
            units = Array(units[..<offset])
            // A surrogate pair is never split: both halves become U+FFFD, as in Yjs.
            if let last = units.last, (0xD800...0xDBFF).contains(last) {
                units[units.count - 1] = 0xFFFD
                if !right.isEmpty { right[0] = 0xFFFD }
            }
            self = .string(units)
            return .string(right)
        default:
            return self
        }
    }

    /// Appends `right` when the two can be one item.
    mutating func merge(_ right: YContent) -> Bool {
        switch (self, right) {
        case let (.deleted(a), .deleted(b)): self = .deleted(a + b); return true
        case let (.string(a), .string(b)): self = .string(a + b); return true
        case let (.any(a), .any(b)): self = .any(a + b); return true
        case let (.json(a), .json(b)): self = .json(a + b); return true
        default: return false
        }
    }
}

/// Where an item belongs: a type, or before integration an item's ID or a root name.
enum YParent {
    case none
    case type(YType)
    case id(YID)
    case root(String)

    var type: YType? { if case let .type(t) = self { return t }; return nil }
}

/// An item, or a garbage-collected range (`gc`), or a range an update skips (`skip`).
/// One class for all three keeps the struct store a plain array.
final class YItem {
    enum Kind { case item, gc, skip }

    let kind: Kind
    var id: YID
    var length: Int
    var origin: YID?
    var left: YItem?
    var right: YItem?
    var rightOrigin: YID?
    var parent: YParent
    var parentSub: String?
    var content: YContent
    var deleted: Bool
    var keep = false

    init(id: YID, left: YItem?, origin: YID?, right: YItem?, rightOrigin: YID?, parent: YParent, parentSub: String?, content: YContent) {
        kind = .item
        self.id = id
        self.left = left
        self.origin = origin
        self.right = right
        self.rightOrigin = rightOrigin
        self.parent = parent
        self.parentSub = parentSub
        self.content = content
        length = content.length
        deleted = false
    }

    init(gc id: YID, length: Int) {
        kind = .gc
        self.id = id
        self.length = length
        parent = .none
        content = .deleted(length)
        deleted = true
    }

    init(skip id: YID, length: Int) {
        kind = .skip
        self.id = id
        self.length = length
        parent = .none
        content = .deleted(length)
        deleted = false
    }

    var lastId: YID { length == 1 ? id : YID(client: id.client, clock: id.clock + length - 1) }
    var countable: Bool { kind == .item && content.countable }
    var parentType: YType? { parent.type }

    /// Visible text length this item adds to its parent.
    var visibleLength: Int { !deleted && countable ? length : 0 }

    // MARK: Integration

    /// The client whose earlier change this item needs, or nil once its
    /// neighbours and parent are found (`Item.getMissing`).
    func getMissing(_ transaction: YTransaction, _ store: YStructStore) -> Int? {
        if let origin, origin.client != id.client, origin.clock >= store.state(origin.client) { return origin.client }
        if let rightOrigin, rightOrigin.client != id.client, rightOrigin.clock >= store.state(rightOrigin.client) { return rightOrigin.client }
        if case let .id(parentID) = parent, id.client != parentID.client, parentID.clock >= store.state(parentID.client) { return parentID.client }
        if let origin {
            left = store.itemCleanEnd(transaction, origin)
            self.origin = left?.lastId
        }
        if let rightOrigin {
            right = store.itemCleanStart(transaction, rightOrigin)
            self.rightOrigin = right?.id
        }
        if left?.kind == .gc || right?.kind == .gc {
            parent = .none
        } else if case .none = parent {
            if let left, left.kind == .item {
                parent = left.parent
                parentSub = left.parentSub
            } else if let right, right.kind == .item {
                parent = right.parent
                parentSub = right.parentSub
            }
        } else if case let .id(parentID) = parent {
            let parentItem = store.item(parentID)
            if parentItem.kind == .gc { parent = .none } else if case let .type(type) = parentItem.content { parent = .type(type) } else { parent = .none }
        } else if case let .root(name) = parent {
            parent = .type(transaction.doc.root(name))
        }
        return nil
    }

    /// YATA: places the item among concurrent inserts at the same spot, so
    /// every replica orders them the same way (`Item.integrate`).
    func integrate(_ transaction: YTransaction, offset: Int) {
        let store = transaction.doc.store
        if kind != .item {
            if offset > 0 {
                id.clock += offset
                length -= offset
            }
            store.add(self)
            return
        }
        if offset > 0 {
            id.clock += offset
            left = store.itemCleanEnd(transaction, YID(client: id.client, clock: id.clock - 1))
            origin = left?.lastId
            content = content.split(offset)
            length -= offset
        }
        if case let .root(name) = parent { parent = .type(transaction.doc.root(name)) }
        guard let parentType = parent.type else {
            // No parent: the item's place was collected; keep its range as GC.
            let gc = YItem(gc: id, length: length)
            store.add(gc)
            return
        }
        if (left == nil && (right == nil || right?.left != nil)) || (left != nil && left?.right !== right) {
            var newLeft = left
            var o: YItem?
            if let left {
                o = left.right
            } else if let parentSub {
                o = parentType.map[parentSub]
                while let current = o, let next = current.left { o = next }
            } else {
                o = parentType.start
            }
            var conflicting = Set<ObjectIdentifier>()
            var beforeOrigin = Set<ObjectIdentifier>()
            while let current = o, current !== right {
                beforeOrigin.insert(ObjectIdentifier(current))
                conflicting.insert(ObjectIdentifier(current))
                if origin == current.origin {
                    if current.id.client < id.client {
                        newLeft = current
                        conflicting.removeAll()
                    } else if rightOrigin == current.rightOrigin {
                        break
                    }
                } else if let currentOrigin = current.origin, beforeOrigin.contains(ObjectIdentifier(store.item(currentOrigin))) {
                    if !conflicting.contains(ObjectIdentifier(store.item(currentOrigin))) {
                        newLeft = current
                        conflicting.removeAll()
                    }
                } else {
                    break
                }
                o = current.right
            }
            left = newLeft
        }
        if let left {
            right = left.right
            left.right = self
        } else {
            var r: YItem?
            if let parentSub {
                r = parentType.map[parentSub]
                while let current = r, let next = current.left { r = next }
            } else {
                r = parentType.start
                parentType.start = self
            }
            right = r
        }
        if let right {
            right.left = self
        } else if let parentSub {
            parentType.map[parentSub] = self
            left?.delete(transaction)
        }
        if parentSub == nil, countable, !deleted { parentType.length += length }
        store.add(self)
        if case let .type(type) = content { type.integrate(doc: transaction.doc, item: self) }
        if case .format = content { parentType.needsFormattingCleanup = true }
        transaction.addChanged(parentType, parentSub)
        if (parentType.item?.deleted ?? false) || (parentSub != nil && right != nil) {
            delete(transaction)
        }
    }

    func markDeleted() { deleted = true }

    func delete(_ transaction: YTransaction) {
        guard !deleted, kind == .item else { return }
        let parentType = parent.type
        if countable, parentSub == nil { parentType?.length -= length }
        deleted = true
        transaction.deleteSet.add(client: id.client, clock: id.clock, length: length)
        if let parentType { transaction.addChanged(parentType, parentSub) }
        if case let .type(type) = content {
            var child = type.start
            while let item = child {
                if !item.deleted { item.delete(transaction) } else if item.id.clock < transaction.beforeState[item.id.client, default: 0] { transaction.mergeStructs.append(item) }
                child = item.right
            }
            for item in type.map.values {
                if !item.deleted { item.delete(transaction) } else if item.id.clock < transaction.beforeState[item.id.client, default: 0] { transaction.mergeStructs.append(item) }
            }
            transaction.changed.removeValue(forKey: ObjectIdentifier(type))
        }
    }

    /// Drops a deleted item's content; a deleted type's children go entirely.
    func gc(_ store: YStructStore, parentGCd: Bool) {
        guard deleted, kind == .item else { return }
        if case let .type(type) = content {
            var child = type.start
            while let item = child {
                item.gc(store, parentGCd: true)
                child = item.right
            }
            type.start = nil
            for value in type.map.values {
                var item: YItem? = value
                while let current = item { current.gc(store, parentGCd: true); item = current.left }
            }
            type.map = [:]
        }
        if parentGCd {
            store.replace(self, with: YItem(gc: id, length: length))
        } else {
            content = .deleted(length)
        }
    }

    /// Joins `right` into this item when Yjs would (`Item.mergeWith`).
    func merge(with right: YItem) -> Bool {
        if kind == .gc, right.kind == .gc {
            length += right.length
            return true
        }
        guard kind == .item, right.kind == .item,
              right.origin == lastId, self.right === right, rightOrigin == right.rightOrigin,
              id.client == right.id.client, id.clock + length == right.id.clock,
              deleted == right.deleted, content.ref == right.content.ref else { return false }
        guard content.merge(right.content) else { return false }
        if right.keep { keep = true }
        self.right = right.right
        self.right?.left = self
        length += right.length
        return true
    }

    // MARK: Encoding

    func write(_ encoder: inout YEncoder, offset: Int) {
        switch kind {
        case .gc:
            encoder.write(0)
            encoder.writeVarUint(length - offset)
            return
        case .skip:
            encoder.write(10)
            encoder.writeVarUint(length - offset)
            return
        case .item:
            break
        }
        let writtenOrigin = offset > 0 ? YID(client: id.client, clock: id.clock + offset - 1) : origin
        var info = content.ref & 0x1F
        if writtenOrigin != nil { info |= 0x80 }
        if rightOrigin != nil { info |= 0x40 }
        if parentSub != nil { info |= 0x20 }
        encoder.write(info)
        if let writtenOrigin { encoder.writeVarUint(writtenOrigin.client); encoder.writeVarUint(writtenOrigin.clock) }
        if let rightOrigin { encoder.writeVarUint(rightOrigin.client); encoder.writeVarUint(rightOrigin.clock) }
        if writtenOrigin == nil, rightOrigin == nil {
            switch parent {
            case let .type(type):
                if let item = type.item {
                    encoder.writeVarUint(0)
                    encoder.writeVarUint(item.id.client); encoder.writeVarUint(item.id.clock)
                } else {
                    encoder.writeVarUint(1)
                    encoder.writeVarString(type.rootName ?? "")
                }
            case let .root(name):
                encoder.writeVarUint(1)
                encoder.writeVarString(name)
            case let .id(parentID):
                encoder.writeVarUint(0)
                encoder.writeVarUint(parentID.client); encoder.writeVarUint(parentID.clock)
            case .none:
                encoder.writeVarUint(1)
                encoder.writeVarString("")
            }
            if let parentSub { encoder.writeVarString(parentSub) }
        }
        content.write(&encoder, offset: offset)
    }
}

extension YContent {
    /// The part after `offset`, for an item integrated from part way through.
    func split(_ offset: Int) -> YContent {
        var copy = self
        return copy.splice(offset)
    }

    func write(_ encoder: inout YEncoder, offset: Int) {
        switch self {
        case let .deleted(n):
            encoder.writeVarUint(n - offset)
        case let .json(values):
            encoder.writeVarUint(values.count - offset)
            for value in values[offset...] { encoder.writeVarString(value == .undefined ? "undefined" : value.jsonString) }
        case let .binary(data):
            encoder.writeVarUint8Array(data)
        case let .string(units):
            encoder.writeVarString(utf16: offset == 0 ? units : Array(units[offset...]))
        case let .embed(value):
            encoder.writeVarString(value.jsonString)
        case let .format(key, value):
            encoder.writeVarString(key)
            encoder.writeVarString(value.jsonString)
        case let .type(type):
            encoder.writeVarUint(type.kind.ref)
            if case let .xmlElement(name) = type.kind { encoder.writeVarString(name) }
            if case let .xmlHook(name) = type.kind { encoder.writeVarString(name) }
        case let .any(values):
            encoder.writeVarUint(values.count - offset)
            for value in values[offset...] { encoder.writeAny(value) }
        case let .doc(guid, opts):
            encoder.writeVarString(guid)
            encoder.writeAny(opts)
        }
    }

    static func read(_ decoder: inout YDecoder, info: UInt8) throws -> YContent {
        switch info & 0x1F {
        case 1: return .deleted(try decoder.readVarUint())
        case 2:
            let count = try decoder.readVarUint()
            var values: [YAny] = []
            for _ in 0..<count {
                let text = try decoder.readVarString()
                values.append(text == "undefined" ? .undefined : try YAny.parseJSON(text))
            }
            return .json(values)
        case 3: return .binary(try decoder.readVarUint8Array())
        case 4: return .string(Array(try decoder.readVarString().utf16))
        case 5: return .embed(try YAny.parseJSON(try decoder.readVarString()))
        case 6:
            let key = try decoder.readVarString()
            return .format(key: key, value: try YAny.parseJSON(try decoder.readVarString()))
        case 7:
            let ref = try decoder.readVarUint()
            let kind: YType.Kind
            switch ref {
            case 0: kind = .array
            case 1: kind = .map
            case 2: kind = .text
            case 3: kind = .xmlElement(try decoder.readVarString())
            case 4: kind = .xmlFragment
            case 5: kind = .xmlHook(try decoder.readVarString())
            case 6: kind = .xmlText
            default: throw YError.malformed("type ref \(ref)")
            }
            return .type(YType(kind: kind))
        case 8:
            let count = try decoder.readVarUint()
            var values: [YAny] = []
            values.reserveCapacity(min(count, 1024))
            for _ in 0..<count { values.append(try decoder.readAny()) }
            return .any(values)
        case 9:
            let guid = try decoder.readVarString()
            return .doc(guid: guid, opts: try decoder.readAny())
        default:
            throw YError.malformed("content ref \(info & 0x1F)")
        }
    }
}
