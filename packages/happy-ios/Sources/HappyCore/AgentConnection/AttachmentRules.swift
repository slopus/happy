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
    /// A picture's or video's size, so its tile has its shape before it is read.
    public var width: Int?
    public var height: Int?

    public init(fileURL: URL, name: String, mimeType: String, size: Int, path: String, uploaded: Bool = false, width: Int? = nil, height: Int? = nil) {
        self.fileURL = fileURL; self.name = name; self.mimeType = mimeType
        self.size = size; self.path = path; self.uploaded = uploaded
        self.width = width; self.height = height
    }
}

public enum AttachmentRules {
    public static let maxFileBytes = 50 * 1024 * 1024
    public static let maxInlineImageBytes = 5 * 1024 * 1024
    public static let maxInlineImageTotalBytes = 29 * 1024 * 1024
    /// Keeps the uploads folder out of git: written before a workspace's
    /// first upload (`AgentClient.keepUploadsOutOfGit`).
    static let ignorePath = ".happy-uploads/.gitignore"
    static let ignoreContent = "*"

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
                    size: size, path: ".happy-uploads/\(messageID)/\(filename)", width: attachment.width, height: attachment.height)
            }
        } catch {
            for file in copied { try? FileManager.default.removeItem(at: file) }
            throw error
        }
    }

    static func invalid(_ message: String) -> AgentClientError {
        .status(400, code: "invalid_attachment", message: message)
    }

    /// Pictures go to the agent as files it opens by path, never as image
    /// blocks: it decides what to look at, and a picture it never needs
    /// costs it nothing. Each is written under the message's folder.
    static func pictureFiles(_ pictures: [QueuedMessage.Picture], messageID: String, directory: URL) throws -> [QueuedFile] {
        guard !pictures.isEmpty else { return [] }
        let group = directory.appendingPathComponent(messageID, isDirectory: true)
        try FileManager.default.createDirectory(at: group, withIntermediateDirectories: true)
        return try pictures.enumerated().map { index, picture in
            guard picture.data.count <= maxFileBytes else { throw invalid("An image exceeds the 50 MB file limit.") }
            let ext = ["image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"][picture.mimeType] ?? "bin"
            let name = "image-\(index).\(ext)"
            let file = group.appendingPathComponent(name)
            try picture.data.write(to: file, options: .atomic)
            return QueuedFile(fileURL: file, name: name, mimeType: picture.mimeType, size: picture.data.count,
                path: ".happy-uploads/\(messageID)/\(name)")
        }
    }

    /// Older versions persisted pictures to send inline; they go as files too.
    static func migratePictures(_ queued: QueuedMessage, directory: URL) throws -> QueuedMessage {
        guard !queued.pictures.isEmpty else { return queued }
        var message = queued
        message.files = (queued.files ?? []) + (try pictureFiles(queued.pictures, messageID: queued.id, directory: directory))
        message.pictures = []
        return message
    }

    /// The message's words, then where its files are, in the words every
    /// Happy client gives the agent (happy-cli's `formatAttachmentNote`),
    /// with paths relative to the agent's workspace.
    static func text(_ text: String, files: [QueuedFile]) -> String {
        guard !files.isEmpty else { return text }
        let one = files.count == 1
        let noun = files.allSatisfy({ $0.mimeType.hasPrefix("image/") }) ? "image" : "file"
        let count = one ? "1 \(noun)" : "\(files.count) \(noun)s"
        let object = one ? "it" : "them"
        let heading = "The user attached \(count). \(one ? "It was" : "They were") saved on this machine and not loaded into your context; open \(object) with your file-reading or image-viewing tool only if you need to see \(object):"
        let paths = files.map { "- ./\($0.path)" }.joined(separator: "\n")
        return (text.isEmpty ? "" : text + "\n\n") + heading + "\n" + paths
    }
}

extension AgentClient {
    /// Sequential uploads keep only one file's encoded request in memory.
    /// Progress is durable before moving to the next file or sending the text.
    /// Each picture's and file's bytes as they go out are on `board`, by
    /// the piece's key: waiting its turn, then how much is written.
    public func deliverMessage(_ queued: QueuedMessage, board: UploadProgressBoard = .shared,
        persist: @Sendable (QueuedMessage) async throws -> Void) async throws {
        var message = queued
        let pictureKeys = message.pictures.indices.map { UploadProgressBoard.pictureKey(message.id, $0) }
        let fileKeys = (message.files ?? []).indices.map { UploadProgressBoard.fileKey(message.id, $0) }
        for (key, file) in zip(fileKeys, message.files ?? []) { board.set(key, file.uploaded ? .done : .preparing) }
        for key in pictureKeys { board.set(key, .preparing) }
        do {
            if !(message.files ?? []).isEmpty {
                if message.workspaceID == nil {
                    message.workspaceID = try await agent(message.agentID).workspaceId
                    try await persist(message)
                }
                guard let workspace = message.workspaceID else { throw AgentClientError.invalidResponse }
                if (message.files ?? []).contains(where: { !$0.uploaded }) { await keepUploadsOutOfGit(workspace) }
                for index in (message.files ?? []).indices {
                    try Task.checkCancellation()
                    guard let file = message.files?[index], !file.uploaded else { continue }
                    let key = fileKeys[index]
                    try await uploadFile(file, workspaceID: workspace) { board.set(key, .uploading($0)) }
                    board.set(key, .done)
                    message.files?[index].uploaded = true
                    try await persist(message)
                }
            }
            guard let mode = message.mode else { throw AgentClientError.invalidResponse }
            try Task.checkCancellation()
            let images: [(mimeType: String, data: Data)] = message.pictures.map { ($0.mimeType, $0.data) }
            var progress: (@Sendable ([Double]) -> Void)?
            if !pictureKeys.isEmpty {
                progress = { @Sendable (shares: [Double]) in
                    for (key, share) in zip(pictureKeys, shares) { board.set(key, UploadPhase.uploading(share)) }
                }
            }
            try await sendMessage(message.agentID, id: message.id,
                text: AttachmentRules.text(message.text, files: message.files ?? []),
                images: images, toolRequest: message.toolRequest, mode: mode, progress: progress)
            for key in pictureKeys { board.set(key, .done) }
        } catch {
            // To go again, now or once retried: what didn't finish starts over.
            for key in pictureKeys + fileKeys where board.phase(key) != .done { board.set(key, .preparing) }
            throw error
        }
    }

    /// `.happy-uploads/.gitignore` (`*`), written before the first upload
    /// into the workspace so what the phone puts there never shows as a
    /// change to commit. Already there (409) counts as written; any other
    /// failure is let go, never holding the upload up, and tried again
    /// before the next one.
    func keepUploadsOutOfGit(_ workspaceID: String) async {
        guard !ignoredUploads.contains(workspaceID) else { return }
        let body = JSONValue.object([
            "path": .string(AttachmentRules.ignorePath),
            "content": .string(Data(AttachmentRules.ignoreContent.utf8).base64EncodedString()),
            "expectedHash": .null,
        ])
        do {
            _ = try await send("PUT", "/v0/workspaces/\(Self.escape(workspaceID))/file", json: body)
        } catch AgentClientError.status(409, _, _) {
            // Already there: the person's own, left as it is.
        } catch {
            return
        }
        ignoredUploads.insert(workspaceID)
    }

    /// `progress` hears the share of the file's bytes written, once read
    /// and encoded.
    public func uploadFile(_ file: QueuedFile, workspaceID: String, progress: (@Sendable (Double) -> Void)? = nil) async throws {
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
        let content = bytes.base64EncodedString()
        let body = try encoder.encode(JSONValue.object([
            "path": .string(file.path), "content": .string(content), "expectedHash": .null,
        ]))
        let path = "/v0/workspaces/\(Self.escape(workspaceID))/file"
        let response: HTTP1Response
        if let progress {
            let range = UploadRanges(body: body, encoded: [content])
            progress(0)
            response = try await transport.send(method: "PUT", path: path, credential: token, body: body, upload: true) {
                progress(range.shares(sent: $0)[0])
            }
        } else {
            response = try await transport.upload(path: path, credential: token, body: body)
        }
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
