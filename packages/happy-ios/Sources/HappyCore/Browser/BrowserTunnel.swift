import Foundation
import Tailcat

/// Backpressured bytes: each read/write finishes before the next is issued.
public protocol BrowserStream: Sendable {
    func read(maximumBytes: Int) async throws -> Data
    func write(_ data: Data) async throws
    func close() async
}

extension TailcatConnection: BrowserStream {}

extension AgentTransport {
    public func browserConnection() async throws -> any BrowserStream { throw BrowserError.unavailable }
}

extension TailcatHTTPTransport {
    public func browserConnection() async throws -> any BrowserStream {
        try await connection().openTCP(port: port)
    }
}

extension AgentClient {
    /// Authentication is injected here and never returned to the web process.
    public func browserTunnel(workspaceID: String, target: BrowserPolicy.Authority) async throws -> any BrowserStream {
        guard BrowserPolicy.validID(workspaceID) else { throw BrowserError.forbidden }
        let stream = try await transport.browserConnection()
        do {
            try await Self.connect(stream, target: "/v0/workspaces/\(workspaceID)/proxy", credential: token)
            try await Self.connect(stream, target: target.text, credential: nil)
            return stream
        } catch { await stream.close(); throw error }
    }

    public func artifactConnection(head: BrowserHTTPHead, artifactID: String, version: Int) async throws -> any BrowserStream {
        let request = try head.artifactRequest(artifactID: artifactID, version: version, credential: token)
        let stream = try await transport.browserConnection()
        do { try await stream.write(request.data); return stream }
        catch { await stream.close(); throw error }
    }

    private static func connect(_ stream: any BrowserStream, target: String, credential: String?) async throws {
        var head = "CONNECT \(target) HTTP/1.1\r\nHost: server.tailcat\r\n"
        if let credential { head += "Authorization: Bearer \(credential)\r\n" }
        try await stream.write(Data((head + "\r\n").utf8))
        let (response, rest) = try await BrowserRelay.head(stream)
        guard response.line.split(separator: " ").dropFirst().first == "200", rest.isEmpty else {
            throw BrowserError.upstream(Int(response.line.split(separator: " ").dropFirst().first ?? "") ?? 502)
        }
    }
}

public enum BrowserRelay {
    /// Buffer only bounded requests (the artifact API's 1 MiB contract). Convert
    /// chunked uploads to one exact length so no trailer or pipelined request can
    /// enter the authenticated daemon connection.
    public static func requestBody(_ head: BrowserHTTPHead, initial: Data, stream: any BrowserStream) async throws -> (BrowserHTTPHead, Data) {
        let lengths = head.fields.filter { $0.0.lowercased() == "content-length" }
        let transfers = head.fields.filter { $0.0.lowercased() == "transfer-encoding" }
        guard lengths.count <= 1, transfers.count <= 1, lengths.isEmpty || transfers.isEmpty else { throw BrowserError.malformed }
        var body = Data()
        if let transfer = transfers.first {
            guard transfer.1.lowercased() == "chunked" else { throw BrowserError.malformed }
            var decoder = HTTP1BodyDecoder(chunked: true)
            var bytes = initial
            var received = 0
            while true {
                received += bytes.count
                guard received <= 1_114_112 else { throw BrowserError.tooLarge }
                body.append(try decoder.append(bytes))
                guard body.count <= 1_048_576 else { throw BrowserError.tooLarge }
                if decoder.finished { break }
                bytes = try await stream.read(maximumBytes: 65536)
                guard !bytes.isEmpty else { throw BrowserError.malformed }
            }
        } else {
            guard let length = Int(lengths.first?.1 ?? "0"), (0...1_048_576).contains(length), initial.count <= length else { throw BrowserError.tooLarge }
            body = initial
            while body.count < length {
                let bytes = try await stream.read(maximumBytes: min(65536, length - body.count))
                guard !bytes.isEmpty, bytes.count <= length - body.count else { throw BrowserError.malformed }
                body.append(bytes)
            }
        }
        var request = head
        request.fields.removeAll { ["content-length", "transfer-encoding", "trailer"].contains($0.0.lowercased()) }
        request.fields.append(("Content-Length", String(body.count)))
        return (request, body)
    }

    public static func head(_ stream: any BrowserStream) async throws -> (BrowserHTTPHead, Data) {
        try await withThrowingTaskGroup(of: (BrowserHTTPHead, Data).self) { group in
            group.addTask {
                var buffer = Data()
                while true {
                    try Task.checkCancellation()
                    let bytes = try await stream.read(maximumBytes: 65536)
                    guard !bytes.isEmpty else { throw BrowserError.unavailable }
                    buffer.append(bytes)
                    if let head = try BrowserHTTPHead.parse(buffer) { return head }
                }
            }
            group.addTask { try await Task.sleep(for: .seconds(35)); await stream.close(); throw BrowserError.unavailable }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }

    public static func pipe(_ source: any BrowserStream, to destination: any BrowserStream) async throws {
        while true {
            try Task.checkCancellation()
            let bytes = try await source.read(maximumBytes: 65536)
            if bytes.isEmpty { return }
            try await destination.write(bytes)
        }
    }

    public static func duplex(_ first: any BrowserStream, _ second: any BrowserStream) async throws {
        try await withTaskCancellationHandler {
            try await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask { try await pipe(first, to: second) }
                group.addTask { try await pipe(second, to: first) }
                defer { group.cancelAll() }
                do { _ = try await group.next() }
                catch { await first.close(); await second.close(); throw error }
                await first.close(); await second.close()
            }
        } onCancel: { Task { await first.close(); await second.close() } }
    }
}