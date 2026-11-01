import Foundation

/// A value as lib0 encodes it (`writeAny`): what Yjs keeps in maps,
/// attributes and formats. Objects keep their keys in order, as a
/// JavaScript object does, so encoding is the same bytes JavaScript writes.
public indirect enum YAny: Equatable, Sendable {
    case undefined
    case null
    case bool(Bool)
    case number(Double)
    case bigint(Int64)
    case string(String)
    case array([YAny])
    case object([(String, YAny)])
    case bytes([UInt8])

    public static func == (a: YAny, b: YAny) -> Bool {
        switch (a, b) {
        case (.undefined, .undefined), (.null, .null): return true
        case let (.bool(x), .bool(y)): return x == y
        case let (.number(x), .number(y)): return x == y
        case let (.bigint(x), .bigint(y)): return x == y
        case let (.string(x), .string(y)): return x == y
        case let (.array(x), .array(y)): return x == y
        case let (.bytes(x), .bytes(y)): return x == y
        case let (.object(x), .object(y)):
            // Objects compare by their keys and values, whatever the order.
            guard x.count == y.count else { return false }
            for (key, value) in x {
                guard let other = y.first(where: { $0.0 == key }), other.1 == value else { return false }
            }
            return true
        default: return false
        }
    }

    public subscript(key: String) -> YAny? {
        guard case let .object(pairs) = self else { return nil }
        return pairs.first { $0.0 == key }?.1
    }

    public var stringValue: String? { if case let .string(s) = self { return s }; return nil }
    public var boolValue: Bool? { if case let .bool(b) = self { return b }; return nil }
    public var numberValue: Double? { if case let .number(n) = self { return n }; return nil }
    public var isNullish: Bool { self == .null || self == .undefined }

    // MARK: JSON

    /// `JSON.parse`. Numbers come back as doubles, as in JavaScript.
    public static func parseJSON(_ text: String) throws -> YAny {
        var parser = JSONScanner(Array(text.utf8))
        let value = try parser.value()
        parser.skipSpace()
        guard parser.atEnd else { throw YError.malformed("trailing JSON") }
        return value
    }

    /// `JSON.stringify`: no spaces, keys in order, undefined left out of objects.
    public var jsonString: String {
        var out = ""
        writeJSON(into: &out)
        return out
    }

    private func writeJSON(into out: inout String) {
        switch self {
        case .undefined, .null: out += "null"
        case let .bool(b): out += b ? "true" : "false"
        case let .number(n): out += Self.jsNumber(n)
        case let .bigint(n): out += String(n)
        case let .string(s): Self.quote(s, into: &out)
        case let .bytes(b):
            // A Uint8Array stringifies as an object of indices.
            out += "{"
            for (i, byte) in b.enumerated() { if i > 0 { out += "," }; out += "\"\(i)\":\(byte)" }
            out += "}"
        case let .array(items):
            out += "["
            for (i, item) in items.enumerated() {
                if i > 0 { out += "," }
                if item == .undefined { out += "null" } else { item.writeJSON(into: &out) }
            }
            out += "]"
        case let .object(pairs):
            out += "{"
            var first = true
            for (key, value) in pairs where value != .undefined {
                if !first { out += "," }
                first = false
                Self.quote(key, into: &out)
                out += ":"
                value.writeJSON(into: &out)
            }
            out += "}"
        }
    }

    static func jsNumber(_ n: Double) -> String {
        guard n.isFinite else { return "null" }
        if n == n.rounded(), abs(n) < 1e21 { return String(Int64(n)) }
        var text = "\(n)"
        if text.hasSuffix(".0") { text.removeLast(2) }
        return text
    }

    private static func quote(_ s: String, into out: inout String) {
        out += "\""
        for unit in s.unicodeScalars {
            switch unit {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            default:
                if unit.value < 0x20 { out += String(format: "\\u%04x", unit.value) } else { out.unicodeScalars.append(unit) }
            }
        }
        out += "\""
    }
}

public enum YError: Error, Equatable {
    case malformed(String)
    case unexpected(String)
}

private struct JSONScanner {
    let bytes: [UInt8]
    var index = 0
    init(_ bytes: [UInt8]) { self.bytes = bytes }
    var atEnd: Bool { index >= bytes.count }

    mutating func skipSpace() {
        while index < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[index]) { index += 1 }
    }

    mutating func value() throws -> YAny {
        skipSpace()
        guard index < bytes.count else { throw YError.malformed("JSON ends") }
        switch bytes[index] {
        case UInt8(ascii: "{"):
            index += 1
            var pairs: [(String, YAny)] = []
            skipSpace()
            if index < bytes.count, bytes[index] == UInt8(ascii: "}") { index += 1; return .object(pairs) }
            while true {
                skipSpace()
                guard case let .string(key) = try value() else { throw YError.malformed("JSON key") }
                skipSpace()
                guard index < bytes.count, bytes[index] == UInt8(ascii: ":") else { throw YError.malformed("JSON colon") }
                index += 1
                let item = try value()
                if let existing = pairs.firstIndex(where: { $0.0 == key }) { pairs[existing].1 = item } else { pairs.append((key, item)) }
                skipSpace()
                guard index < bytes.count else { throw YError.malformed("JSON object") }
                if bytes[index] == UInt8(ascii: ",") { index += 1; continue }
                if bytes[index] == UInt8(ascii: "}") { index += 1; return .object(pairs) }
                throw YError.malformed("JSON object")
            }
        case UInt8(ascii: "["):
            index += 1
            var items: [YAny] = []
            skipSpace()
            if index < bytes.count, bytes[index] == UInt8(ascii: "]") { index += 1; return .array(items) }
            while true {
                items.append(try value())
                skipSpace()
                guard index < bytes.count else { throw YError.malformed("JSON array") }
                if bytes[index] == UInt8(ascii: ",") { index += 1; continue }
                if bytes[index] == UInt8(ascii: "]") { index += 1; return .array(items) }
                throw YError.malformed("JSON array")
            }
        case UInt8(ascii: "\""):
            return .string(try string())
        case UInt8(ascii: "t"): try word("true"); return .bool(true)
        case UInt8(ascii: "f"): try word("false"); return .bool(false)
        case UInt8(ascii: "n"): try word("null"); return .null
        default:
            let start = index
            while index < bytes.count, "+-0123456789.eE".utf8.contains(bytes[index]) { index += 1 }
            guard let text = String(bytes: bytes[start..<index], encoding: .utf8), let number = Double(text) else { throw YError.malformed("JSON number") }
            return .number(number)
        }
    }

    private mutating func word(_ w: String) throws {
        let utf8 = Array(w.utf8)
        guard index + utf8.count <= bytes.count, Array(bytes[index..<index + utf8.count]) == utf8 else { throw YError.malformed("JSON word") }
        index += utf8.count
    }

    private mutating func string() throws -> String {
        index += 1
        var units: [UInt16] = []
        var raw: [UInt8] = []
        func flush() { if !raw.isEmpty { units += String(decoding: raw, as: UTF8.self).utf16; raw.removeAll() } }
        while index < bytes.count {
            let byte = bytes[index]
            if byte == UInt8(ascii: "\"") { index += 1; flush(); return String(decoding: units, as: UTF16.self) }
            if byte == UInt8(ascii: "\\") {
                flush()
                index += 1
                guard index < bytes.count else { break }
                let escape = bytes[index]
                index += 1
                switch escape {
                case UInt8(ascii: "n"): units.append(0x0A)
                case UInt8(ascii: "r"): units.append(0x0D)
                case UInt8(ascii: "t"): units.append(0x09)
                case UInt8(ascii: "b"): units.append(0x08)
                case UInt8(ascii: "f"): units.append(0x0C)
                case UInt8(ascii: "u"):
                    guard index + 4 <= bytes.count, let hex = String(bytes: bytes[index..<index + 4], encoding: .ascii), let code = UInt16(hex, radix: 16) else { throw YError.malformed("JSON escape") }
                    units.append(code)
                    index += 4
                default: units.append(UInt16(escape))
                }
                continue
            }
            raw.append(byte)
            index += 1
        }
        throw YError.malformed("JSON string")
    }
}

// MARK: Encoding

/// lib0's `encoding`: variable-length integers, strings and `any`.
public struct YEncoder {
    public private(set) var bytes: [UInt8] = []
    public init() {}

    public mutating func write(_ byte: UInt8) { bytes.append(byte) }
    public mutating func write(_ data: [UInt8]) { bytes.append(contentsOf: data) }

    public mutating func writeVarUint(_ value: Int) {
        var num = UInt64(value)
        while num > 0x7F {
            bytes.append(UInt8(0x80 | (num & 0x7F)))
            num >>= 7
        }
        bytes.append(UInt8(num))
    }

    /// Sign in the first byte's 7th bit, as lib0 writes it.
    public mutating func writeVarInt(_ value: Int) {
        let negative = value < 0
        var num = UInt64(negative ? -value : value)
        bytes.append(UInt8((num > 0x3F ? 0x80 : 0) | (negative ? 0x40 : 0) | (num & 0x3F)))
        num >>= 6
        while num > 0 {
            bytes.append(UInt8((num > 0x7F ? 0x80 : 0) | (num & 0x7F)))
            num >>= 7
        }
    }

    public mutating func writeVarString(_ string: String) {
        let utf8 = Array(string.utf8)
        writeVarUint(utf8.count)
        bytes.append(contentsOf: utf8)
    }

    /// A JavaScript string held as UTF-16, encoded as `TextEncoder` would:
    /// a lone surrogate becomes U+FFFD.
    public mutating func writeVarString(utf16: [UInt16]) {
        writeVarString(String(decoding: utf16, as: UTF16.self))
    }

    public mutating func writeVarUint8Array(_ data: [UInt8]) {
        writeVarUint(data.count)
        bytes.append(contentsOf: data)
    }

    public mutating func writeAny(_ value: YAny) {
        switch value {
        case .undefined: write(127)
        case .null: write(126)
        case let .number(n):
            if n == n.rounded(), abs(n) <= 2_147_483_647, !(n == 0 && n.sign == .minus) {
                write(125)
                writeVarInt(Int(n))
            } else if Double(Float(n)) == n {
                write(124)
                withUnsafeBytes(of: Float(n).bitPattern.bigEndian) { bytes.append(contentsOf: $0) }
            } else {
                write(123)
                withUnsafeBytes(of: n.bitPattern.bigEndian) { bytes.append(contentsOf: $0) }
            }
        case let .bigint(n):
            write(122)
            withUnsafeBytes(of: n.bigEndian) { bytes.append(contentsOf: $0) }
        case let .bool(b): write(b ? 120 : 121)
        case let .string(s):
            write(119)
            writeVarString(s)
        case let .object(pairs):
            write(118)
            writeVarUint(pairs.count)
            for (key, item) in pairs {
                writeVarString(key)
                writeAny(item)
            }
        case let .array(items):
            write(117)
            writeVarUint(items.count)
            for item in items { writeAny(item) }
        case let .bytes(data):
            write(116)
            writeVarUint8Array(data)
        }
    }
}

/// lib0's `decoding`.
public struct YDecoder {
    let bytes: [UInt8]
    public private(set) var position = 0

    public init(_ bytes: [UInt8]) { self.bytes = bytes }
    public var hasContent: Bool { position < bytes.count }

    public mutating func readUint8() throws -> UInt8 {
        guard position < bytes.count else { throw YError.malformed("unexpected end") }
        defer { position += 1 }
        return bytes[position]
    }

    public mutating func readVarUint() throws -> Int {
        var num: UInt64 = 0
        var shift: UInt64 = 0
        while true {
            let byte = try readUint8()
            num |= UInt64(byte & 0x7F) << shift
            shift += 7
            if byte < 0x80 { return Int(num) }
            if shift > 63 { throw YError.malformed("integer out of range") }
        }
    }

    public mutating func readVarInt() throws -> Int {
        var byte = try readUint8()
        var num = UInt64(byte & 0x3F)
        var shift: UInt64 = 6
        let negative = byte & 0x40 != 0
        if byte & 0x80 == 0 { return negative ? -Int(num) : Int(num) }
        while true {
            byte = try readUint8()
            num |= UInt64(byte & 0x7F) << shift
            shift += 7
            if byte < 0x80 { return negative ? -Int(num) : Int(num) }
            if shift > 63 { throw YError.malformed("integer out of range") }
        }
    }

    public mutating func readBytes(_ count: Int) throws -> [UInt8] {
        guard count >= 0, position + count <= bytes.count else { throw YError.malformed("unexpected end") }
        defer { position += count }
        return Array(bytes[position..<position + count])
    }

    public mutating func readVarUint8Array() throws -> [UInt8] { try readBytes(try readVarUint()) }

    public mutating func readVarString() throws -> String {
        String(decoding: try readVarUint8Array(), as: UTF8.self)
    }

    public mutating func readAny() throws -> YAny {
        switch try readUint8() {
        case 127: return .undefined
        case 126: return .null
        case 125: return .number(Double(try readVarInt()))
        case 124:
            let raw = try readBytes(4).reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
            return .number(Double(Float(bitPattern: raw)))
        case 123:
            let raw = try readBytes(8).reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
            return .number(Double(bitPattern: raw))
        case 122:
            let raw = try readBytes(8).reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
            return .bigint(Int64(bitPattern: raw))
        case 121: return .bool(false)
        case 120: return .bool(true)
        case 119: return .string(try readVarString())
        case 118:
            let count = try readVarUint()
            var pairs: [(String, YAny)] = []
            pairs.reserveCapacity(min(count, 1024))
            for _ in 0..<count {
                let key = try readVarString()
                pairs.append((key, try readAny()))
            }
            return .object(pairs)
        case 117:
            let count = try readVarUint()
            var items: [YAny] = []
            items.reserveCapacity(min(count, 1024))
            for _ in 0..<count { items.append(try readAny()) }
            return .array(items)
        case 116: return .bytes(try readVarUint8Array())
        default: return .undefined
        }
    }
}
