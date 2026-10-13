import Foundation
import HappyWire

public struct AttachmentUpload: Codable, Sendable {
    public var ref: String
    public var uploadUrl: String
    public var method: String
    public var formFields: [String: String]?
}

extension HappyAPI {
    public func requestAttachmentUpload(sessionId: String, filename: String, size: Int) async throws -> AttachmentUpload {
        let body = try JSONValue.object(["filename": .string(filename), "size": .number(Double(size))]).encoded()
        let request = try makeRequest("POST", "/v1/sessions/\(Self.escape(sessionId))/attachments/request-upload", body: body)
        let response = try await transport.send(request)
        try validateAttachmentResponse(response)
        var upload = try JSONDecoder().decode(AttachmentUpload.self, from: response.body)
        // Local servers may advertise localhost; mirror serverConfig's rewrite.
        upload.uploadUrl = rewriteLoopbackHost(upload.uploadUrl)
        return upload
    }

    public func uploadEncryptedBlob(_ data: Data, upload: AttachmentUpload) async throws {
        guard let url = URL(string: upload.uploadUrl), ["https", "http"].contains(url.scheme ?? "") else {
            throw APIError.decoding("invalid upload URL")
        }
        var headers: [String: String] = [:]
        let body: Data
        if upload.method == "POST" {
            let boundary = "Happy-\(UUID().uuidString)"
            headers["Content-Type"] = "multipart/form-data; boundary=\(boundary)"
            var multipart = Data()
            for (key, value) in (upload.formFields ?? [:]).sorted(by: { $0.key < $1.key }) {
                // Header values must never inject another multipart header.
                guard !key.contains("\r"), !key.contains("\n"), !key.contains("\"") else {
                    throw APIError.decoding("invalid form field")
                }
                multipart.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(key)\"\r\n\r\n\(value)\r\n".utf8))
            }
            multipart.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"blob\"\r\nContent-Type: application/octet-stream\r\n\r\n".utf8))
            multipart.append(data)
            multipart.append(Data("\r\n--\(boundary)--\r\n".utf8))
            body = multipart
        } else if upload.method == "PUT" {
            headers["Content-Type"] = "application/octet-stream"
            if isAttachmentServerURL(url), let token {
                headers["Authorization"] = "Bearer \(token)"
            }
            body = data
        } else {
            throw APIError.decoding("unsupported upload method")
        }
        try validateAttachmentResponse(try await transport.send(HTTPRequest(method: upload.method, url: url, headers: headers, body: body)))
    }

    private func isAttachmentServerURL(_ url: URL) -> Bool {
        // Compare the origin and path boundary; a presigned third-party URL never gets the token.
        let base = serverURL.path.hasSuffix("/") ? String(serverURL.path.dropLast()) : serverURL.path
        return url.scheme == serverURL.scheme && url.host == serverURL.host && url.port == serverURL.port
            && (base.isEmpty || url.path == base || url.path.hasPrefix(base + "/"))
    }

    private func rewriteLoopbackHost(_ raw: String) -> String {
        guard var components = URLComponents(string: raw),
              ["localhost", "127.0.0.1", "::1", "[::1]"].contains(components.host ?? "") else {
            return raw
        }
        components.scheme = serverURL.scheme
        components.host = serverURL.host
        components.port = serverURL.port
        return components.string ?? raw
    }

    public func downloadEncryptedAttachment(sessionId: String, ref: String) async throws -> Data {
        let request = try makeRequest("POST", "/v1/sessions/\(Self.escape(sessionId))/attachments/request-download", body: JSONValue.object(["ref": .string(ref)]).encoded())
        let response = try await transport.send(request)
        try validateAttachmentResponse(response)
        let value = try JSONValue.decode(response.body)
        guard let raw = value["downloadUrl"]?.stringValue, let url = URL(string: rewriteLoopbackHost(raw), relativeTo: serverURL)?.absoluteURL,
              ["http", "https"].contains(url.scheme ?? "") else {
            throw APIError.decoding("invalid download URL")
        }
        var headers: [String: String] = [:]
        if isAttachmentServerURL(url), let token {
            headers["Authorization"] = "Bearer \(token)"
        }
        let blob = try await transport.send(HTTPRequest(method: "GET", url: url, headers: headers))
        try validateAttachmentResponse(blob)
        return blob.body
    }

    private func validateAttachmentResponse(_ response: HTTPResponse) throws {
        guard (200..<300).contains(response.status) else {
            if response.status == 401 {
                throw APIError.unauthorized
            }
            throw APIError.http(status: response.status, body: String(decoding: response.body.prefix(512), as: UTF8.self))
        }
    }
}
