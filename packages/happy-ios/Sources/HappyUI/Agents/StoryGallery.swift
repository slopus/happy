#if canImport(UIKit)
import AVFoundation
import HappyCore
import PhotosUI
import UniformTypeIdentifiers
import UIKit

@MainActor
final class StoryGallery: NSObject, PHPickerViewControllerDelegate {
    #if DEBUG
    static var debugItem: URL?
    #endif
    private weak var owner: UIViewController?
    private let client: AgentClient, library: MediaLibrary?
    private var task: Task<Void, Never>?
    var preparing: Bool { task != nil }
    deinit { task?.cancel() }
    init(from owner: UIViewController, client: AgentClient, library: MediaLibrary?) {
        (self.owner, self.client, self.library) = (owner, client, library)
        super.init()
        #if DEBUG
        if let file = Self.debugItem { selected { try Self.copy(file) }; return }
        #endif
        var config = PHPickerConfiguration(); config.filter = .any(of: [.images, .videos]); config.selectionLimit = 1
        let picker = PHPickerViewController(configuration: config); picker.delegate = self
        owner.present(picker, animated: true)
    }
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true) { [weak self] in
            guard let self, let provider = results.first?.itemProvider else { return }
            let video = provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier)
            selected {
                try await withCheckedThrowingContinuation { continuation in
                    provider.loadFileRepresentation(forTypeIdentifier: video ? UTType.movie.identifier : UTType.image.identifier) { file, error in
                        do { guard let file else { throw error ?? CocoaError(.fileReadUnknown) }; continuation.resume(returning: try Self.copy(file)) }
                        catch { continuation.resume(throwing: error) }
                    }
                }
            }
        }
    }
    private func selected(_ read: @escaping () async throws -> URL) {
        guard task == nil else { return }
        let progress = UIAlertController(title: "Preparing story…", message: nil, preferredStyle: .alert)
        progress.addAction(UIAlertAction(title: Strings.Stories.cancel, style: .cancel) { [weak self] _ in self?.task?.cancel() })
        task = Task { [weak self, weak owner = owner, client, library] in
            defer { self?.task = nil }
            do {
                if let owner { await withCheckedContinuation { continuation in owner.present(progress, animated: true) { continuation.resume() } } } else { return }
                let (file, mime) = try await Self.prepare(read())
                var handedOff = false
                defer { if !handedOff { try? FileManager.default.removeItem(at: file) } }
                if progress.presentingViewController != nil { await withCheckedContinuation { continuation in progress.dismiss(animated: true) { continuation.resume() } } }
                try Task.checkCancellation()
                guard let owner, owner.viewIfLoaded?.window != nil, owner.presentedViewController == nil else { return }
                owner.present(StoryRepostController(client: client, source: .gallery(file, mime), library: library) { [weak self] ok in if !ok { self?.failed() } }, animated: true)
                handedOff = true
            } catch { progress.dismiss(animated: true) { [weak self] in if !(error is CancellationError) { self?.failed() } } }
        }
    }
    private func failed() {
        let alert = UIAlertController(title: Strings.Stories.failed, message: nil, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default)); owner?.present(alert, animated: true)
    }
    private nonisolated static func copy(_ file: URL) throws -> URL {
        let out = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension(file.pathExtension)
        try FileManager.default.copyItem(at: file, to: out); return out
    }
    private nonisolated static func prepare(_ file: URL) async throws -> (URL, String) {
        defer { try? FileManager.default.removeItem(at: file) }
        try Task.checkCancellation()
        let video = UTType(filenameExtension: file.pathExtension)?.conforms(to: .movie) == true
        let data: Data
        if video { data = try await StoryRepostController.mp4(file, preset: AVAssetExportPreset1280x720, limit: 32 << 20) }
        else { guard let jpeg = Images.decode(try Data(contentsOf: file), maxPixels: 2048)?.jpegData(compressionQuality: 0.9) else { throw CocoaError(.fileReadCorruptFile) }; data = jpeg }
        try Task.checkCancellation()
        guard data.count <= 32 << 20 else { throw CocoaError(.fileReadTooLarge) }
        let out = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension(video ? "mp4" : "jpg")
        try data.write(to: out); return (out, video ? "video/mp4" : "image/jpeg")
    }
}
#endif