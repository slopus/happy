#if canImport(UIKit)
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// The system's photo picker, for a library the app hasn't been let read:
/// it runs outside the app and needs no permission, so nothing is asked,
/// as desktop's file picker asks nothing. Its picks come back as the
/// library sheet's do (`LibraryPicker`), in the order picked; a picker
/// closed with nothing picked is `onCancel`.
@MainActor
final class LibrarySystemPicker: NSObject, PHPickerViewControllerDelegate {
    var onCancel: (() -> Void)?
    private let onPick: ([LibraryPick]) -> Void
    /// Kept until the picks are read: the picker holds its delegate weakly.
    private var kept: LibrarySystemPicker?

    private init(onPick: @escaping ([LibraryPick]) -> Void) {
        self.onPick = onPick
    }

    /// The picker's settings: no library given, so it asks no permission.
    static func configuration(limit: Int, videos: Bool) -> PHPickerConfiguration {
        var configuration = PHPickerConfiguration()
        configuration.filter = videos ? .any(of: [.images, .videos]) : .images
        configuration.selectionLimit = limit
        configuration.selection = .ordered
        // The original, not a transcode: pictures are converted on adding.
        configuration.preferredAssetRepresentationMode = .current
        return configuration
    }

    @discardableResult
    static func present(from host: UIViewController, options: LibraryPicker.Options, onPick: @escaping ([LibraryPick]) -> Void) -> LibrarySystemPicker {
        let chooser = LibrarySystemPicker(onPick: onPick)
        chooser.kept = chooser
        let picker = PHPickerViewController(configuration: configuration(limit: options.limit, videos: options.videos))
        picker.delegate = chooser
        host.present(picker, animated: true)
        return chooser
    }

    nonisolated func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        let providers = results.map { Provided(provider: $0.itemProvider) }
        MainActor.assumeIsolated {
            picker.dismiss(animated: true)
            guard !providers.isEmpty else {
                onCancel?()
                kept = nil
                return
            }
            Task {
                var picks: [LibraryPick] = []
                for item in providers {
                    if let pick = await Self.read(item) { picks.append(pick) }
                }
                onPick(picks)
                kept = nil
            }
        }
    }

    /// A picked photo or video as a pick. The picker's file lives only
    /// inside its callback, so it is copied out there.
    nonisolated private static func read(_ item: Provided) async -> LibraryPick? {
        let provider = item.provider
        let type: UTType = provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) ? .movie : .image
        let copy: URL? = await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { @Sendable url, _ in
                guard let url else { return continuation.resume(returning: nil) }
                let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
                let target = folder.appendingPathComponent(url.lastPathComponent)
                do {
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    try FileManager.default.copyItem(at: url, to: target)
                    continuation.resume(returning: target)
                } catch {
                    try? FileManager.default.removeItem(at: folder)
                    continuation.resume(returning: nil)
                }
            }
        }
        guard let copy else { return nil }
        defer { try? FileManager.default.removeItem(at: copy.deletingLastPathComponent()) }
        return LibraryPicker.document(copy, videos: true)
    }
}

/// A picked item's provider. NSItemProvider may be used from any thread
/// (its loads call back on their own queues), but this SDK doesn't mark it
/// Sendable.
private struct Provided: @unchecked Sendable {
    let provider: NSItemProvider
}
#endif
