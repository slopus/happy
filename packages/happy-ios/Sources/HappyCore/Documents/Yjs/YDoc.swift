import Foundation

/// A Yjs document: a port of yjs 13.6's `Doc`, struct store, transactions
/// and version 1 update format, enough to hold and edit what BlockNote
/// writes and to merge with every other replica the way yjs merges.
///
/// Not thread-safe: one document belongs to one thread or actor. A document
/// can be moved to another thread whole (`sending`), never shared.
public final class YDoc {
    public internal(set) var clientID: Int
    let store = YStructStore()
    private var share: [String: YType] = [:]
    /// Deleted content is dropped, as yjs does by default.
    public var gc = true
    private var transaction: YTransaction?
    /// Called after every transaction that changed something, with the
    /// update it made and the types it changed.
    public var onTransaction: ((YTransactionResult) -> Void)?

    public init(clientID: Int = YDoc.randomClientID()) {
        self.clientID = clientID
    }

    deinit {
        // Items point at their neighbours both ways; let them go together.
        for structs in store.clients.values {
            for item in structs {
                item.left = nil
                item.right = nil
                if case let .type(type) = item.content { type.start = nil; type.map = [:]; type.item = nil }
                item.parent = .none
            }
        }
        for type in share.values { type.start = nil; type.map = [:] }
    }

    /// A random 32-bit client ID, as yjs picks one.
    public static func randomClientID() -> Int { Int(UInt32.random(in: 0...UInt32.max)) }

    func root(_ name: String) -> YType {
        if let type = share[name] { return type }
        let type = YType(kind: .unknown)
        type.rootName = name
        type.doc = self
        share[name] = type
        return type
    }

    public func getXmlFragment(_ name: String) -> YType {
        let type = root(name)
        if type.kind == .unknown { type.kind = .xmlFragment }
        return type
    }

    public func getMap(_ name: String) -> YType {
        let type = root(name)
        if type.kind == .unknown { type.kind = .map }
        return type
    }

    public func stateVector() -> [Int: Int] { store.stateVector() }

    // MARK: Transactions

    /// Runs `body` as one transaction. Nested calls join the outer one.
    @discardableResult
    public func transact<T>(origin: String? = nil, local: Bool = true, _ body: (YTransaction) throws -> T) rethrows -> T {
        if let transaction { return try body(transaction) }
        let transaction = YTransaction(doc: self, origin: origin, local: local)
        self.transaction = transaction
        defer {
            self.transaction = nil
            cleanup(transaction)
        }
        return try body(transaction)
    }

    private func cleanup(_ transaction: YTransaction) {
        transaction.deleteSet.sortAndMerge()
        transaction.afterState = store.stateVector()
        let ds = transaction.deleteSet
        if gc {
            for (client, ranges) in ds.clients {
                guard store.clients[client] != nil else { continue }
                for range in ranges.reversed() {
                    let end = range.clock + range.length
                    var si = YStructStore.findIndex(store.clients[client]!, range.clock)
                    while si < store.clients[client]!.count {
                        let item = store.clients[client]![si]
                        if item.id.clock >= end { break }
                        if item.kind == .item, item.deleted, !item.keep { item.gc(store, parentGCd: false) }
                        si += 1
                    }
                }
            }
        }
        // Join what the deletes and new structs left adjacent.
        for (client, ranges) in ds.clients {
            guard let count = store.clients[client]?.count, count > 0 else { continue }
            for range in ranges.reversed() {
                var si = min(count - 1, 1 + YStructStore.findIndex(store.clients[client]!, range.clock + range.length - 1))
                si = min(si, store.clients[client]!.count - 1)
                while si > 0, store.clients[client]![si].id.clock >= range.clock {
                    si -= 1 + store.mergeWithLefts(client, si)
                }
            }
        }
        // Positions are read before merging, so no copy of an array is held while it shrinks.
        for (client, clock) in transaction.afterState {
            let before = transaction.beforeState[client] ?? 0
            guard before != clock, let bounds = store.clients[client].map({ (max(YStructStore.findIndex($0, before), 1), $0.count) }) else { continue }
            var i = bounds.1 - 1
            while i >= bounds.0 {
                i -= 1 + store.mergeWithLefts(client, i)
            }
        }
        for item in transaction.mergeStructs.reversed() {
            let client = item.id.client
            guard let found = store.clients[client].map({ (YStructStore.findIndex($0, item.id.clock), $0.count) }) else { continue }
            let pos = found.0
            if pos + 1 < found.1, store.mergeWithLefts(client, pos + 1) > 1 { continue }
            if pos > 0 { store.mergeWithLefts(client, pos) }
        }
        if !transaction.local, transaction.afterState[clientID] != transaction.beforeState[clientID] {
            // Another replica wrote under this client ID: take a new one.
            clientID = Self.randomClientID()
        }
        guard let onTransaction else { return }
        let changedState = transaction.afterState.contains { transaction.beforeState[$0.key] != $0.value }
        guard changedState || !ds.isEmpty else { return }
        var encoder = YEncoder()
        writeStructs(&encoder, from: transaction.beforeState)
        ds.write(&encoder)
        onTransaction(YTransactionResult(
            update: encoder.bytes, local: transaction.local, origin: transaction.origin,
            changed: transaction.changed.values.map { $0.type }, deleteSet: ds
        ))
    }

    // MARK: Updates

    /// Applies a version 1 update (`Y.applyUpdate`). What it needs and does
    /// not find waits here until a later update brings it.
    public func applyUpdate(_ update: [UInt8], origin: String? = nil) throws {
        var decoder = YDecoder(update)
        let refs = try readStructRefs(&decoder)
        let deletes = try YDeleteSet.read(&decoder)
        transact(origin: origin, local: false) { transaction in
            var all = refs
            var retry = false
            if let pending = store.pending {
                for (client, clock) in pending.missing where clock < store.state(client) { retry = true }
                if retry {
                    for (client, items) in pending.refs { all[client] = ((all[client] ?? []) + items).sorted { $0.id.clock < $1.id.clock } }
                    store.pending = nil
                }
            }
            let rest = integrate(transaction, all)
            if let rest {
                if var pending = store.pending {
                    for (client, items) in rest.refs { pending.refs[client] = ((pending.refs[client] ?? []) + items).sorted { $0.id.clock < $1.id.clock } }
                    for (client, clock) in rest.missing { pending.missing[client] = min(pending.missing[client] ?? clock, clock) }
                    store.pending = pending
                } else {
                    store.pending = rest
                }
            }
            var unapplied = applyDeletes(transaction, deletes)
            if let pendingDeletes = store.pendingDeletes {
                store.pendingDeletes = nil
                let again = applyDeletes(transaction, pendingDeletes)
                unapplied.merge(again)
            }
            store.pendingDeletes = unapplied.isEmpty ? nil : unapplied
        }
        // Something waiting may have become applicable.
        if let pending = store.pending, pending.missing.contains(where: { $0.value < store.state($0.key) }) {
            try applyUpdate([0, 0])
        }
    }

    /// Whether some update waits for changes this document has not had.
    public var hasPending: Bool { store.pending != nil || store.pendingDeletes != nil }

    private func readStructRefs(_ decoder: inout YDecoder) throws -> [Int: [YItem]] {
        var refs: [Int: [YItem]] = [:]
        let clientCount = try decoder.readVarUint()
        for _ in 0..<clientCount {
            let count = try decoder.readVarUint()
            let client = try decoder.readVarUint()
            var clock = try decoder.readVarUint()
            var items: [YItem] = []
            items.reserveCapacity(min(count, 4096))
            for _ in 0..<count {
                let info = try decoder.readUint8()
                switch info & 0x1F {
                case 0:
                    let length = try decoder.readVarUint()
                    items.append(YItem(gc: YID(client: client, clock: clock), length: length))
                    clock += length
                case 10:
                    let length = try decoder.readVarUint()
                    items.append(YItem(skip: YID(client: client, clock: clock), length: length))
                    clock += length
                default:
                    let hasOrigin = info & 0x80 != 0
                    let hasRightOrigin = info & 0x40 != 0
                    let origin = hasOrigin ? YID(client: try decoder.readVarUint(), clock: try decoder.readVarUint()) : nil
                    let rightOrigin = hasRightOrigin ? YID(client: try decoder.readVarUint(), clock: try decoder.readVarUint()) : nil
                    var parent: YParent = .none
                    var parentSub: String?
                    if !hasOrigin, !hasRightOrigin {
                        if try decoder.readVarUint() == 1 {
                            parent = .root(try decoder.readVarString())
                        } else {
                            parent = .id(YID(client: try decoder.readVarUint(), clock: try decoder.readVarUint()))
                        }
                        if info & 0x20 != 0 { parentSub = try decoder.readVarString() }
                    }
                    let content = try YContent.read(&decoder, info: info)
                    let item = YItem(id: YID(client: client, clock: clock), left: nil, origin: origin, right: nil, rightOrigin: rightOrigin, parent: parent, parentSub: parentSub, content: content)
                    items.append(item)
                    clock += item.length
                }
            }
            refs[client] = (refs[client] ?? []) + items
        }
        return refs
    }

    /// Integrates structs client by client, following dependencies across
    /// clients (`integrateStructs`). Returns what could not be applied yet.
    private func integrate(_ transaction: YTransaction, _ refsIn: [Int: [YItem]]) -> (refs: [Int: [YItem]], missing: [Int: Int])? {
        var targets: [Int: (refs: [YItem], i: Int)] = refsIn.mapValues { ($0, 0) }
        var ids = targets.keys.sorted()
        guard !ids.isEmpty else { return nil }
        var stack: [YItem] = []
        var rest: [Int: [YItem]] = [:]
        var missing: [Int: Int] = [:]
        var state: [Int: Int] = [:]
        func updateMissing(_ client: Int, _ clock: Int) {
            if let existing = missing[client], existing <= clock { return }
            missing[client] = clock
        }
        func nextTarget() -> Int? {
            while let last = ids.last {
                if let target = targets[last], target.i < target.refs.count { return last }
                ids.removeLast()
            }
            return nil
        }
        func take(_ client: Int) -> YItem? {
            guard var target = targets[client], target.i < target.refs.count else { return nil }
            let item = target.refs[target.i]
            target.i += 1
            targets[client] = target
            return item
        }
        func stackToRest() {
            for item in stack {
                let client = item.id.client
                if var target = targets[client] {
                    target.i -= 1
                    rest[client] = Array(target.refs[target.i...])
                    targets.removeValue(forKey: client)
                } else {
                    rest[client] = [item]
                }
                ids.removeAll { $0 == client }
            }
            stack.removeAll()
        }
        var current = nextTarget()
        guard let first = current, var head = take(first) else { return nil }
        while true {
            if head.kind != .skip {
                let client = head.id.client
                let localClock = state[client] ?? store.state(client)
                state[client] = localClock
                let offset = localClock - head.id.clock
                if offset < 0 {
                    stack.append(head)
                    updateMissing(client, head.id.clock - 1)
                    stackToRest()
                } else if let need = head.getMissing(transaction, store) {
                    stack.append(head)
                    if targets[need].map({ $0.i < $0.refs.count }) ?? false, let next = take(need) {
                        head = next
                        continue
                    }
                    updateMissing(need, store.state(need))
                    stackToRest()
                } else if offset == 0 || offset < head.length {
                    head.integrate(transaction, offset: offset)
                    state[client] = head.id.clock + head.length
                }
            }
            if let popped = stack.popLast() {
                head = popped
            } else if let target = current, let next = take(target) {
                head = next
            } else {
                current = nextTarget()
                guard let target = current, let next = take(target) else { break }
                head = next
            }
        }
        return rest.isEmpty ? nil : (rest, missing)
    }

    /// Deletes ranges; returns those whose structs are not here yet (`readAndApplyDeleteSet`).
    private func applyDeletes(_ transaction: YTransaction, _ deletes: YDeleteSet) -> YDeleteSet {
        var unapplied = YDeleteSet()
        for (client, ranges) in deletes.clients {
            let state = store.state(client)
            for range in ranges {
                let clock = range.clock
                let end = clock + range.length
                guard clock < state else {
                    unapplied.add(client: client, clock: clock, length: end - clock)
                    continue
                }
                if state < end { unapplied.add(client: client, clock: state, length: end - state) }
                var index = YStructStore.findIndex(store.clients[client]!, clock)
                let first = store.clients[client]![index]
                if !first.deleted, first.id.clock < clock, first.kind == .item {
                    let right = store.split(transaction, first, clock - first.id.clock)
                    store.clients[client]!.insert(right, at: index + 1)
                    index += 1
                }
                while index < store.clients[client]!.count {
                    let item = store.clients[client]![index]
                    index += 1
                    guard item.id.clock < end else { break }
                    if !item.deleted {
                        if end < item.id.clock + item.length, item.kind == .item {
                            let right = store.split(transaction, item, end - item.id.clock)
                            store.clients[client]!.insert(right, at: index)
                        }
                        item.delete(transaction)
                    }
                }
            }
        }
        unapplied.sortAndMerge()
        return unapplied
    }

    /// The structs of every client past `vector` (`writeClientsStructs`).
    func writeStructs(_ encoder: inout YEncoder, from vector: [Int: Int]) {
        var wanted: [(Int, Int)] = []
        for (client, structs) in store.clients {
            guard let last = structs.last else { continue }
            let state = last.id.clock + last.length
            let clock = vector[client] ?? 0
            if state > clock { wanted.append((client, clock)) }
        }
        encoder.writeVarUint(wanted.count)
        for (client, clock) in wanted.sorted(by: { $0.0 > $1.0 }) {
            let structs = store.clients[client]!
            let start = max(clock, structs[0].id.clock)
            let index = YStructStore.findIndex(structs, start)
            encoder.writeVarUint(structs.count - index)
            encoder.writeVarUint(client)
            encoder.writeVarUint(start)
            structs[index].write(&encoder, offset: start - structs[index].id.clock)
            for i in (index + 1)..<max(index + 1, structs.count) { structs[i].write(&encoder, offset: 0) }
        }
    }

    /// The whole document, or only what `stateVector` lacks (`Y.encodeStateAsUpdate`).
    public func encodeStateAsUpdate(since stateVector: [Int: Int] = [:]) -> [UInt8] {
        var encoder = YEncoder()
        writeStructs(&encoder, from: stateVector)
        YDeleteSet.from(store).write(&encoder)
        return encoder.bytes
    }

    public static func encodeStateVector(_ vector: [Int: Int]) -> [UInt8] {
        var encoder = YEncoder()
        encoder.writeVarUint(vector.count)
        for (client, clock) in vector.sorted(by: { $0.key > $1.key }) {
            encoder.writeVarUint(client)
            encoder.writeVarUint(clock)
        }
        return encoder.bytes
    }

    public static func decodeStateVector(_ bytes: [UInt8]) throws -> [Int: Int] {
        var decoder = YDecoder(bytes)
        var vector: [Int: Int] = [:]
        let count = try decoder.readVarUint()
        for _ in 0..<count {
            let client = try decoder.readVarUint()
            vector[client] = try decoder.readVarUint()
        }
        return vector
    }

    /// The state vector an update leaves a document at, read without applying it.
    public static func updateStateVector(_ update: [UInt8]) throws -> [Int: Int] {
        let doc = YDoc()
        try doc.applyUpdate(update)
        return doc.stateVector()
    }
}

/// What a transaction did, for whoever follows the document.
public struct YTransactionResult {
    public let update: [UInt8]
    public let local: Bool
    public let origin: String?
    public let changed: [YType]
    public let deleteSet: YDeleteSet
}

public final class YTransaction {
    let doc: YDoc
    var deleteSet = YDeleteSet()
    let beforeState: [Int: Int]
    var afterState: [Int: Int] = [:]
    var changed: [ObjectIdentifier: (type: YType, keys: Set<String?>)] = [:]
    var mergeStructs: [YItem] = []
    let local: Bool
    let origin: String?

    init(doc: YDoc, origin: String?, local: Bool) {
        self.doc = doc
        self.origin = origin
        self.local = local
        beforeState = doc.store.stateVector()
    }

    /// Records a change to a type that existed before this transaction.
    func addChanged(_ type: YType, _ key: String?) {
        if let item = type.item {
            guard item.id.clock < beforeState[item.id.client, default: 0], !item.deleted else { return }
        }
        changed[ObjectIdentifier(type), default: (type, [])].keys.insert(key)
    }
}
