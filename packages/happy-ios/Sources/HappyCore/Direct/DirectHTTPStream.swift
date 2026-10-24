import Foundation
import HappyWire
import Tailcat

extension TailcatHTTPTransport {
    nonisolated static func safe(path: String, credential: String, headers: [String: String]) -> Bool {
        path.hasPrefix("/") && !path.contains("\r") && !path.contains("\n") && !path.contains(" ")
            && !credential.contains("\r") && !credential.contains("\n")
            && headers.allSatisfy { !$0.key.contains("\r") && !$0.key.contains("\n") && !$0.key.contains(":") && !$0.value.contains("\r") && !$0.value.contains("\n") }
    }

    /// The head must arrive within 35 seconds; the body then has no deadline
    /// and runs until the server ends it or the consumer stops iterating.
    public func stream(path: String, credential: String, headers: [String: String]) async throws -> DirectHTTPStream {
        guard Self.safe(path: path, credential: credential, headers: headers) else { throw DirectPairingError.invalidResponse }
        let client = try await connection()
        let port = port
        let stream: TailcatConnection
        do { stream = try await client.openTCP(port: port) } catch {
            if Self.lostTunnel(error) { await reset(client) }
            throw error
        }
        do {
            var head = "GET \(path) HTTP/1.1\r\nHost: server.tailcat:\(port)\r\nAuthorization: Bearer \(credential)\r\nConnection: close\r\nAccept: text/event-stream\r\n"
            for (name, value) in headers { head += "\(name): \(value)\r\n" }
            try await stream.write(Data((head + "\r\n").utf8))
            let (responseHead, rest) = try await withThrowingTaskGroup(of: (DirectHTTPHead, Data).self) { group in
                group.addTask {
                    var buffer = Data()
                    while true {
                        try Task.checkCancellation()
                        let bytes = try await stream.read(maximumBytes: 65536)
                        buffer.append(bytes)
                        if let parsed = try DirectHTTPHead.parse(buffer) { return parsed }
                        if bytes.isEmpty { throw DirectPairingError.unavailable }
                    }
                }
                group.addTask { try await Task.sleep(for: .seconds(35)); throw DirectPairingError.unavailable }
                defer { group.cancelAll() }
                guard let value = try await group.next() else { throw DirectPairingError.unavailable }
                return value
            }
            let chunked = responseHead.headers["transfer-encoding"]?.lowercased() == "chunked"
            let body = AsyncThrowingStream<Data, Error> { continuation in
                let reader = Task {
                    var decoder = DirectBodyDecoder(chunked: chunked)
                    do {
                        var bytes = rest
                        while true {
                            let decoded = try decoder.append(bytes)
                            if !decoded.isEmpty { continuation.yield(decoded) }
                            if decoder.finished { break }
                            try Task.checkCancellation()
                            bytes = try await stream.read(maximumBytes: 65536)
                            if bytes.isEmpty { break }
                        }
                        continuation.finish()
                    } catch { continuation.finish(throwing: error) }
                    await stream.close()
                }
                continuation.onTermination = { _ in reader.cancel(); Task { await stream.close() } }
            }
            return DirectHTTPStream(status: responseHead.status, headers: responseHead.headers, body: body)
        } catch {
            await stream.close()
            // No answer on a stream the tunnel opened: the far side may
            // have restarted and forgotten it.
            if Self.lostTunnel(error) { await reset(client) }
            throw error
        }
    }
}

/// A response's status line and headers, once all of them have arrived, and
/// the body bytes that came with them.
struct DirectHTTPHead: Sendable {
    let status: Int
    let headers: [String: String]

    static func parse(_ data: Data) throws -> (DirectHTTPHead, Data)? {
        guard let divider = data.range(of: Data("\r\n\r\n".utf8)) else {
            guard data.count <= 32768 else { throw DirectPairingError.invalidResponse }
            return nil
        }
        guard divider.lowerBound - data.startIndex <= 32768,
              let head = String(data: data[..<divider.lowerBound], encoding: .utf8) else { throw DirectPairingError.invalidResponse }
        let lines = head.components(separatedBy: "\r\n")
        let statusParts = (lines.first ?? "").split(separator: " ")
        guard statusParts.count >= 2, ["HTTP/1.1", "HTTP/1.0"].contains(String(statusParts[0])),
              let status = Int(statusParts[1]), (200...599).contains(status) else { throw DirectPairingError.invalidResponse }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { throw DirectPairingError.invalidResponse }
            let name = line[..<colon].lowercased()
            guard !name.isEmpty, headers[name] == nil else { throw DirectPairingError.invalidResponse }
            headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        return (DirectHTTPHead(status: status, headers: headers), Data(data[divider.upperBound...]))
    }
}

/// A streamed body decoded as it comes: chunked framing undone, or the bytes
/// as they are when the body is close-delimited.
struct DirectBodyDecoder {
    let chunked: Bool
    private var pending = Data()
    /// Bytes left in the current chunk; nil while a size line is awaited.
    private var remaining: Int?
    private(set) var finished = false

    init(chunked: Bool) { self.chunked = chunked }

    mutating func append(_ bytes: Data) throws -> Data {
        guard chunked else { return bytes }
        pending.append(bytes)
        var out = Data()
        while !finished {
            if let count = remaining {
                if count > 0 {
                    let take = min(count, pending.count)
                    guard take > 0 else { break }
                    out.append(pending.prefix(take))
                    pending = Data(pending.dropFirst(take))
                    remaining = count - take
                    continue
                }
                guard pending.count >= 2 else { break }
                guard pending.prefix(2) == Data("\r\n".utf8) else { throw DirectPairingError.invalidResponse }
                pending = Data(pending.dropFirst(2))
                remaining = nil
                continue
            }
            guard let lineEnd = pending.range(of: Data("\r\n".utf8)) else {
                guard pending.count < 8192 else { throw DirectPairingError.invalidResponse }
                break
            }
            guard let text = String(data: pending[pending.startIndex..<lineEnd.lowerBound], encoding: .utf8),
                  let countText = text.split(separator: ";", maxSplits: 1).first,
                  let count = Int(countText.trimmingCharacters(in: .whitespaces), radix: 16),
                  count >= 0, count <= 8 * 1024 * 1024 else { throw DirectPairingError.invalidResponse }
            pending = Data(pending[lineEnd.upperBound...])
            if count == 0 { finished = true } else { remaining = count }
        }
        return out
    }
}

/// One Server-Sent Events frame.
public struct ServerSentEvent: Equatable, Sendable {
    public var id: String?
    public var event: String
    public var data: String
}

/// Splits a byte stream into SSE frames (WHATWG event-stream parsing): lines
/// end in LF, CR or CRLF; comments are skipped; `data` lines join with LF.
public struct ServerSentEventParser: Sendable {
    private var buffer = Data()
    private var sawCR = false
    private var id: String?
    private var event = ""
    private var data: [String] = []
    private var hasData = false

    public init() {}

    public mutating func append(_ bytes: Data) -> [ServerSentEvent] {
        var frames: [ServerSentEvent] = []
        for byte in bytes {
            if sawCR {
                sawCR = false
                if byte == 0x0A { continue }
            }
            if byte == 0x0A || byte == 0x0D {
                sawCR = byte == 0x0D
                line(String(decoding: buffer, as: UTF8.self), into: &frames)
                buffer.removeAll(keepingCapacity: true)
            } else {
                buffer.append(byte)
            }
        }
        return frames
    }

    private mutating func line(_ line: String, into frames: inout [ServerSentEvent]) {
        if line.isEmpty {
            if hasData {
                frames.append(ServerSentEvent(id: id, event: event.isEmpty ? "message" : event, data: data.joined(separator: "\n")))
            }
            event = ""; data = []; hasData = false; id = nil
            return
        }
        if line.hasPrefix(":") { return }
        let field: Substring
        var value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            value = line[line.index(after: colon)...]
            if value.first == " " { value = value.dropFirst() }
        } else {
            field = Substring(line); value = ""
        }
        switch field {
        case "event": event = String(value)
        case "data": data.append(String(value)); hasData = true
        case "id": if !value.contains("\0") { id = String(value) }
        default: break
        }
    }
}
