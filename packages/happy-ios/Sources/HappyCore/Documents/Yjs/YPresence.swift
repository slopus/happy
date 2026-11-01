import Foundation

/// A position that stays put while others edit around it (`RelativePosition`):
/// the item to its right, or the end of a type. Cursors travel as these.
public struct YRelativePosition: Equatable, Sendable {
    public var type: YID?
    public var tname: String?
    public var item: YID?
    public var assoc: Int

    public init(type: YID?, tname: String?, item: YID?, assoc: Int = 0) {
        self.type = type
        self.tname = tname
        self.item = item
        self.assoc = assoc
    }

    /// `createRelativePositionFromTypeIndex`.
    public init(_ parent: YType, index: Int, assoc: Int = 0) {
        let typeID = parent.item?.id
        let tname = parent.item == nil ? parent.rootName : nil
        var index = index
        if assoc < 0 {
            if index == 0 { self.init(type: typeID, tname: tname, item: nil, assoc: assoc); return }
            index -= 1
        }
        var t = parent.start
        while let item = t {
            if !item.deleted, item.countable {
                if item.length > index {
                    self.init(type: typeID, tname: tname, item: YID(client: item.id.client, clock: item.id.clock + index), assoc: assoc)
                    return
                }
                index -= item.length
            }
            if item.right == nil, assoc < 0 {
                self.init(type: typeID, tname: tname, item: item.lastId, assoc: assoc)
                return
            }
            t = item.right
        }
        self.init(type: typeID, tname: tname, item: nil, assoc: assoc)
    }

    /// The type and index it stands at now (`createAbsolutePositionFromRelativePosition`).
    public func resolve(in doc: YDoc) -> (type: YType, index: Int)? {
        let store = doc.store
        if let rightID = item {
            guard store.state(rightID.client) > rightID.clock else { return nil }
            let right = store.item(rightID)
            guard right.kind == .item, let parent = right.parentType else { return nil }
            var index = 0
            if !(parent.item?.deleted ?? false) {
                let diff = rightID.clock - right.id.clock
                index = right.deleted || !right.countable ? 0 : diff + (assoc >= 0 ? 0 : 1)
                var n = right.left
                while let left = n {
                    if !left.deleted, left.countable { index += left.length }
                    n = left.left
                }
            }
            return (parent, index)
        }
        let type: YType
        if let tname {
            type = doc.root(tname)
        } else if let typeID = self.type {
            guard store.state(typeID.client) > typeID.clock else { return nil }
            let holder = store.item(typeID)
            guard holder.kind == .item, case let .type(found) = holder.content else { return nil }
            type = found
        } else {
            return nil
        }
        return (type, assoc >= 0 ? type.length : 0)
    }

    /// As `JSON.stringify` writes a `RelativePosition`, the way awareness carries it.
    public var json: YAny {
        func id(_ id: YID?) -> YAny { id.map { .object([("client", .number(Double($0.client))), ("clock", .number(Double($0.clock)))]) } ?? .null }
        return .object([("type", id(type)), ("tname", tname.map(YAny.string) ?? .null), ("item", id(item)), ("assoc", .number(Double(assoc)))])
    }

    public init?(json: YAny) {
        guard case .object = json else { return nil }
        func id(_ value: YAny?) -> YID? {
            guard let client = value?["client"]?.numberValue, let clock = value?["clock"]?.numberValue else { return nil }
            return YID(client: Int(client), clock: Int(clock))
        }
        self.init(type: id(json["type"]), tname: json["tname"]?.stringValue, item: id(json["item"]), assoc: Int(json["assoc"]?.numberValue ?? 0))
        if type == nil, tname == nil, item == nil { return nil }
    }
}

/// One replica's presence: y-protocols' awareness state with its clock.
public struct YAwarenessState: Equatable, Sendable {
    public var clientID: Int
    public var clock: Int
    /// The JSON state, or nil once it left.
    public var state: YAny?

    public init(clientID: Int, clock: Int, state: YAny?) {
        self.clientID = clientID
        self.clock = clock
        self.state = state
    }

    /// `encodeAwarenessUpdate` for these states.
    public static func encode(_ states: [YAwarenessState]) -> [UInt8] {
        var encoder = YEncoder()
        encoder.writeVarUint(states.count)
        for state in states {
            encoder.writeVarUint(state.clientID)
            encoder.writeVarUint(state.clock)
            encoder.writeVarString(state.state?.jsonString ?? "null")
        }
        return encoder.bytes
    }

    public static func decode(_ bytes: [UInt8]) throws -> [YAwarenessState] {
        var decoder = YDecoder(bytes)
        let count = try decoder.readVarUint()
        var out: [YAwarenessState] = []
        for _ in 0..<count {
            let client = try decoder.readVarUint()
            let clock = try decoder.readVarUint()
            let state = try YAny.parseJSON(try decoder.readVarString())
            out.append(YAwarenessState(clientID: client, clock: clock, state: state == .null ? nil : state))
        }
        return out
    }
}
