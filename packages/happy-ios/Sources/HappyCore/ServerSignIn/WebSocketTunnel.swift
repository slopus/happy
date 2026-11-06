import Foundation
import HappyCrypto

/// What a server answered instead of `101 Switching Protocols`: the same
/// HTTP refusal its CONNECT twin would give, or what a load balancer put
/// in its place.
public struct TunnelRefusal: Error, Equatable, Sendable {
    public let status: Int
    public let contentType: String?
    public let body: Data

    public var requiresSignIn: Bool { SignInRequired.check(status: status, contentType: contentType, body: body) }
    public var isHappyError: Bool { SignInRequired.isHappyError(contentType: contentType, body: body) }
}

public enum WebSocketTunnelError: Error, Equatable, Sendable {
    /// A handshake or frame that breaks RFC 6455 or the tunnel's framing.
    case protocolViolation
    /// Nothing, not even a pong, for `WebSocketTunnel.silence`.
    case silent
    /// The server closed with something other than a normal close.
    case closed(code: UInt16)
}

/// One WebSocket tunnel (edge SSO contract §4): the bytes a CONNECT tunnel
/// carries after its `200`, as binary messages, so a load balancer that
/// refuses CONNECT still carries previews. Speaks RFC 6455 as a client over
/// any byte stream:
///
/// - binary messages only, each at most 1 MiB, boundaries meaningless;
/// - an empty binary message ends one direction; reading one, or a close,
///   is this stream's end;
/// - a ping every 20 seconds, and the tunnel is dead after 45 seconds with
///   nothing from the server (the daemon pings every 15).
///
/// Writes are serialized; one read at a time, as every `BrowserStream`.
public final class WebSocketTunnel: BrowserStream, @unchecked Sendable {
    public var authority: String { base.authority }
    static let maximumMessage = 1 << 20
    static let pingInterval: Duration = .seconds(20)
    static let silence: TimeInterval = 45
    private static let guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    private let base: any BrowserStream
    private let writer: Writer
    private let lock = NSLock()
    private var buffer: Data
    private var pending = Data()
    private var lastHeard = Date()
    private var ended = false
    private var keepalive: Task<Void, Never>?
    private let mask: @Sendable () -> [UInt8]

    init(base: any BrowserStream, initial: Data, mask: @escaping @Sendable () -> [UInt8] = WebSocketTunnel.randomMask) {
        self.base = base; buffer = initial; self.mask = mask
        writer = Writer(base: base, mask: mask)
    }

    deinit { keepalive?.cancel() }

    /// Upgrades `stream` at `path`, the credential in `Authorization` only.
    /// A refusal is thrown as `TunnelRefusal` with its (bounded) body.
    public static func open(_ stream: any BrowserStream, path: String, credential: String, key: Data = OAuthSignInRequest.randomBytes(16),
                            mask: @escaping @Sendable () -> [UInt8] = WebSocketTunnel.randomMask, keepalive: Bool = true) async throws -> WebSocketTunnel {
        guard path.hasPrefix("/"), !path.contains(where: { $0 == "\r" || $0 == "\n" || $0 == " " }),
              !credential.contains(where: { $0 == "\r" || $0 == "\n" }) else { throw WebSocketTunnelError.protocolViolation }
        let encodedKey = key.base64EncodedString()
        let head = "GET \(path) HTTP/1.1\r\nHost: \(stream.authority)\r\nAuthorization: Bearer \(credential)\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            + "Sec-WebSocket-Key: \(encodedKey)\r\nSec-WebSocket-Version: 13\r\n\r\n"
        try await stream.write(Data(head.utf8))
        let (response, rest) = try await BrowserRelay.head(stream)
        let status = Int(response.line.split(separator: " ").dropFirst().first ?? "") ?? 0
        guard status == 101 else {
            throw TunnelRefusal(status: status, contentType: response.value("content-type"), body: await refusalBody(stream, head: response, initial: rest))
        }
        let accept = Hashing.sha1(Data((encodedKey + guid).utf8)).base64EncodedString()
        guard response.value("upgrade")?.lowercased() == "websocket",
              response.value("connection")?.lowercased().split(separator: ",").contains(where: { $0.trimmingCharacters(in: .whitespaces) == "upgrade" }) == true,
              response.value("sec-websocket-accept") == accept else { throw WebSocketTunnelError.protocolViolation }
        let tunnel = WebSocketTunnel(base: stream, initial: rest, mask: mask)
        if keepalive { tunnel.startKeepalive() }
        return tunnel
    }

    /// Up to 64 KiB of a refusal's body, within five seconds, so a JSON
    /// error can be told from a load balancer's page.
    private static func refusalBody(_ stream: any BrowserStream, head: BrowserHTTPHead, initial: Data) async -> Data {
        let length = head.value("content-length").flatMap(Int.init).map { min($0, 65536) } ?? 65536
        var body = initial
        let deadline = Date().addingTimeInterval(5)
        while body.count < length, Date() < deadline, head.value("content-length") != nil {
            guard let bytes = try? await stream.read(maximumBytes: 65536), !bytes.isEmpty else { break }
            body.append(bytes)
        }
        await stream.close()
        return Data(body.prefix(length))
    }

    public static let randomMask: @Sendable () -> [UInt8] = { Array(OAuthSignInRequest.randomBytes(4)) }

    private func startKeepalive() {
        keepalive = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.pingInterval)
                guard let self, !Task.isCancelled else { return }
                if Date().timeIntervalSince(self.heard) > Self.silence {
                    await self.base.close()
                    return
                }
                try? await self.writer.send(opcode: 0x9, payload: Data())
            }
        }
    }

    private var heard: Date { lock.withLock { lastHeard } }

    public func read(maximumBytes: Int) async throws -> Data {
        while true {
            if let bytes = lock.withLock({ () -> Data? in
                if !pending.isEmpty {
                    let count = min(maximumBytes, pending.count)
                    defer { pending.removeFirst(count) }
                    return Data(pending.prefix(count))
                }
                return ended ? Data() : nil
            }) { return bytes }
            guard let frame = try await nextFrame() else {
                lock.withLock { ended = true }
                return Data()
            }
            lock.withLock { lastHeard = Date() }
            switch frame.opcode {
            case 0x0, 0x2:
                // An empty message is the server's end of stream.
                if frame.payload.isEmpty { lock.withLock { ended = true }; return Data() }
                lock.withLock { pending.append(frame.payload) }
            case 0x8:
                let code = frame.payload.count >= 2 ? UInt16(frame.payload[frame.payload.startIndex]) << 8 | UInt16(frame.payload[frame.payload.startIndex + 1]) : 1005
                lock.withLock { ended = true }
                try? await writer.send(opcode: 0x8, payload: Data([0x03, 0xE8]))
                if code == 1000 || code == 1005 { return Data() }
                throw WebSocketTunnelError.closed(code: code)
            case 0x9: try await writer.send(opcode: 0xA, payload: frame.payload)
            case 0xA: break
            default:
                // Text, or an opcode the tunnel doesn't use.
                try? await writer.send(opcode: 0x8, payload: Data([0x03, 0xEB]))
                await base.close()
                throw WebSocketTunnelError.protocolViolation
            }
        }
    }

    /// The next whole frame, or nil when the connection ended between frames.
    private func nextFrame() async throws -> (opcode: UInt8, payload: Data)? {
        while true {
            if let frame = try lock.withLock({ try Self.parse(&buffer) }) { return frame }
            let bytes: Data
            do { bytes = try await base.read(maximumBytes: 65536) }
            catch {
                if Date().timeIntervalSince(heard) > Self.silence { throw WebSocketTunnelError.silent }
                throw error
            }
            if bytes.isEmpty {
                if Date().timeIntervalSince(heard) > Self.silence { throw WebSocketTunnelError.silent }
                if lock.withLock({ buffer.isEmpty }) { return nil }
                throw WebSocketTunnelError.protocolViolation
            }
            lock.withLock { buffer.append(bytes) }
        }
    }

    /// One frame off the front of `buffer`. Server frames are never masked
    /// and never fragmented control frames; anything else is refused.
    static func parse(_ buffer: inout Data) throws -> (opcode: UInt8, payload: Data)? {
        let bytes = [UInt8](buffer.prefix(14))
        guard bytes.count >= 2 else { return nil }
        let opcode = bytes[0] & 0x0F
        guard bytes[0] & 0x70 == 0, bytes[1] & 0x80 == 0 else { throw WebSocketTunnelError.protocolViolation }
        if opcode >= 0x8 { guard bytes[0] & 0x80 != 0, bytes[1] & 0x7F <= 125 else { throw WebSocketTunnelError.protocolViolation } }
        var length = Int(bytes[1] & 0x7F)
        var offset = 2
        if length == 126 {
            guard bytes.count >= 4 else { return nil }
            length = Int(bytes[2]) << 8 | Int(bytes[3]); offset = 4
        } else if length == 127 {
            guard bytes.count >= 10 else { return nil }
            var value: UInt64 = 0
            for index in 2..<10 { value = value << 8 | UInt64(bytes[index]) }
            guard value <= UInt64(maximumMessage) else { throw WebSocketTunnelError.protocolViolation }
            length = Int(value); offset = 10
        }
        guard length <= maximumMessage else { throw WebSocketTunnelError.protocolViolation }
        guard buffer.count >= offset + length else { return nil }
        let start = buffer.startIndex + offset
        let payload = Data(buffer[start..<start + length])
        buffer = Data(buffer[(start + length)...])
        return (opcode, payload)
    }

    /// Split into messages of at most 256 KiB; an empty write ends this
    /// direction.
    public func write(_ data: Data) async throws {
        if data.isEmpty { try await writer.send(opcode: 0x2, payload: Data()); return }
        var offset = data.startIndex
        while offset < data.endIndex {
            let end = min(data.endIndex, offset + 256 * 1024)
            try await writer.send(opcode: 0x2, payload: Data(data[offset..<end]))
            offset = end
        }
    }

    public func close() async {
        keepalive?.cancel()
        try? await writer.send(opcode: 0x8, payload: Data([0x03, 0xE8]))
        await base.close()
    }

    /// Masked client frames, one at a time.
    actor Writer {
        let base: any BrowserStream
        let mask: @Sendable () -> [UInt8]
        private var closed = false

        init(base: any BrowserStream, mask: @escaping @Sendable () -> [UInt8]) { self.base = base; self.mask = mask }

        func send(opcode: UInt8, payload: Data) async throws {
            guard !closed else { if opcode == 0x8 || opcode == 0xA || opcode == 0x9 { return }; throw CancellationError() }
            if opcode == 0x8 { closed = true }
            try await base.write(WebSocketTunnel.frame(opcode: opcode, payload: payload, mask: mask()))
        }
    }

    static func frame(opcode: UInt8, payload: Data, mask: [UInt8]) -> Data {
        var frame = Data([0x80 | opcode])
        let count = payload.count
        if count <= 125 { frame.append(0x80 | UInt8(count)) }
        else if count <= 0xFFFF { frame.append(contentsOf: [0x80 | 126, UInt8(count >> 8), UInt8(count & 0xFF)] as [UInt8]) }
        else {
            frame.append(0x80 | 127)
            for shift in stride(from: 56, through: 0, by: -8) { frame.append(UInt8((UInt64(count) >> UInt64(shift)) & 0xFF)) }
        }
        frame.append(contentsOf: mask)
        var masked = [UInt8](payload)
        for index in masked.indices { masked[index] ^= mask[index & 3] }
        frame.append(contentsOf: masked)
        return frame
    }
}
