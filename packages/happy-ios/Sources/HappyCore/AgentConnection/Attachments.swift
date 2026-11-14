import Foundation
import HappyCrypto
import HappyWire

extension AgentWire {
    /// A file a person attached to their message (happy-agent `API.md`,
    /// "Attachments"): it names the conversation's attachment and says what
    /// it is; its bytes are `GET /v0/agents/:agentId/attachments/:id`.
    /// Happy Cloud may leave out `kind` and the image fields.
    public struct FileBlock: Equatable, Sendable, Codable {
        /// The lowercase hexadecimal SHA-256 of its bytes.
        public var attachment: String
        public var name: String
        public var mimeType: String?
        public var size: Double?
        public var kind: String?
        public var width: Double?
        public var height: Double?
        public var thumbhash: String?
        public var scale: Double?

        public init(attachment: String, name: String, mimeType: String? = nil, size: Double? = nil, kind: String? = nil,
                    width: Double? = nil, height: Double? = nil, thumbhash: String? = nil, scale: Double? = nil) {
            self.attachment = attachment; self.name = name; self.mimeType = mimeType; self.size = size; self.kind = kind
            self.width = width; self.height = height; self.thumbhash = thumbhash; self.scale = scale
        }

        /// Shown as a tool's media item is; an unknown kind is a file.
        public var item: MediaItem {
            MediaItem(kind: ["image", "video", "document"].contains(kind ?? "") ? kind! : "file", name: name, mimeType: mimeType ?? "application/octet-stream",
                      size: size, width: width, height: height, thumbhash: thumbhash, scale: scale, source: nil)
        }
    }
}

/// Uploading to a conversation's attachments: a file named by its hash, in
/// one request when it is small and in chunks that resume from what the
/// computer holds when it is not.
public enum Attachments {
    /// The most bytes one request carries; a file this size or smaller goes whole.
    public static let chunk = 8 * 1024 * 1024
    /// Requests in a row that move nothing before an upload gives up; the
    /// outbox tries the message again later, from what the computer kept.
    static let attempts = 5
    /// How long a computer that has no attachments route is taken at its word.
    static let recheck: Duration = .seconds(600)

    /// An attachment's ID: the lowercase hexadecimal SHA-256 of its bytes.
    public static func id(_ bytes: Data) -> String {
        Hashing.sha256(bytes).map { String(format: "%02x", $0) }.joined()
    }

    /// The next bytes to send of a file of `size`, `received` (inclusive
    /// ranges, in order) already there: from the first missing byte up to
    /// the next received range, at most `chunk` of them. Nil once all are there.
    static func next(_ received: [ClosedRange<Int>], size: Int, chunk: Int = chunk) -> Range<Int>? {
        var start = 0
        for range in received.sorted(by: { $0.lowerBound < $1.lowerBound }) {
            if range.lowerBound > start { return start..<min(range.lowerBound, start + chunk, size) }
            start = max(start, range.upperBound + 1)
        }
        return start < size ? start..<min(size, start + chunk) : nil
    }

    static func count(_ received: [ClosedRange<Int>]) -> Int { received.reduce(0) { $0 + $1.count } }

    /// The caption `send` needs when a person sent files without words.
    static func caption(images: Int, files: Int) -> String {
        files == 0 ? (images == 1 ? "Attached image." : "Attached images.") : (images + files == 1 ? "Attached file." : "Attached files.")
    }
}

/// The computer has no attachments route (happy-agent older than
/// 2026.11.6-preview.4, a server without them): its messages carry
/// pictures inline instead.
struct AttachmentsUnsupported: Error {}

/// Whether the computer was found without attachments lately.
public final class AttachmentSupport: @unchecked Sendable {
    private let lock = NSLock()
    private var missingSince: ContinuousClock.Instant?

    public init() {}

    /// Worth an attempt: not found missing, or found long enough ago that it may have been updated.
    var worthTrying: Bool { lock.withLock { missingSince.map { .now - $0 >= Attachments.recheck } ?? true } }
    func missing() { lock.withLock { missingSince = .now } }
}

extension AgentClient {
    /// Uploads `bytes` to `agentId`'s conversation as attachment `id`
    /// (`PUT /v0/agents/:agentId/attachments/:id`). A file of up to
    /// `chunk` goes whole; a larger one asks first what the
    /// computer holds (all of it once already uploaded) and sends the first
    /// missing range until it has all. A broken request, a `5xx` or a chunk
    /// the computer didn't keep is asked about again after `retryDelay`,
    /// doubling. `progress` hears the share of the file there.
    /// Throws `AttachmentsUnsupported` on a `404`, `405` or `501` before any answer.
    func attach(_ agentId: String, id: String, bytes: Data, name: String, mimeType: String, chunk: Int = Attachments.chunk, retryDelay: Duration = .seconds(1),
                progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws {
        struct Answer: Decodable {
            struct Attachment: Decodable { let id: String }
            struct Upload: Decodable {
                struct Range: Decodable { let start: Int; let end: Int }
                let received: [Range]
            }
            let attachment: Attachment?
            let upload: Upload?
        }
        let path = "/v0/agents/\(Self.escape(agentId))/attachments/\(id)?name=\(Self.escape(name))"
        let size = bytes.count
        let whole = size <= chunk
        // Nil until the computer has said what it holds.
        var held: [ClosedRange<Int>]?
        var answered = false
        var restarted = false
        var failures = 0
        var most = 0
        while true {
            try Task.checkCancellation()
            var headers = ["Content-Type": mimeType]
            var body = Data()
            let done = held.map(Attachments.count) ?? 0
            if let held {
                guard let range = Attachments.next(held, size: size, chunk: chunk) else { throw AgentClientError.invalidResponse }
                headers["Content-Range"] = "bytes \(range.lowerBound)-\(range.upperBound - 1)/\(size)"
                body = bytes.subdata(in: range)
            } else if whole {
                body = bytes
            } else {
                headers["Content-Range"] = "bytes */\(size)"
            }
            do {
                let response = try await send("PUT", path, raw: body, headers: headers, category: .file) { sent in
                    progress(Double(done + sent) / Double(max(1, size)))
                }
                answered = true
                guard let answer = try? JSONDecoder().decode(Answer.self, from: response.body) else { throw AgentClientError.invalidResponse }
                if let attachment = answer.attachment {
                    guard attachment.id == id else { throw AgentClientError.invalidResponse }
                    progress(1)
                    return
                }
                guard let upload = answer.upload else { throw AgentClientError.invalidResponse }
                let now = upload.received.compactMap { $0.start <= $0.end ? $0.start...$0.end : nil }
                progress(Double(Attachments.count(now)) / Double(max(1, size)))
                // Bytes sent that the computer didn't keep count as a failure;
                // only more held than ever before starts the count again.
                if Attachments.count(now) > most { most = Attachments.count(now); failures = 0 } else if !body.isEmpty { failures += 1 }
                guard failures < Attachments.attempts else { throw AgentClientError.invalidResponse }
                held = now
            } catch AgentClientError.status(let status, _, _) where !answered && [404, 405, 501].contains(status) {
                attachmentSupport.missing()
                throw AttachmentsUnsupported()
            } catch AgentClientError.status(400, "invalid_request"?, _) where held != nil && !restarted {
                // Past the requests one upload takes: cancelled, started again.
                restarted = true
                _ = try? await send("DELETE", "/v0/agents/\(Self.escape(agentId))/attachments/\(id)")
                held = nil
            } catch let error as AgentClientError where error.status.map({ (400..<500).contains($0) && ![404, 408, 429].contains($0) }) == true || error == .revoked {
                throw error
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                failures += 1
                guard failures < Attachments.attempts else { throw error }
                try await Task.sleep(for: retryDelay * (1 << (failures - 1)))
                // What arrived of a broken chunk isn't kept: asked again.
                held = nil
            }
        }
    }

    /// An attachment's bytes, whole or one range of them.
    public func attachment(_ agentId: String, id: String, range: ClosedRange<Int>? = nil) async throws -> HTTP1Response {
        let headers = range.map { ["Range": "bytes=\($0.lowerBound)-\($0.upperBound)"] } ?? [:]
        return try await send("GET", "/v0/agents/\(Self.escape(agentId))/attachments/\(Self.escape(id))", headers: headers, category: .file)
    }

    /// `deliverMessage` over attachments: each picture and file uploaded,
    /// then one send naming them all. The bytes are kept in `media` as
    /// the attachment's own, so the sender never reads them back.
    func deliverAttached(_ message: QueuedMessage, pictureKeys: [String], fileKeys: [String], board: UploadProgressBoard, media: MediaStore?,
                         retryDelay: Duration) async throws {
        guard let mode = message.mode else { throw AgentClientError.invalidResponse }
        var blocks: [JSONValue] = []
        func attached(_ bytes: Data, name: String, mimeType: String, key: String) async throws {
            try Task.checkCancellation()
            let id = Attachments.id(bytes)
            try await attach(message.agentID, id: id, bytes: bytes, name: name, mimeType: mimeType, retryDelay: retryDelay) { board.set(key, .uploading($0)) }
            board.set(key, .done)
            try? media?.keep(Media.attachmentResource(agentId: message.agentID, id: id), data: bytes)
            blocks.append(.object(["type": .string("file"), "attachment": .string(id), "name": .string(name)]))
        }
        for (index, picture) in message.pictures.enumerated() {
            let ext = ["image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/heic": "heic"][picture.mimeType] ?? "bin"
            try await attached(picture.data, name: "image-\(index + 1).\(ext)", mimeType: picture.mimeType, key: pictureKeys[index])
        }
        for (index, file) in (message.files ?? []).enumerated() {
            let bytes = try Data(contentsOf: file.fileURL, options: .mappedIfSafe)
            guard bytes.count == file.size else { throw AttachmentRules.invalid("The queued attachment is unavailable or its size changed.") }
            try await attached(bytes, name: AttachmentRules.safeName(file.name), mimeType: file.mimeType, key: fileKeys[index])
        }
        try Task.checkCancellation()
        let caption = message.text.isEmpty ? Attachments.caption(images: message.pictures.count, files: message.files?.count ?? 0) : message.text
        try await sendMessage(message.agentID, id: message.id, text: caption, images: [], files: blocks, toolRequest: message.toolRequest, mode: mode)
    }
}
