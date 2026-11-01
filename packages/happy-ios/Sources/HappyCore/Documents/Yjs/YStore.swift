import Foundation

/// Every client's structs in clock order, with no gaps (`StructStore`).
final class YStructStore {
    var clients: [Int: [YItem]] = [:]
    /// Structs an update brought before what they depend on, and the
    /// lowest clock each client is missing.
    var pending: (refs: [Int: [YItem]], missing: [Int: Int])?
    /// Deletes of structs not here yet.
    var pendingDeletes: YDeleteSet?

    func state(_ client: Int) -> Int {
        guard let last = clients[client]?.last else { return 0 }
        return last.id.clock + last.length
    }

    func stateVector() -> [Int: Int] {
        var vector: [Int: Int] = [:]
        for (client, structs) in clients {
            guard let last = structs.last else { continue }
            vector[client] = last.id.clock + last.length
        }
        return vector
    }

    func add(_ item: YItem) {
        let client = item.id.client
        precondition(state(client) == item.id.clock, "Yjs: struct \(item.id) out of order")
        clients[client, default: []].append(item)
    }

    /// The index of the struct holding `clock` (`findIndexSS`).
    static func findIndex(_ structs: [YItem], _ clock: Int) -> Int {
        var left = 0
        var right = structs.count - 1
        guard right >= 0 else { return 0 }
        let last = structs[right]
        let lastClock = last.id.clock
        if lastClock == clock { return right }
        // Guess by assuming clocks spread evenly, then bisect.
        var mid = Int((Double(clock) / Double(lastClock + last.length - 1)) * Double(right))
        mid = max(0, min(right, mid))
        while left <= right {
            let item = structs[mid]
            let midClock = item.id.clock
            if midClock <= clock {
                if clock < midClock + item.length { return mid }
                left = mid + 1
            } else {
                right = mid - 1
            }
            mid = (left + right) / 2
        }
        return max(0, min(structs.count - 1, left))
    }

    func item(_ id: YID) -> YItem {
        let structs = clients[id.client] ?? []
        return structs[Self.findIndex(structs, id.clock)]
    }

    /// The struct starting exactly at `id`, splitting the one that holds it.
    func itemCleanStart(_ transaction: YTransaction, _ id: YID) -> YItem {
        let index = findIndexCleanStart(transaction, id.client, id.clock)
        return clients[id.client]![index]
    }

    func findIndexCleanStart(_ transaction: YTransaction, _ client: Int, _ clock: Int) -> Int {
        // No copy of the array outlives the lookup, so the insert below stays in place.
        let index = clients[client].map { Self.findIndex($0, clock) } ?? 0
        let item = clients[client]![index]
        if item.id.clock < clock, item.kind == .item {
            let right = split(transaction, item, clock - item.id.clock)
            clients[client]!.insert(right, at: index + 1)
            return index + 1
        }
        return index
    }

    /// The struct ending exactly at `id`, splitting the one that holds it.
    func itemCleanEnd(_ transaction: YTransaction, _ id: YID) -> YItem {
        let index = clients[id.client].map { Self.findIndex($0, id.clock) } ?? 0
        let item = clients[id.client]![index]
        if id.clock != item.id.clock + item.length - 1, item.kind != .gc {
            let right = split(transaction, item, id.clock - item.id.clock + 1)
            clients[id.client]!.insert(right, at: index + 1)
        }
        return item
    }

    /// Splits `left` after `diff` units; the caller places the right part in the store.
    func split(_ transaction: YTransaction, _ left: YItem, _ diff: Int) -> YItem {
        let id = left.id
        let right = YItem(
            id: YID(client: id.client, clock: id.clock + diff), left: left,
            origin: YID(client: id.client, clock: id.clock + diff - 1),
            right: left.right, rightOrigin: left.rightOrigin,
            parent: left.parent, parentSub: left.parentSub, content: left.content.splice(diff)
        )
        if left.deleted { right.markDeleted() }
        if left.keep { right.keep = true }
        left.right = right
        right.right?.left = right
        transaction.mergeStructs.append(right)
        if let parentSub = right.parentSub, right.right == nil, let parent = right.parentType {
            parent.map[parentSub] = right
        }
        left.length = diff
        return right
    }

    func replace(_ old: YItem, with new: YItem) {
        guard let index = clients[old.id.client].map({ Self.findIndex($0, old.id.clock) }) else { return }
        if clients[old.id.client]![index] === old { clients[old.id.client]![index] = new }
    }

    /// Joins the struct at `pos` with those before it while Yjs would; returns how many went.
    @discardableResult
    func mergeWithLefts(_ client: Int, _ pos: Int) -> Int {
        guard pos > 0, let count = clients[client]?.count, pos < count else { return 0 }
        var i = pos
        var right = clients[client]![i]
        while i > 0 {
            let left = clients[client]![i - 1]
            guard left.deleted == right.deleted, left.kind == right.kind, left.merge(with: right) else { break }
            if right.kind == .item, let parentSub = right.parentSub, let parent = right.parentType, parent.map[parentSub] === right {
                parent.map[parentSub] = left
            }
            right = left
            i -= 1
        }
        let merged = pos - i
        if merged > 0 { clients[client]!.removeSubrange((pos + 1 - merged)...pos) }
        return merged
    }
}

/// Deleted ranges per client (`DeleteSet`).
public struct YDeleteSet: Equatable, Sendable {
    public struct Range: Equatable, Sendable { public var clock: Int; public var length: Int }
    public var clients: [Int: [Range]] = [:]
    public init() {}

    public var isEmpty: Bool { clients.isEmpty }

    mutating func add(client: Int, clock: Int, length: Int) {
        clients[client, default: []].append(Range(clock: clock, length: length))
    }

    mutating func sortAndMerge() {
        for (client, ranges) in clients {
            let sorted = ranges.sorted { $0.clock < $1.clock }
            var merged: [Range] = []
            for range in sorted {
                if var last = merged.last, last.clock + last.length >= range.clock {
                    last.length = max(last.length, range.clock + range.length - last.clock)
                    merged[merged.count - 1] = last
                } else {
                    merged.append(range)
                }
            }
            clients[client] = merged
        }
    }

    public func contains(_ id: YID) -> Bool {
        guard let ranges = clients[id.client] else { return false }
        var low = 0
        var high = ranges.count - 1
        while low <= high {
            let mid = (low + high) / 2
            let range = ranges[mid]
            if range.clock <= id.clock {
                if id.clock < range.clock + range.length { return true }
                low = mid + 1
            } else {
                high = mid - 1
            }
        }
        return false
    }

    mutating func merge(_ other: YDeleteSet) {
        for (client, ranges) in other.clients { clients[client, default: []] += ranges }
        sortAndMerge()
    }

    func write(_ encoder: inout YEncoder) {
        encoder.writeVarUint(clients.count)
        for (client, ranges) in clients.sorted(by: { $0.key > $1.key }) {
            encoder.writeVarUint(client)
            encoder.writeVarUint(ranges.count)
            for range in ranges {
                encoder.writeVarUint(range.clock)
                encoder.writeVarUint(range.length)
            }
        }
    }

    static func read(_ decoder: inout YDecoder) throws -> YDeleteSet {
        var set = YDeleteSet()
        let count = try decoder.readVarUint()
        for _ in 0..<count {
            let client = try decoder.readVarUint()
            let ranges = try decoder.readVarUint()
            for _ in 0..<ranges {
                let clock = try decoder.readVarUint()
                set.add(client: client, clock: clock, length: try decoder.readVarUint())
            }
        }
        return set
    }

    /// Every deleted range in a store (`createDeleteSetFromStructStore`).
    static func from(_ store: YStructStore) -> YDeleteSet {
        var set = YDeleteSet()
        for (client, structs) in store.clients {
            var ranges: [Range] = []
            var i = 0
            while i < structs.count {
                let item = structs[i]
                if item.deleted {
                    let clock = item.id.clock
                    var length = item.length
                    while i + 1 < structs.count, structs[i + 1].deleted {
                        length += structs[i + 1].length
                        i += 1
                    }
                    ranges.append(Range(clock: clock, length: length))
                }
                i += 1
            }
            if !ranges.isEmpty { set.clients[client] = ranges }
        }
        return set
    }
}
