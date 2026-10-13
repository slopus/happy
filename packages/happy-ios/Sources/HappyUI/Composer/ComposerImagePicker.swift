#if canImport(UIKit)
import HappyCore
import ImageIO
import os
import PhotosUI
import UIKit
import UniformTypeIdentifiers

private let logger = Logger(subsystem: "engineering.happy", category: "composer")

/// A picked image waiting in the composer.
struct ComposerPickedImage: Equatable, Sendable {
    var id: String
    var attachment: OutgoingAttachment
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

    init(staging: ComposerAttachmentStaging) {
        self.staging = staging
    }

    /// `attachImages`: asks, every time, whether to paste or to pick.
    func attach() {
        let alert = UIAlertController(title: Strings.ImageUpload.attachTitle, message: nil, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.ImageUpload.pasteFromClipboard, style: .default) { [weak self] _ in
            self?.pasteImages()
        })
        alert.addAction(UIAlertAction(title: Strings.ImageUpload.chooseFromLibrary, style: .default) { [weak self] _ in
            self?.pickImages()
        })
        alert.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel))
        present(alert)
    }

    func remove(id: String) {
        guard let index = images.firstIndex(where: { $0.id == id }) else { return }
        staging.remove(images[index].attachment.fileURL)
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
        }
        images = []
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
        let staging = staging
        Task {
            do {
                let normalized = try await Task.detached {
                    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
                        throw ComposerImageError.unreadable
                    }
                    return try ComposerImageNormalizer.normalize(source, into: staging)
                }.value
                admit(normalized, name: name)
            } catch {
                logger.error("pasted image conversion failed: \(String(describing: error), privacy: .public)")
                uploadFailedAlert()
            }
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
        guard image.size <= ComposerAttachmentRules.maxFileSize else {
            staging.remove(image.fileURL)
            alert(
                Strings.ImageUpload.fileTooLargeTitle,
                Strings.ImageUpload.fileTooLargeMessage(name: name ?? "image", maxMb: ComposerAttachmentRules.maxFileSizeMegabytes)
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

/// A picked item's provider. NSItemProvider may be used from any thread
/// (its loads call back on their own queues), but this SDK doesn't mark it
/// Sendable.
private struct PickedItem: @unchecked Sendable {
    let provider: NSItemProvider
}

enum ComposerImageError: Error {
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
/// 3072, JPEG at 0.92, measured after writing.
enum ComposerImageNormalizer {
    static func normalize(_ source: CGImageSource, into staging: ComposerAttachmentStaging) throws -> ComposerNormalizedImage {
        guard CGImageSourceGetCount(source) > 0 else { throw ComposerImageError.unreadable }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
        let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue ?? 0
        let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue ?? 0
        let longEdge = ComposerAttachmentRules.longEdge(width: width, height: height)
        guard longEdge > 0 else { throw ComposerImageError.unreadable }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: longEdge,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw ComposerImageError.unreadable
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
