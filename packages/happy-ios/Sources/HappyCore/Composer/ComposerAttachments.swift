import Foundation

/// useImagePicker.ts's limits and names.
public enum ComposerAttachmentRules {
    /// MAX_IMAGES_PER_MESSAGE.
    public static let maxImages = 20
    /// MAX_FILE_SIZE, the `maxMb` in fileTooLargeMessage.
    public static let maxFileSizeMegabytes = 10
    /// IOS_ATTACHMENT_MAX_FILE_SIZE: 10MB less encryptBlob's 24-byte nonce
    /// and 16-byte tag.
    public static let maxFileSize = maxFileSizeMegabytes * 1024 * 1024 - 40
    /// IOS_ATTACHMENT_JPEG_QUALITY.
    public static let jpegQuality = 0.92
    /// IOS_ATTACHMENT_MAX_DIMENSION.
    public static let maxDimension = 3072

    /// How many more may be picked; none means the limit alert.
    public static func remaining(selected: Int) -> Int {
        max(0, maxImages - selected)
    }

    /// The long edge to render at: Expo resizes only the long edge, and
    /// only past 3072, keeping the aspect. Zero for an unmeasured image.
    public static func longEdge(width: Int, height: Int) -> Int {
        min(max(0, width, height), maxDimension)
    }

    /// `withJpegExtension`: the picked name with a .jpg extension, or
    /// `image_<ms>.jpg`.
    public static func jpegName(_ fileName: String?, now: Date) -> String {
        let trimmed = fileName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let name = trimmed.isEmpty ? "image_\(milliseconds(now)).jpg" : trimmed
        // `lastIndexOf('.') > 0`: a leading dot is part of the stem.
        guard let dot = name.lastIndex(of: "."), dot > name.startIndex else { return "\(name).jpg" }
        return "\(name[..<dot]).jpg"
    }

    /// `pasted_<ms>.png`: what a pasted image is called before conversion.
    public static func pastedName(now: Date) -> String {
        "pasted_\(milliseconds(now)).png"
    }

    /// `${Date.now()}_${Math.random().toString(36).slice(2)}`.
    public static func previewId(now: Date, using generator: inout some RandomNumberGenerator) -> String {
        let digits = Array("0123456789abcdefghijklmnopqrstuvwxyz")
        let suffix = String((0..<11).map { _ in digits[Int.random(in: 0..<digits.count, using: &generator)] })
        return "\(milliseconds(now))_\(suffix)"
    }

    public static func previewId(now: Date = Date()) -> String {
        var generator = SystemRandomNumberGenerator()
        return previewId(now: now, using: &generator)
    }

    private static func milliseconds(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded(.down))
    }
}

/// Where picked images wait to be sent: a folder of their own in the
/// account's files directory. The selection lives no longer than the
/// composer that made it, as useImagePicker's state does, so the folder
/// goes with this object; folders left by an earlier launch go when the
/// next one is made. Sending copies the files into the outbox.
public final class ComposerAttachmentStaging: @unchecked Sendable {
    public let directory: URL
    private let root: URL

    private static let lock = NSLock()
    nonisolated(unsafe) private static var live: Set<String> = []

    public init(filesDirectory: URL) {
        root = filesDirectory.appendingPathComponent("composer", isDirectory: true)
        let name = UUID().uuidString
        directory = root.appendingPathComponent(name, isDirectory: true)
        let live = Self.lock.withLock {
            Self.live.insert(name)
            return Self.live
        }
        let manager = FileManager.default
        for orphan in (try? manager.contentsOfDirectory(atPath: root.path)) ?? [] where !live.contains(orphan) {
            try? manager.removeItem(at: root.appendingPathComponent(orphan))
        }
    }

    deinit {
        _ = Self.lock.withLock { Self.live.remove(directory.lastPathComponent) }
        try? FileManager.default.removeItem(at: directory)
    }

    /// A new, unused file in the folder.
    public func newFile(extension pathExtension: String) throws -> URL {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent(UUID().uuidString).appendingPathExtension(pathExtension)
    }

    /// Deletes a file this folder holds; anything else is left alone.
    public func remove(_ url: URL) {
        guard url.deletingLastPathComponent().standardizedFileURL == directory.standardizedFileURL else { return }
        try? FileManager.default.removeItem(at: url)
    }
}
