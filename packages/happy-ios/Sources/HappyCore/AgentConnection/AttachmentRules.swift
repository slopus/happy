import Foundation
import HappyCrypto
import HappyWire

/// A queue-owned local copy. The chosen remote path survives process death and
/// a lost upload acknowledgement; a retry never overwrites another file.
public struct QueuedFile: Codable, Equatable, Sendable {
    public var fileURL: URL
    public var name: String
    public var mimeType: String
    public var size: Int
    public var path: String
    public var uploaded: Bool

    public init(fileURL: URL, name: String, mimeType: String, size: Int, path: String, uploaded: Bool = false) {
        self.fileURL = fileURL; self.name = name; self.mimeType = mimeType
        self.size = size; self.path = path; self.uploaded = uploaded
    }
}

public enum AttachmentRules {
    public static let maxFileBytes = 50 * 1024 * 1024
    public static let maxInlineImageBytes = 5 * 1024 * 1024
    public static let maxInlineImageTotalBytes = 29 * 1024 * 1024

    public static func safeName(_ name: String) -> String {
        let basename = name.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init) ?? ""
        let portable = String(basename.map { "<>:\"|?*".contains($0) ? Character("_") : $0 })
        let edgeCharacters = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "."))
        let clean = String(String.UnicodeScalarView(portable.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }))
            .trimmingCharacters(in: edgeCharacters)
        var bounded = ""
        for character in clean {
            guard bounded.utf8.count + String(character).utf8.count <= 120 else { break }
            bounded.append(character)
        }
        let leaf = bounded.trimmingCharacters(in: edgeCharacters)
        return leaf.isEmpty ? "attachment" : leaf
    }

    /// Copies all bytes before the composer can discard its temporary picks.
    public static func stage(_ attachments: [OutgoingAttachment], messageID: String, directory: URL) throws -> [QueuedFile] {
        guard !attachments.isEmpty else { return [] }
        guard !messageID.isEmpty, messageID.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }) else {
            throw invalid("Invalid attachment message identity.")
        }
        let group = directory.appendingPathComponent(messageID, isDirectory: true)
        var copied: [URL] = []
        do {
            try FileManager.default.createDirectory(at: group, withIntermediateDirectories: true)
            return try attachments.enumerated().map { index, attachment in
                let source = URL(fileURLWithPath: attachment.fileURL.path)
                let values = try source.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
                guard values.isRegularFile == true, let size = values.fileSize, size <= maxFileBytes else {
                    throw invalid("An attachment exceeds the 50 MB file limit or cannot be read.")
                }
                let filename = "\(index)-\(safeName(attachment.name))"
                let destination = group.appendingPathComponent(filename)
                // Each send has a fresh ID. A pre-existing local target is never replaced.
                try FileManager.default.copyItem(at: source, to: destination)
                copied.append(destination)
                let actual = try FileManager.default.attributesOfItem(atPath: destination.path)[.size] as? NSNumber
                guard actual?.intValue == size else { throw invalid("The attachment changed while being copied.") }
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
                return QueuedFile(fileURL: destination, name: attachment.name, mimeType: attachment.mimeType,
                    size: size, path: ".happy-uploads/\(messageID)/\(filename)")
            }
        } catch {
            for file in copied { try? FileManager.default.removeItem(at: file) }
            throw error
        }
    }

    static func invalid(_ message: String) -> AgentClientError {
        .status(400, code: "invalid_attachment", message: message)
    }

    /// Older versions persisted images up to the relay limit. Keep those
    /// sends deliverable by moving images beyond model limits to file uploads.
    static func migratePictures(_ queued: QueuedMessage, directory: URL) throws -> QueuedMessage {
        var message = queued
        var inline: [QueuedMessage.Picture] = []
        var total = 0
        for (index, picture) in queued.pictures.enumerated() {
            if picture.data.count <= maxInlineImageBytes, total + picture.data.count <= maxInlineImageTotalBytes {
                inline.append(picture); total += picture.data.count
                continue
            }
            guard picture.data.count <= maxFileBytes else { throw invalid("An image exceeds the 50 MB file limit.") }
            let ext = ["image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"][picture.mimeType] ?? "bin"
            let name = "image-\(index).\(ext)"
            let group = directory.appendingPathComponent(queued.id, isDirectory: true)
            try FileManager.default.createDirectory(at: group, withIntermediateDirectories: true)
            let file = group.appendingPathComponent(name)
            try picture.data.write(to: file, options: .atomic)
            var files = message.files ?? []
            files.append(QueuedFile(fileURL: file, name: name, mimeType: picture.mimeType, size: picture.data.count,
                path: ".happy-uploads/\(queued.id)/\(name)"))
            message.files = files
        }
        message.pictures = inline
        return message
    }

    static func text(_ text: String, files: [QueuedFile]) -> String {
        guard !files.isEmpty else { return text }
        let heading = files.count == 1 ? "Attached file:" : "Attached files:"
        let paths = files.map { "- ./\($0.path)" }.joined(separator: "\n")
        return (text.isEmpty ? "" : text + "\n\n") + heading + "\n" + paths
    }
}

extension AgentClient {
    /// Sequential uploads keep only one file's encoded request in memory.
    /// Progress is durable before moving to the next file or sending the text.
    public func deliverMessage(_ queued: QueuedMessage,
        persist: @Sendable (QueuedMessage) async throws -> Void) async throws {
        var message = queued
        if !(message.files ?? []).isEmpty {
            if message.workspaceID == nil {
                message.workspaceID = try await agent(message.agentID).workspaceId
                try await persist(message)
            }
            guard let workspace = message.workspaceID else { throw AgentClientError.invalidResponse }
            for index in (message.files ?? []).indices {
                try Task.checkCancellation()
                guard let file = message.files?[index], !file.uploaded else { continue }
                try await uploadFile(file, workspaceID: workspace)
                message.files?[index].uploaded = true
                try await persist(message)
            }
        }
        guard let mode = message.mode else { throw AgentClientError.invalidResponse }
        try Task.checkCancellation()
        try await sendMessage(message.agentID, id: message.id,
            text: AttachmentRules.text(message.text, files: message.files ?? []),
            images: message.pictures.map { ($0.mimeType, $0.data) }, mode: mode)
    }

    public func uploadFile(_ file: QueuedFile, workspaceID: String) async throws {
        let values = try URL(fileURLWithPath: file.fileURL.path).resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard values.isRegularFile == true, values.fileSize == file.size, file.size <= AttachmentRules.maxFileBytes else {
            throw AttachmentRules.invalid("The queued attachment is unavailable or its size changed.")
        }
        let bytes = try Data(contentsOf: file.fileURL, options: .mappedIfSafe)
        guard bytes.count == file.size else { throw AttachmentRules.invalid("The queued attachment changed.") }
        let hash = Hashing.sha256(bytes).map { String(format: "%02x", $0) }.joined()
        let encoder = JSONEncoder()
        // Slash-heavy base64 must keep the ordinary 4/3 expansion. Default
        // JSON slash escaping can double an otherwise valid 50 MiB request.
        encoder.outputFormatting = [.withoutEscapingSlashes]
        let response = try await transport.upload(path: "/v0/workspaces/\(Self.escape(workspaceID))/file",
            credential: token, body: encoder.encode(JSONValue.object([
                "path": .string(file.path), "content": .string(bytes.base64EncodedString()), "expectedHash": .null,
            ])))
        if response.status == 401 { throw AgentClientError.revoked }
        let result = try? JSONDecoder().decode(JSONValue.self, from: response.body)
        if response.status == 409, result?["code"]?.stringValue == "hash_mismatch", result?["hash"]?.stringValue == hash { return }
        guard (200..<300).contains(response.status) else {
            throw AgentClientError.status(response.status, code: result?["code"]?.stringValue,
                message: "The attachment could not be uploaded. Retry this message.")
        }
        guard result?["hash"]?.stringValue == hash else { throw AgentClientError.invalidResponse }
    }
}