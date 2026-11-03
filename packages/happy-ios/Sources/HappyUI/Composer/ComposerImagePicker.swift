#if canImport(UIKit)
import AVFoundation
import HappyCore
import HappyLayout
import ImageIO
import os
import PhotosUI
import UIKit
import UniformTypeIdentifiers

private let logger = Logger(subsystem: "engineering.happy", category: "composer")

/// A picked image waiting in the composer.
struct ComposerPickedImage: Equatable, Sendable {
    var id: String
    /// While `preparing`, its thumbnail, a JPEG with the picture's shape.
    var attachment: OutgoingAttachment
    /// Still being read from the library (an iCloud photo coming down) and
    /// converted: shown from the library's thumbnail with a ring.
    var preparing = false
}

/// useImagePicker.ts on iOS: the add button asks whether to paste or to
/// pick, each image is converted to a JPEG (long edge at most 3072,
/// quality 0.92), measured, and held in the staging folder until sent.
/// PHPicker needs no photo library permission, so its alert never shows.
@MainActor
final class ComposerImagePicker: NSObject, PHPickerViewControllerDelegate {
    private(set) var images: [ComposerPickedImage] = [] {
        didSet {
            if images != oldValue { onChange?() }
        }
    }

    var onChange: (() -> Void)?
    /// Presents the alerts and the picker.
    var host: (() -> UIViewController?)?

    private let staging: ComposerAttachmentStaging
    private let maxFileBytes: Int
    /// The library's picks being read, by their preview's id: each ends
    /// with the picture as it is sent, or nil if it couldn't be read.
    private var preparations: [String: Task<OutgoingAttachment?, Never>] = [:]
    /// Taken by a send while still being read: theirs once they are in.
    private var handedOff: Set<String> = []
    /// How many picks are read at once, side by side.
    static let concurrentReads = 3
    private let reads = ReadGate(width: ComposerImagePicker.concurrentReads)

    init(staging: ComposerAttachmentStaging, maxFileBytes: Int = ComposerAttachmentRules.maxFileSize) {
        self.staging = staging
        self.maxFileBytes = maxFileBytes
    }

    /// `attachImages`: the library picker. A copied picture is pasted in
    /// the text view (`paste`).
    func attach() {
        pickImages()
    }

    /// How many more pictures may wait in the composer; at none, says so.
    func room() -> Int {
        let remaining = ComposerAttachmentRules.remaining(selected: images.count)
        if remaining == 0 { limitAlert() }
        return remaining
    }

    /// Pictures picked elsewhere (the shared library sheet), as their bytes:
    /// each converted and held as a paste's is, one after another so they
    /// wait in the order they were picked.
    func add(pictures: [Data]) {
        let picked = Array(pictures.prefix(ComposerAttachmentRules.remaining(selected: images.count)))
        Task { for data in picked { await stage(data, name: nil) } }
    }

    /// The shared library picker hands ownership of videos and documents to
    /// this staging directory before its temporary copies are discarded.
    func add(file: URL, name: String, mimeType: String) async {
        guard room() > 0 else { return }
        let staging = staging
        let limit = maxFileBytes
        do {
            let attachment = try await Task.detached { () -> OutgoingAttachment in
                let values = try URL(fileURLWithPath: file.path).resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
                guard values.isRegularFile == true, let size = values.fileSize, size <= limit else {
                    throw ComposerImageError.tooLarge
                }
                let destination = try staging.newFile(extension: file.pathExtension)
                try FileManager.default.copyItem(at: file, to: destination)
                // Its shape, so its tile in the sent message has it before it is read.
                let shape = await Self.shape(destination, mimeType: mimeType)
                return OutgoingAttachment(fileURL: destination, name: name, mimeType: mimeType, size: size,
                    width: shape.map { Int($0.width) }, height: shape.map { Int($0.height) })
            }.value
            guard images.count < ComposerAttachmentRules.maxImages else { staging.remove(attachment.fileURL); return }
            images.append(ComposerPickedImage(id: ComposerAttachmentRules.previewId(), attachment: attachment))
        } catch ComposerImageError.tooLarge {
            alert(Strings.ImageUpload.fileTooLargeTitle,
                Strings.ImageUpload.fileTooLargeMessage(name: name, maxMb: limit / 1024 / 1024))
        } catch { uploadFailedAlert() }
    }

    /// A video's or picture's upright size in pixels, read from its file.
    nonisolated static func shape(_ file: URL, mimeType: String) async -> CGSize? {
        if mimeType.hasPrefix("video/") {
            guard let track = try? await AVURLAsset(url: file).loadTracks(withMediaType: .video).first,
                  let (size, transform) = try? await track.load(.naturalSize, .preferredTransform) else { return nil }
            let upright = size.applying(transform)
            return CGSize(width: abs(upright.width), height: abs(upright.height))
        }
        guard mimeType.hasPrefix("image/"), let source = CGImageSourceCreateWithURL(file as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? CGFloat,
              let height = properties[kCGImagePropertyPixelHeight] as? CGFloat else { return nil }
        // EXIF orientations 5 to 8 turn the picture on its side.
        let turned = (properties[kCGImagePropertyOrientation] as? Int).map { (5...8).contains($0) } ?? false
        return turned ? CGSize(width: height, height: width) : CGSize(width: width, height: height)
    }

    func add(picture: Data) async { await stage(picture, name: nil) }

    /// A photo from the camera, cut to the shape it was taken in.
    func add(photo: CameraPhoto) async { await stage(photo.data, name: nil, ratio: photo.ratio) }

    /// The pasteboard's picture, attached: what a paste in the text view
    /// does when there is one.
    func paste() {
        pasteImages()
    }

    func remove(id: String) {
        guard let index = images.firstIndex(where: { $0.id == id }) else { return }
        staging.remove(images[index].attachment.fileURL)
        preparations.removeValue(forKey: id)?.cancel()
        images.remove(at: index)
    }

    /// Accepted by the outbox, which has its own copies now.
    func removeSent(_ ids: [String]) {
        for id in ids {
            remove(id: id)
        }
    }

    func clear() {
        for image in images {
            staging.remove(image.attachment.fileURL)
            preparations.removeValue(forKey: image.id)?.cancel()
        }
        images = []
    }

    // MARK: Library reads

    /// Picks from the "+" menu's grid: each shows at once, from the
    /// library's thumbnail with a ring, while the picture itself is read
    /// (from iCloud if it has to be) and converted, a few side by side.
    /// One that can't be read goes, with the alert a failed paste shows.
    func add(library ids: [String], from library: AttachLibrary) async {
        for id in ids {
            guard images.count < ComposerAttachmentRules.maxImages else { break }
            let shown = await library.preview(id)
            let staging = staging
            let thumbnail = await Task.detached(priority: .userInitiated) { () -> ComposerNormalizedImage? in
                guard let image = shown?.image.cgImage else { return nil }
                return try? ComposerImageNormalizer.thumbnail(image, into: staging)
            }.value
            guard images.count < ComposerAttachmentRules.maxImages else {
                if let thumbnail { staging.remove(thumbnail.fileURL) }
                break
            }
            let previewId = ComposerAttachmentRules.previewId()
            let pixels = shown?.pixels
            if let thumbnail {
                images.append(ComposerPickedImage(id: previewId, attachment: OutgoingAttachment(
                    fileURL: thumbnail.fileURL, name: "", mimeType: "image/jpeg", size: thumbnail.size,
                    width: pixels.map { Int($0.width) } ?? thumbnail.width, height: pixels.map { Int($0.height) } ?? thumbnail.height
                ), preparing: true))
            }
            let reads = reads
            let limit = maxFileBytes
            preparations[previewId] = Task { [weak self] in
                await reads.enter()
                let pick = Task.isCancelled ? nil : await library.read([id]).first
                await reads.leave()
                let attachment: OutgoingAttachment?
                do {
                    guard let media = pick?.media else { throw ComposerImageError.unreadable }
                    attachment = try await Task.detached(priority: .userInitiated) { try await Self.prepare(media, into: staging, limit: limit) }.value
                } catch ComposerImageError.tooLarge {
                    self?.alert(Strings.ImageUpload.fileTooLargeTitle, Strings.ImageUpload.fileTooLargeMessage(name: "image", maxMb: limit / 1024 / 1024))
                    attachment = nil
                } catch {
                    if !Task.isCancelled { self?.uploadFailedAlert() }
                    attachment = nil
                }
                if let pick { LibraryPicker.discard([pick]) }
                return self?.prepared(previewId, attachment, thumbnail: thumbnail?.fileURL) ?? attachment
            }
        }
    }

    /// A pick is read: it takes its thumbnail's place, or, taken by a send,
    /// is the send's. Removed meanwhile, or failed, it goes.
    private func prepared(_ id: String, _ attachment: OutgoingAttachment?, thumbnail: URL?) -> OutgoingAttachment? {
        preparations[id] = nil
        if handedOff.remove(id) != nil { return attachment }
        guard let index = images.firstIndex(where: { $0.id == id }) else {
            if let attachment { staging.remove(attachment.fileURL) }
            return nil
        }
        guard let attachment else {
            images.remove(at: index)
            if let thumbnail { staging.remove(thumbnail) }
            return nil
        }
        images[index] = ComposerPickedImage(id: id, attachment: attachment)
        // A send that read the composer just before may still draw it.
        if let thumbnail {
            let staging = staging
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) { staging.remove(thumbnail) }
        }
        return nil
    }

    /// Takes the picks still being read out of the composer for a send:
    /// each ends with its picture, now the caller's to remove once sent,
    /// as are their thumbnails. One read meanwhile ends at once.
    func handOff(_ ids: [String]) -> [(id: String, thumbnail: URL, picture: Task<OutgoingAttachment?, Never>)] {
        var handed: [(id: String, thumbnail: URL, picture: Task<OutgoingAttachment?, Never>)] = []
        for id in ids {
            guard let index = images.firstIndex(where: { $0.id == id }) else { continue }
            let image = images.remove(at: index)
            if image.preparing, let task = preparations[id] {
                handedOff.insert(id)
                handed.append((id, image.attachment.fileURL, task))
            } else {
                let ready = image.attachment
                handed.append((id, ready.fileURL, Task { ready }))
            }
        }
        return handed
    }

    /// Every pick being read now, read (or gone): for a composer whose send
    /// takes only pictures that are in.
    func ready() async {
        for task in Array(preparations.values) { _ = await task.value }
    }

    /// Removes files a send has its own copies of.
    func discard(_ files: [URL]) {
        for file in Set(files) { staging.remove(file) }
    }

    /// A library pick as it is sent: a picture converted as a paste is, a
    /// video or other file copied in as it is, with its shape.
    private nonisolated static func prepare(_ media: LibraryPick.Media, into staging: ComposerAttachmentStaging, limit: Int) async throws -> OutgoingAttachment {
        switch media {
        case .image(let data, _):
            guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { throw ComposerImageError.unreadable }
            let image = try ComposerImageNormalizer.normalize(source, into: staging)
            guard image.size <= limit else {
                staging.remove(image.fileURL)
                throw ComposerImageError.tooLarge
            }
            return OutgoingAttachment(fileURL: image.fileURL, name: ComposerAttachmentRules.jpegName(nil, now: Date()), mimeType: "image/jpeg",
                                      size: image.size, width: image.width, height: image.height)
        case .video(let url), .file(let url, _):
            let mime: String
            if case .file(_, let type) = media { mime = type.preferredMIMEType ?? "application/octet-stream" }
            else { mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "video/mp4" }
            let values = try URL(fileURLWithPath: url.path).resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard values.isRegularFile == true, let size = values.fileSize else { throw ComposerImageError.unreadable }
            guard size <= limit else { throw ComposerImageError.tooLarge }
            let destination = try staging.newFile(extension: url.pathExtension)
            try FileManager.default.copyItem(at: url, to: destination)
            let shape = await shape(destination, mimeType: mime)
            return OutgoingAttachment(fileURL: destination, name: url.lastPathComponent, mimeType: mime, size: size,
                                      width: shape.map { Int($0.width) }, height: shape.map { Int($0.height) })
        }
    }

    // MARK: Library

    private func pickImages() {
        let remaining = ComposerAttachmentRules.remaining(selected: images.count)
        guard remaining > 0 else {
            limitAlert()
            return
        }
        var configuration = PHPickerConfiguration()
        configuration.filter = .images
        configuration.selectionLimit = remaining
        configuration.selection = .ordered
        // Converted below, so take the original rather than a transcode.
        configuration.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = self
        present(picker)
    }

    nonisolated func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        let providers = results.map { PickedItem(provider: $0.itemProvider) }
        MainActor.assumeIsolated {
            picker.dismiss(animated: true) { [weak self] in
                guard let self, !providers.isEmpty else { return }
                Task { await self.add(providers) }
            }
        }
    }

    private func add(_ providers: [PickedItem]) async {
        // The web clamp, kept: the limit may have moved while picking.
        let remaining = ComposerAttachmentRules.remaining(selected: images.count)
        for item in providers.prefix(remaining) {
            let name = item.provider.suggestedName
            do {
                let normalized = try await Self.load(item, into: staging)
                admit(normalized, name: name)
            } catch {
                logger.error("image conversion failed: \(String(describing: error), privacy: .public)")
                uploadFailedAlert()
            }
        }
    }

    /// The picker's file only lives inside the callback, so it is
    /// converted there, off the main thread.
    private static func load(_ item: PickedItem, into staging: ComposerAttachmentStaging) async throws -> ComposerNormalizedImage {
        try await withCheckedThrowingContinuation { continuation in
            _ = item.provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { @Sendable url, error in
                guard let url else {
                    continuation.resume(throwing: error ?? ComposerImageError.unreadable)
                    return
                }
                continuation.resume(with: Result {
                    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
                        throw ComposerImageError.unreadable
                    }
                    return try ComposerImageNormalizer.normalize(source, into: staging)
                })
            }
        }
    }

    // MARK: Clipboard

    /// `pasteImages`: the clipboard's image, through the same conversion and
    /// limits as a picked one. An empty clipboard (or a refused paste) is
    /// answered rather than passed over.
    private func pasteImages() {
        guard ComposerAttachmentRules.remaining(selected: images.count) > 0 else {
            limitAlert()
            return
        }
        guard let data = Self.pastedImageData() else {
            alert(Strings.ImageUpload.nothingToPasteTitle, Strings.ImageUpload.nothingToPasteMessage)
            return
        }
        let name = ComposerAttachmentRules.pastedName(now: Date())
        Task { await stage(data, name: name) }
    }

    /// Converts a picture's bytes off the main thread and holds it.
    private func stage(_ data: Data, name: String?, ratio: Double? = nil) async {
        let staging = staging
        do {
            let normalized = try await Task.detached {
                guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
                    throw ComposerImageError.unreadable
                }
                return try ComposerImageNormalizer.normalize(source, into: staging, ratio: ratio)
            }.value
            admit(normalized, name: name)
        } catch {
            logger.error("picture conversion failed: \(String(describing: error), privacy: .public)")
            uploadFailedAlert()
        }
    }

    /// The clipboard's image as it was copied (so its orientation comes
    /// along), else re-encoded. On iOS 16+ a refused paste reads as none.
    private static func pastedImageData() -> Data? {
        let pasteboard = UIPasteboard.general
        guard pasteboard.hasImages else { return nil }
        for type in pasteboard.types {
            guard let uti = UTType(type), uti.conforms(to: .image) else { continue }
            if let data = pasteboard.data(forPasteboardType: type), !data.isEmpty {
                return data
            }
        }
        return pasteboard.image?.pngData()
    }

    // MARK: Admission

    /// `previewForAsset`'s size check, then onto the end of the list.
    private func admit(_ image: ComposerNormalizedImage, name: String?) {
        guard image.size <= maxFileBytes else {
            staging.remove(image.fileURL)
            alert(
                Strings.ImageUpload.fileTooLargeTitle,
                Strings.ImageUpload.fileTooLargeMessage(name: name ?? "image", maxMb: maxFileBytes / 1024 / 1024)
            )
            return
        }
        guard images.count < ComposerAttachmentRules.maxImages else {
            staging.remove(image.fileURL)
            return
        }
        images.append(ComposerPickedImage(
            id: ComposerAttachmentRules.previewId(),
            attachment: OutgoingAttachment(
                fileURL: image.fileURL,
                name: ComposerAttachmentRules.jpegName(name, now: Date()),
                mimeType: "image/jpeg",
                size: image.size,
                width: image.width,
                height: image.height
            )
        ))
    }

    // MARK: Alerts

    private func limitAlert() {
        alert(Strings.ImageUpload.limitTitle, Strings.ImageUpload.limitMessage(ComposerAttachmentRules.maxImages))
    }

    private func uploadFailedAlert() {
        alert(Strings.ImageUpload.uploadFailedTitle, Strings.ImageUpload.uploadFailedMessage(1))
    }

    private func alert(_ title: String, _ message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Common.ok, style: .cancel))
        present(alert)
    }

    /// Over whatever is already up, as React Native's alerts stack.
    private func present(_ controller: UIViewController) {
        guard var top = host?() else { return }
        while let presented = top.presentedViewController, !presented.isBeingDismissed {
            top = presented
        }
        top.present(controller, animated: true)
    }
}

/// At most `width` reads at once; the rest wait their turn in order.
private actor ReadGate {
    private let width: Int
    private var running = 0
    private var waiting: [CheckedContinuation<Void, Never>] = []

    init(width: Int) { self.width = width }

    /// Waits for a place; `leave` gives it to the next in line.
    func enter() async {
        if running < width {
            running += 1
            return
        }
        await withCheckedContinuation { waiting.append($0) }
    }

    func leave() {
        if waiting.isEmpty { running -= 1 } else { waiting.removeFirst().resume() }
    }
}

/// A picked item's provider. NSItemProvider may be used from any thread
/// (its loads call back on their own queues), but this SDK doesn't mark it
/// Sendable.
private struct PickedItem: @unchecked Sendable {
    let provider: NSItemProvider
}

enum ComposerImageError: Error {
    case tooLarge
    case unreadable
    case unwritable
}

struct ComposerNormalizedImage: Sendable {
    var fileURL: URL
    var width: Int
    var height: Int
    var size: Int
}

/// `normalizePickedAssetForUpload` on iOS: upright, the long edge at most
/// 3072, JPEG at 0.92, measured after writing. A camera photo is first cut
/// to its shape (`CameraCrop`), read at the size that leaves the cut 3072
/// long, so a square is the sensor's full height, not 3072 shrunk to 2304.
enum ComposerImageNormalizer {
    /// The library's thumbnail as a small JPEG, shown while the picture
    /// itself is read.
    static func thumbnail(_ image: CGImage, into staging: ComposerAttachmentStaging) throws -> ComposerNormalizedImage {
        let url = try staging.newFile(extension: "jpg")
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw ComposerImageError.unwritable
        }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            staging.remove(url)
            throw ComposerImageError.unwritable
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
        return ComposerNormalizedImage(fileURL: url, width: image.width, height: image.height, size: size)
    }

    static func normalize(_ source: CGImageSource, into staging: ComposerAttachmentStaging, ratio: Double? = nil) throws -> ComposerNormalizedImage {
        guard CGImageSourceGetCount(source) > 0 else { throw ComposerImageError.unreadable }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
        let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue ?? 0
        let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue ?? 0
        var longEdge = ComposerAttachmentRules.longEdge(width: width, height: height)
        guard longEdge > 0 else { throw ComposerImageError.unreadable }
        if let ratio {
            let cut = CameraCrop.rect(pixels: CGSize(width: width, height: height), ratio: CGFloat(ratio))
            let full = max(width, height)
            let cutLong = max(Int(cut.width), Int(cut.height))
            if cutLong > 0 {
                longEdge = min(full, ComposerAttachmentRules.longEdge(width: cutLong, height: 0) * full / cutLong)
            }
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: longEdge,
        ]
        guard var image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw ComposerImageError.unreadable
        }
        if let ratio, let cut = image.cropping(to: CameraCrop.rect(pixels: CGSize(width: image.width, height: image.height), ratio: CGFloat(ratio))) {
            image = cut
        }
        let url = try staging.newFile(extension: "jpg")
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw ComposerImageError.unwritable
        }
        let quality: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: ComposerAttachmentRules.jpegQuality]
        CGImageDestinationAddImage(destination, image, quality as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            staging.remove(url)
            throw ComposerImageError.unwritable
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
        guard size > 0 else {
            staging.remove(url)
            throw ComposerImageError.unwritable
        }
        return ComposerNormalizedImage(fileURL: url, width: image.width, height: image.height, size: size)
    }
}
#endif
