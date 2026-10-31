import Foundation
import HappyWire
import Tailcat

public struct HTTP1Response: Sendable {
    public let status: Int
    public let headers: [String: String]
    public let body: Data
    public init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
        self.status = status; self.headers = headers; self.body = body
    }
}

public protocol AgentTransport: Sendable {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response
    /// A bounded file write with a longer deadline than small API requests.
    func upload(path: String, credential: String, body: Data) async throws -> HTTP1Response
    /// A GET whose body arrives as it is written, for an event stream.
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream
    /// Lets go of the connection so the next request makes a new one.
    func reset() async
    func close() async
}

/// A response head, and its decoded body as the bytes arrive. The body ends
/// when the server closes it; ending the iteration closes the stream.
public struct HTTP1Stream: Sendable {
    public let status: Int
    public let headers: [String: String]
    public let body: AsyncThrowingStream<Data, Error>
    public init(status: Int, headers: [String: String] = [:], body: AsyncThrowingStream<Data, Error>) {
        self.status = status; self.headers = headers; self.body = body
    }
}

extension AgentTransport {
    public func upload(path: String, credential: String, body: Data) async throws -> HTTP1Response {
        try await request(method: "PUT", path: path, credential: credential, body: body, headers: ["Content-Type": "application/json"])
    }
    public func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw PairingError.unavailable
    }

    public func reset() async {}

    func request(_ path: String, credential: String, method: String = "GET", body: Data? = nil, headers: [String: String] = [:]) async throws -> HTTP1Response {
        try await request(method: method, path: path, credential: credential, body: body, headers: headers)
    }
}

/// One private tunnel per instance; each HTTP request owns a fresh TCP stream.
/// `server.tailcat` is a logical authority, never a DNS lookup.
public actor TailcatHTTPTransport: AgentTransport {
    private let address: String
    let port: UInt16
    private var client: TailcatClient?
    private var connecting: Task<TailcatClient, Error>?
    private var closed = false

    public init(address: String, port: UInt16) { self.address = address; self.port = port }

    public func close() async {
        closed = true
        connecting?.cancel(); connecting = nil
        let old = client; client = nil
        await old?.close()
    }

    /// A computer whose daemon restarted has forgotten this tunnel's session
    /// and drops what it sends until the tunnel rekeys, minutes later; a new
    /// tunnel handshakes at once.
    public func reset() async {
        let old = client; client = nil
        await old?.close()
    }

    /// Resets the tunnel if it is still `used`, after a failure on it.
    func reset(_ used: TailcatClient) async {
        guard client === used else { return }
        await reset()
    }

    func connection() async throws -> TailcatClient {
        guard !closed else { throw CancellationError() }
        if let client { return client }
        let task: Task<TailcatClient, Error>
        if let connecting { task = connecting }
        else {
            let address = address
            task = Task { var config = TailcatClient.Configuration(); config.connectTimeout = 20; return try await TailcatClient.connect(to: address, configuration: config) }
            connecting = task
        }
        do {
            let value = try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
            guard !closed, !Task.isCancelled else { await value.close(); throw CancellationError() }
            connecting = nil; client = value
            return value
        } catch { connecting = nil; throw error }
    }

    public func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        guard ["GET", "POST", "PATCH", "PUT", "DELETE"].contains(method), Self.safe(path: path, credential: credential, headers: headers) else { throw PairingError.invalidResponse }
        let client = try await connection()
        let port = port
        do {
            return try await exchange(client: client, port: port, method: method, path: path, credential: credential, body: body, headers: headers, timeout: .seconds(35))
        } catch {
            if Self.lostTunnel(error) { await reset(client) }
            throw error
        }
    }

    /// Whether `error` says the tunnel carried nothing back (a timeout, a
    /// stream it could not open), rather than a refused or garbled answer.
    nonisolated static func lostTunnel(_ error: Error) -> Bool {
        if error is CancellationError { return false }
        if let error = error as? PairingError { return error == .unavailable }
        return true
    }

    public func upload(path: String, credential: String, body: Data) async throws -> HTTP1Response {
        guard body.count <= 72 * 1024 * 1024, Self.safe(path: path, credential: credential, headers: [:]) else {
            throw PairingError.invalidResponse
        }
        let client = try await connection()
        do {
            return try await exchange(client: client, port: port, method: "PUT", path: path, credential: credential,
                body: body, headers: [:], timeout: .seconds(15 * 60))
        } catch {
            if Self.lostTunnel(error) { await reset(client) }
            throw error
        }
    }

    private nonisolated func exchange(client: TailcatClient, port: UInt16, method: String, path: String, credential: String, body: Data?, headers: [String: String], timeout: Duration) async throws -> HTTP1Response {
        try await withThrowingTaskGroup(of: HTTP1Response.self) { group in
            group.addTask {
                let stream = try await client.openTCP(port: port)
                return try await withTaskCancellationHandler {
                    do {
                        var head = "\(method) \(path) HTTP/1.1\r\nHost: server.tailcat:\(port)\r\nAuthorization: Bearer \(credential)\r\nConnection: close\r\nAccept: application/json\r\nContent-Length: \(body?.count ?? 0)\r\n"
                        // JSON unless the caller names the type (a picture's bytes).
                        if body != nil, !headers.keys.contains(where: { $0.lowercased() == "content-type" }) { head += "Content-Type: application/json\r\n" }
                        for (name, value) in headers { head += "\(name): \(value)\r\n" }
                        try await stream.write(Data((head + "\r\n").utf8))
                        if let body {
                            var offset = 0
                            while offset < body.count {
                                try Task.checkCancellation()
                                let end = min(body.count, offset + 256 * 1024)
                                try await stream.write(Data(body[offset..<end]))
                                offset = end
                            }
                        }
                        var parser = HTTP1Parser()
                        while true {
                            try Task.checkCancellation()
                            let bytes = try await stream.read(maximumBytes: 65536)
                            if let response = try parser.append(bytes, eof: bytes.isEmpty) {
                                await stream.close()
                                return response
                            }
                        }
                    } catch { await stream.close(); throw error }
                } onCancel: { Task { await stream.close() } }
            }
            group.addTask { try await Task.sleep(for: timeout); throw PairingError.unavailable }
            defer { group.cancelAll() }
            guard let response = try await group.next() else { throw PairingError.unavailable }
            return response
        }
    }
}

/// Incremental HTTP/1.1 decoding with strict framing and bounded metadata.
/// Handles arbitrary TCP boundaries, length, chunked and close-delimited bodies.
struct HTTP1Parser {
    private var data = Data()
    private let limit = 8 * 1024 * 1024

    mutating func append(_ bytes: Data, eof: Bool) throws -> HTTP1Response? {
        guard data.count + bytes.count <= limit + 65536 else { throw PairingError.invalidResponse }
        data.append(bytes)
        guard let divider = data.range(of: Data("\r\n\r\n".utf8)) else {
            guard data.count <= 32768, !eof else { throw PairingError.invalidResponse }; return nil
        }
        guard divider.lowerBound <= 32768,
              let head = String(data: data[..<divider.lowerBound], encoding: .utf8) else { throw PairingError.invalidResponse }
        let lines = head.components(separatedBy: "\r\n")
        let statusParts = (lines.first ?? "").split(separator: " ")
        guard statusParts.count >= 2, ["HTTP/1.1", "HTTP/1.0"].contains(String(statusParts[0])), let status = Int(statusParts[1]), (200...599).contains(status) else { throw PairingError.invalidResponse }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { throw PairingError.invalidResponse }
            let name = line[..<colon].lowercased()
            guard !name.isEmpty, headers[name] == nil else { throw PairingError.invalidResponse }
            headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let body = Data(data[divider.upperBound...])
        if status == 204 || status == 304 { return HTTP1Response(status: status, headers: headers) }
        if let transfer = headers["transfer-encoding"] {
            guard transfer.lowercased() == "chunked", headers["content-length"] == nil else { throw PairingError.invalidResponse }
            var cursor = 0; var decoded = Data(); var chunks = 0
            while true {
                guard let lineEnd = body.range(of: Data("\r\n".utf8), in: cursor..<body.count) else {
                    guard body.count - cursor < 8192, !eof else { throw PairingError.invalidResponse }; return nil
                }
                guard lineEnd.lowerBound - cursor < 8192,
                      let text = String(data: body[cursor..<lineEnd.lowerBound], encoding: .utf8),
                      let countText = text.split(separator: ";", maxSplits: 1).first,
                      let count = Int(countText, radix: 16), count >= 0, count <= limit - decoded.count else { throw PairingError.invalidResponse }
                cursor = lineEnd.upperBound; chunks += 1
                guard chunks <= 65536 else { throw PairingError.invalidResponse }
                if count == 0 {
                    // No trailers, or bounded trailers terminated by a blank line.
                    if body.count >= cursor + 2, body[cursor..<cursor + 2] == Data("\r\n".utf8) { return HTTP1Response(status: status, headers: headers, body: decoded) }
                    if let end = body.range(of: Data("\r\n\r\n".utf8), in: cursor..<body.count), end.upperBound - cursor <= 32768 { return HTTP1Response(status: status, headers: headers, body: decoded) }
                    guard body.count - cursor <= 32768, !eof else { throw PairingError.invalidResponse }; return nil
                }
                guard body.count >= cursor + count + 2 else { if eof { throw PairingError.invalidResponse }; return nil }
                guard body[cursor + count..<cursor + count + 2] == Data("\r\n".utf8) else { throw PairingError.invalidResponse }
                decoded.append(body[cursor..<cursor + count]); cursor += count + 2
            }
        }
        if let length = headers["content-length"] {
            guard let count = Int(length), count >= 0, count <= limit else { throw PairingError.invalidResponse }
            if body.count >= count { return HTTP1Response(status: status, headers: headers, body: Data(body.prefix(count))) }
            if eof { throw PairingError.invalidResponse }; return nil
        }
        guard body.count <= limit else { throw PairingError.invalidResponse }
        return eof ? HTTP1Response(status: status, headers: headers, body: body) : nil
    }
}