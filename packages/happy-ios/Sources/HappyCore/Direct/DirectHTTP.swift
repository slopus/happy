import Foundation
import HappyWire
import Tailcat

public struct DirectHTTPResponse: Sendable {
    public let status: Int
    public let headers: [String: String]
    public let body: Data
    public init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
        self.status = status; self.headers = headers; self.body = body
    }
}

public protocol DirectTransport: Sendable {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> DirectHTTPResponse
    func close() async
}

extension DirectTransport {
    func request(_ path: String, credential: String, method: String = "GET", body: Data? = nil, headers: [String: String] = [:]) async throws -> DirectHTTPResponse {
        try await request(method: method, path: path, credential: credential, body: body, headers: headers)
    }
}

/// One private tunnel per instance; each HTTP request owns a fresh TCP stream.
/// `server.tailcat` is a logical authority, never a DNS lookup.
public actor TailcatHTTPTransport: DirectTransport {
    private let address: String
    private let port: UInt16
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

    private func connection() async throws -> TailcatClient {
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

    public func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> DirectHTTPResponse {
        guard ["GET", "POST"].contains(method), path.hasPrefix("/"),
              !path.contains("\r"), !path.contains("\n"), !path.contains(" "),
              !credential.contains("\r"), !credential.contains("\n"),
              headers.allSatisfy({ !$0.key.contains("\r") && !$0.key.contains("\n") && !$0.key.contains(":") && !$0.value.contains("\r") && !$0.value.contains("\n") }) else { throw DirectPairingError.invalidResponse }
        let client = try await connection()
        let port = port
        return try await withThrowingTaskGroup(of: DirectHTTPResponse.self) { group in
            group.addTask {
                let stream = try await client.openTCP(port: port)
                return try await withTaskCancellationHandler {
                    do {
                        var head = "\(method) \(path) HTTP/1.1\r\nHost: server.tailcat:\(port)\r\nAuthorization: Bearer \(credential)\r\nConnection: close\r\nAccept: application/json\r\nContent-Length: \(body?.count ?? 0)\r\n"
                        if body != nil { head += "Content-Type: application/json\r\n" }
                        for (name, value) in headers { head += "\(name): \(value)\r\n" }
                        try await stream.write(Data((head + "\r\n").utf8) + (body ?? Data()))
                        var parser = DirectHTTPParser()
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
            group.addTask { try await Task.sleep(for: .seconds(35)); throw DirectPairingError.unavailable }
            defer { group.cancelAll() }
            guard let response = try await group.next() else { throw DirectPairingError.unavailable }
            return response
        }
    }
}

/// Incremental HTTP/1.1 decoding with strict framing and bounded metadata.
/// Handles arbitrary TCP boundaries, length, chunked and close-delimited bodies.
struct DirectHTTPParser {
    private var data = Data()
    private let limit = 8 * 1024 * 1024

    mutating func append(_ bytes: Data, eof: Bool) throws -> DirectHTTPResponse? {
        guard data.count + bytes.count <= limit + 65536 else { throw DirectPairingError.invalidResponse }
        data.append(bytes)
        guard let divider = data.range(of: Data("\r\n\r\n".utf8)) else {
            guard data.count <= 32768, !eof else { throw DirectPairingError.invalidResponse }; return nil
        }
        guard divider.lowerBound <= 32768,
              let head = String(data: data[..<divider.lowerBound], encoding: .utf8) else { throw DirectPairingError.invalidResponse }
        let lines = head.components(separatedBy: "\r\n")
        let statusParts = (lines.first ?? "").split(separator: " ")
        guard statusParts.count >= 2, ["HTTP/1.1", "HTTP/1.0"].contains(String(statusParts[0])), let status = Int(statusParts[1]), (200...599).contains(status) else { throw DirectPairingError.invalidResponse }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { throw DirectPairingError.invalidResponse }
            let name = line[..<colon].lowercased()
            guard !name.isEmpty, headers[name] == nil else { throw DirectPairingError.invalidResponse }
            headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let body = Data(data[divider.upperBound...])
        if status == 204 || status == 304 { return DirectHTTPResponse(status: status, headers: headers) }
        if let transfer = headers["transfer-encoding"] {
            guard transfer.lowercased() == "chunked", headers["content-length"] == nil else { throw DirectPairingError.invalidResponse }
            var cursor = 0; var decoded = Data(); var chunks = 0
            while true {
                guard let lineEnd = body.range(of: Data("\r\n".utf8), in: cursor..<body.count) else {
                    guard body.count - cursor < 8192, !eof else { throw DirectPairingError.invalidResponse }; return nil
                }
                guard lineEnd.lowerBound - cursor < 8192,
                      let text = String(data: body[cursor..<lineEnd.lowerBound], encoding: .utf8),
                      let countText = text.split(separator: ";", maxSplits: 1).first,
                      let count = Int(countText, radix: 16), count >= 0, count <= limit - decoded.count else { throw DirectPairingError.invalidResponse }
                cursor = lineEnd.upperBound; chunks += 1
                guard chunks <= 65536 else { throw DirectPairingError.invalidResponse }
                if count == 0 {
                    // No trailers, or bounded trailers terminated by a blank line.
                    if body.count >= cursor + 2, body[cursor..<cursor + 2] == Data("\r\n".utf8) { return DirectHTTPResponse(status: status, headers: headers, body: decoded) }
                    if let end = body.range(of: Data("\r\n\r\n".utf8), in: cursor..<body.count), end.upperBound - cursor <= 32768 { return DirectHTTPResponse(status: status, headers: headers, body: decoded) }
                    guard body.count - cursor <= 32768, !eof else { throw DirectPairingError.invalidResponse }; return nil
                }
                guard body.count >= cursor + count + 2 else { if eof { throw DirectPairingError.invalidResponse }; return nil }
                guard body[cursor + count..<cursor + count + 2] == Data("\r\n".utf8) else { throw DirectPairingError.invalidResponse }
                decoded.append(body[cursor..<cursor + count]); cursor += count + 2
            }
        }
        if let length = headers["content-length"] {
            guard let count = Int(length), count >= 0, count <= limit else { throw DirectPairingError.invalidResponse }
            if body.count >= count { return DirectHTTPResponse(status: status, headers: headers, body: Data(body.prefix(count))) }
            if eof { throw DirectPairingError.invalidResponse }; return nil
        }
        guard body.count <= limit else { throw DirectPairingError.invalidResponse }
        return eof ? DirectHTTPResponse(status: status, headers: headers, body: body) : nil
    }
}