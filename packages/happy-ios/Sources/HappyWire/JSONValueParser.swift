import Foundation

/// JSON text read straight into a `JSONValue`, one pass over its bytes.
///
/// `JSONValue`'s `Decodable` conformance can't ask the decoder what kind of
/// value comes next, so it tries each kind in turn: an object is first
/// tried as a bool, a number, a string and an array, each failure throwing.
/// Every event on the daemon's stream was read that way, several hundred a
/// second while agents work: a tenth of the phone's time. Text this parser
/// refuses (invalid UTF-8, a lone surrogate, anything outside RFC 8259) is
/// left to `JSONDecoder`, so what is accepted, and how, doesn't change.
struct JSONValueParser {
    struct Invalid: Error {}

    private let bytes: UnsafeBufferPointer<UInt8>
    private var at = 0

    private init(_ bytes: UnsafeBufferPointer<UInt8>) { self.bytes = bytes }

    static func parse(_ data: Data) throws -> JSONValue {
        try data.withUnsafeBytes { raw in
            var parser = JSONValueParser(raw.bindMemory(to: UInt8.self))
            parser.skipSpace()
            let value = try parser.value(depth: 0)
            parser.skipSpace()
            guard parser.at == parser.bytes.count else { throw Invalid() }
            return value
        }
    }

    private mutating func skipSpace() {
        while at < bytes.count {
            switch bytes[at] {
            case 0x20, 0x0A, 0x0D, 0x09: at += 1
            default: return
            }
        }
    }

    private mutating func value(depth: Int) throws -> JSONValue {
        // Deeper than any payload the daemon sends: left to the decoder.
        guard depth < 512, at < bytes.count else { throw Invalid() }
        switch bytes[at] {
        case UInt8(ascii: "{"): return try object(depth: depth)
        case UInt8(ascii: "["): return try array(depth: depth)
        case UInt8(ascii: "\""): return .string(try string())
        case UInt8(ascii: "t"): try literal("true"); return .bool(true)
        case UInt8(ascii: "f"): try literal("false"); return .bool(false)
        case UInt8(ascii: "n"): try literal("null"); return .null
        default: return .number(try number())
        }
    }

    private mutating func literal(_ word: StaticString) throws {
        let count = word.utf8CodeUnitCount
        guard at + count <= bytes.count else { throw Invalid() }
        let expected = UnsafeBufferPointer(start: word.utf8Start, count: count)
        for index in 0..<count where bytes[at + index] != expected[index] { throw Invalid() }
        at += count
    }

    private mutating func object(depth: Int) throws -> JSONValue {
        at += 1
        var object: [String: JSONValue] = [:]
        skipSpace()
        if at < bytes.count, bytes[at] == UInt8(ascii: "}") { at += 1; return .object(object) }
        while true {
            skipSpace()
            guard at < bytes.count, bytes[at] == UInt8(ascii: "\"") else { throw Invalid() }
            let key = try string()
            skipSpace()
            guard at < bytes.count, bytes[at] == UInt8(ascii: ":") else { throw Invalid() }
            at += 1
            skipSpace()
            let element = try value(depth: depth + 1)
            // A key given twice keeps its first value, as the decoder does.
            if object[key] == nil { object[key] = element }
            skipSpace()
            guard at < bytes.count else { throw Invalid() }
            if bytes[at] == UInt8(ascii: ",") { at += 1; continue }
            guard bytes[at] == UInt8(ascii: "}") else { throw Invalid() }
            at += 1
            return .object(object)
        }
    }

    private mutating func array(depth: Int) throws -> JSONValue {
        at += 1
        var array: [JSONValue] = []
        skipSpace()
        if at < bytes.count, bytes[at] == UInt8(ascii: "]") { at += 1; return .array(array) }
        while true {
            skipSpace()
            array.append(try value(depth: depth + 1))
            skipSpace()
            guard at < bytes.count else { throw Invalid() }
            if bytes[at] == UInt8(ascii: ",") { at += 1; continue }
            guard bytes[at] == UInt8(ascii: "]") else { throw Invalid() }
            at += 1
            return .array(array)
        }
    }

    private mutating func string() throws -> String {
        at += 1
        let start = at
        var ascii = true
        // Most strings have no escapes: taken whole from the input.
        while at < bytes.count {
            let byte = bytes[at]
            if byte == UInt8(ascii: "\"") {
                let text = try Self.text(UnsafeBufferPointer(rebasing: bytes[start..<at]), ascii: ascii)
                at += 1
                return text
            }
            if byte == UInt8(ascii: "\\") { break }
            guard byte >= 0x20 else { throw Invalid() }
            if byte >= 0x80 { ascii = false }
            at += 1
        }
        guard at < bytes.count else { throw Invalid() }
        var units = Array(bytes[start..<at])
        while at < bytes.count {
            let byte = bytes[at]
            switch byte {
            case UInt8(ascii: "\""):
                at += 1
                return try units.withUnsafeBufferPointer { try Self.text($0, ascii: ascii) }
            case UInt8(ascii: "\\"):
                at += 1
                guard at < bytes.count else { throw Invalid() }
                let escape = bytes[at]
                at += 1
                switch escape {
                case UInt8(ascii: "\""): units.append(0x22)
                case UInt8(ascii: "\\"): units.append(0x5C)
                case UInt8(ascii: "/"): units.append(0x2F)
                case UInt8(ascii: "b"): units.append(0x08)
                case UInt8(ascii: "f"): units.append(0x0C)
                case UInt8(ascii: "n"): units.append(0x0A)
                case UInt8(ascii: "r"): units.append(0x0D)
                case UInt8(ascii: "t"): units.append(0x09)
                case UInt8(ascii: "u"):
                    var scalar = try hex4()
                    if (0xD800...0xDBFF).contains(scalar) {
                        guard at + 1 < bytes.count, bytes[at] == UInt8(ascii: "\\"), bytes[at + 1] == UInt8(ascii: "u") else { throw Invalid() }
                        at += 2
                        let low = try hex4()
                        guard (0xDC00...0xDFFF).contains(low) else { throw Invalid() }
                        scalar = 0x10000 + ((scalar - 0xD800) << 10) + (low - 0xDC00)
                    } else if (0xDC00...0xDFFF).contains(scalar) {
                        throw Invalid()
                    }
                    guard let unicode = Unicode.Scalar(scalar) else { throw Invalid() }
                    if scalar >= 0x80 { ascii = false }
                    units.append(contentsOf: UTF8.encode(unicode)!)
                default:
                    throw Invalid()
                }
            default:
                guard byte >= 0x20 else { throw Invalid() }
                if byte >= 0x80 { ascii = false }
                units.append(byte)
                at += 1
            }
        }
        throw Invalid()
    }

    private mutating func hex4() throws -> UInt32 {
        guard at + 4 <= bytes.count else { throw Invalid() }
        var value: UInt32 = 0
        for _ in 0..<4 {
            let byte = bytes[at]
            let digit: UInt8
            switch byte {
            case UInt8(ascii: "0")...UInt8(ascii: "9"): digit = byte - UInt8(ascii: "0")
            case UInt8(ascii: "a")...UInt8(ascii: "f"): digit = byte - UInt8(ascii: "a") + 10
            case UInt8(ascii: "A")...UInt8(ascii: "F"): digit = byte - UInt8(ascii: "A") + 10
            default: throw Invalid()
            }
            value = value << 4 | UInt32(digit)
            at += 1
        }
        return value
    }

    /// UTF-8 as text, refused where it isn't valid.
    private static func text(_ units: UnsafeBufferPointer<UInt8>, ascii: Bool) throws -> String {
        if ascii { return String(decoding: units, as: UTF8.self) }
        if #available(macOS 15, iOS 18, *) {
            guard let text = String(validating: units, as: UTF8.self) else { throw Invalid() }
            return text
        }
        guard let text = String(bytes: units, encoding: .utf8) else { throw Invalid() }
        return text
    }

    /// RFC 8259's number, read as `JSONDecoder` reads it: a Double.
    private mutating func number() throws -> Double {
        let start = at
        if at < bytes.count, bytes[at] == UInt8(ascii: "-") { at += 1 }
        guard at < bytes.count else { throw Invalid() }
        if bytes[at] == UInt8(ascii: "0") {
            at += 1
        } else {
            guard digits() > 0 else { throw Invalid() }
        }
        if at < bytes.count, bytes[at] == UInt8(ascii: ".") {
            at += 1
            guard digits() > 0 else { throw Invalid() }
        }
        if at < bytes.count, bytes[at] == UInt8(ascii: "e") || bytes[at] == UInt8(ascii: "E") {
            at += 1
            if at < bytes.count, bytes[at] == UInt8(ascii: "+") || bytes[at] == UInt8(ascii: "-") { at += 1 }
            guard digits() > 0 else { throw Invalid() }
        }
        let text = String(decoding: UnsafeBufferPointer(rebasing: bytes[start..<at]), as: UTF8.self)
        // Out of Double's range the decoder refuses it too.
        guard let value = Double(text), value.isFinite else { throw Invalid() }
        return value
    }

    private mutating func digits() -> Int {
        let start = at
        while at < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[at]) { at += 1 }
        return at - start
    }
}
