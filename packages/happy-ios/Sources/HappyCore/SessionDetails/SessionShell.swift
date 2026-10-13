import Foundation

/// The session shell calls the session detail screens make: SessionActions'
/// sessionBash and sessionReadFile, or a test's stand-ins.
public struct SessionShellTransport: Sendable {
    public var bash: @Sendable (SessionBashRequest) async throws -> SessionBashResponse
    public var readFile: @Sendable (String) async throws -> SessionReadFileResponse

    public init(
        bash: @escaping @Sendable (SessionBashRequest) async throws -> SessionBashResponse,
        readFile: @escaping @Sendable (String) async throws -> SessionReadFileResponse
    ) {
        self.bash = bash
        self.readFile = readFile
    }

    public init(actions: SessionActions, sessionId: String) {
        bash = { try await actions.sessionBash(sessionId: sessionId, request: $0) }
        readFile = { try await actions.sessionReadFile(sessionId: sessionId, path: $0) }
    }
}

/// JavaScript's `atob` and `new TextDecoder().decode`, for file contents
/// readFile returns as base64.
public enum JSBase64 {
    /// `atob` (forgiving-base64 decode): ASCII whitespace is ignored, one or
    /// two trailing `=` are dropped when the length is a multiple of four,
    /// and anything else outside the alphabet, or a length of 4n + 1,
    /// fails. Leftover bits are discarded.
    public static func decode(_ string: String) -> Data? {
        var bytes = string.utf8.filter { ![0x09, 0x0A, 0x0C, 0x0D, 0x20].contains($0) }
        if bytes.count % 4 == 0 {
            for _ in 0..<2 where bytes.last == UInt8(ascii: "=") { bytes.removeLast() }
        }
        guard bytes.count % 4 != 1 else { return nil }
        var output = Data()
        output.reserveCapacity(bytes.count * 3 / 4)
        var buffer: UInt32 = 0
        var bits = 0
        for byte in bytes {
            guard let value = sextet(byte) else { return nil }
            buffer = (buffer << 6) | UInt32(value)
            bits += 6
            if bits >= 8 {
                bits -= 8
                output.append(UInt8((buffer >> UInt32(bits)) & 0xFF))
            }
        }
        return output
    }

    private static func sextet(_ byte: UInt8) -> UInt8? {
        switch byte {
        case UInt8(ascii: "A")...UInt8(ascii: "Z"): byte - UInt8(ascii: "A")
        case UInt8(ascii: "a")...UInt8(ascii: "z"): byte - UInt8(ascii: "a") + 26
        case UInt8(ascii: "0")...UInt8(ascii: "9"): byte - UInt8(ascii: "0") + 52
        case UInt8(ascii: "+"): 62
        case UInt8(ascii: "/"): 63
        default: nil
        }
    }

    /// `new TextDecoder().decode(bytes)`: UTF-8, malformed sequences
    /// replaced, a leading byte order mark dropped.
    public static func utf8(_ data: Data) -> String {
        let body = data.starts(with: [0xEF, 0xBB, 0xBF]) ? data.dropFirst(3) : data[...]
        return String(decoding: body, as: UTF8.self)
    }
}
