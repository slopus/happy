#if canImport(UIKit)
import HappyCore
import ImageIO
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// The system's photo picker for a profile picture, as Settings › Profile
/// and Create your profile open it: one image, decoded, cut square and
/// shrunk off the main thread (`ProfileSource.prepare`), then handed to
/// `picked`.
final class ProfilePhotoPicker: NSObject, PHPickerViewControllerDelegate {
    private let picked: (UIImage) -> Void

    init(picked: @escaping (UIImage) -> Void) {
        self.picked = picked
    }

    func present(from controller: UIViewController) {
        guard controller.presentedViewController == nil else { return }
        var configuration = PHPickerConfiguration()
        configuration.filter = .images
        configuration.selectionLimit = 1
        configuration.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = self
        controller.present(picker, animated: true)
    }

    nonisolated func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        let item = results.first.map { PickedPhoto(provider: $0.itemProvider) }
        MainActor.assumeIsolated {
            picker.dismiss(animated: true)
            guard let item else { return }
            Task { [weak self] in
                guard let image = await Self.load(item) else { return }
                self?.picked(image)
            }
        }
    }

    /// The picker's file only lives inside its callback, so it is decoded,
    /// cut square and shrunk there, off the main thread.
    private nonisolated static func load(_ item: PickedPhoto) async -> UIImage? {
        await withCheckedContinuation { continuation in
            _ = item.provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { @Sendable url, _ in
                guard let url, let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return continuation.resume(returning: nil) }
                let options: [CFString: Any] = [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: 2048,
                ]
                guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return continuation.resume(returning: nil) }
                continuation.resume(returning: ProfileSource.prepare(UIImage(cgImage: image)))
            }
        }
    }

    /// A picture as it is sent: JPEG, made off the main thread.
    static func jpeg(_ image: UIImage) async -> Data? {
        await Task.detached { image.jpegData(compressionQuality: 0.85) }.value
    }
}

/// The picker's item. NSItemProvider is safe to hand across threads (its
/// loads call back on their own queues), but this SDK doesn't mark it
/// Sendable.
private struct PickedPhoto: @unchecked Sendable {
    let provider: NSItemProvider
}
#endif
