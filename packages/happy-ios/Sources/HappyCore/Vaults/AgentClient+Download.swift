import Foundation

extension AgentClient {
    /// GETs `path` into the file at `destination`, as the bytes arrive,
    /// over a browser connection of its own. An ordinary answer holds at
    /// most 8 MiB and a zip has no length to read it by in ranges, so a
    /// file or a zip of any size comes this way. `progress` hears the bytes
    /// written and the whole length when the answer gives one.
    public func download(_ path: String, to destination: URL, progress: @escaping @Sendable (_ written: Int, _ total: Int?) -> Void = { _, _ in }) async throws {
        let stream = try await transport.browserConnection()
        do {
            let credential = try await transport.bearer(token)
            let head = "GET \(path) HTTP/1.1\r\nHost: \(stream.authority)\r\nAuthorization: Bearer \(credential)\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n"
            try await stream.write(Data(head.utf8))
            let (response, initial) = try await BrowserRelay.head(stream)
            let status = Int(response.line.split(separator: " ").dropFirst().first ?? "") ?? 0
            if status == 401 { throw AgentClientError.revoked }
            guard status == 200 else {
                struct Failure: Decodable { let error: String?; let code: String? }
                var body = initial
                while body.count < 65536, let more = try? await stream.read(maximumBytes: 65536), !more.isEmpty { body.append(more) }
                let failure = try? JSONDecoder().decode(Failure.self, from: body)
                throw AgentClientError.status(status, code: failure?.code, message: failure?.error)
            }
            let chunked = response.value("transfer-encoding")?.lowercased() == "chunked"
            let length = chunked ? nil : response.value("content-length").flatMap { Int($0) }
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            guard FileManager.default.createFile(atPath: destination.path, contents: nil) else { throw CocoaError(.fileWriteUnknown) }
            let handle = try FileHandle(forWritingTo: destination)
            defer { try? handle.close() }
            var decoder = HTTP1BodyDecoder(chunked: chunked)
            var written = 0
            var bytes = initial
            while true {
                try Task.checkCancellation()
                var piece = try decoder.append(bytes)
                if let length, written + piece.count > length { piece = piece.prefix(length - written) }
                if !piece.isEmpty {
                    try handle.write(contentsOf: piece)
                    written += piece.count
                    progress(written, length)
                }
                if chunked ? decoder.finished : length.map({ written >= $0 }) ?? false { break }
                bytes = try await stream.read(maximumBytes: 262_144)
                if bytes.isEmpty {
                    // Only a close-delimited body may end with the connection.
                    guard !chunked, length == nil else { throw AgentClientError.invalidResponse }
                    break
                }
            }
            await stream.close()
        } catch {
            await stream.close()
            try? FileManager.default.removeItem(at: destination)
            throw error
        }
    }
}
