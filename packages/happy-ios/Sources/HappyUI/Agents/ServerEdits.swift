#if canImport(UIKit)
import HappyCore
import ImageIO
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// On a Happy Cloud server the picture's menu changes the server itself,
/// not its Chief of Staff: "Edit name" its name, "Change avatar" its
/// picture (`PATCH /v0/config` `node`, `AgentConnections.rename` and
/// `setAvatar`). Only a member who may manage its settings has the menu
/// (`config.manage`).
@MainActor
enum ServerEdits {
    /// Whether the menu on `session` changes the server.
    static func edits(_ session: Session) -> Bool { session.isCloud }

    /// Whether the menu is offered on `session`: on a cloud server, to
    /// whoever may manage its settings; elsewhere, to whoever may ask the
    /// Chief of Staff.
    static func offered(_ session: Session) -> Bool {
        edits(session) ? session.gate.allows(.configManage) : session.gate.allowsSending(toChiefOfStaff: true)
    }

    /// What the menu's `prefill` does on server `id`.
    static func run(_ prefill: ChatPrefill, _ id: String, context: AppContext, on controller: UIViewController) {
        if prefill == .agentAvatar { pickPicture(id, context: context, on: controller) } else { askName(id, context: context, on: controller) }
    }

    /// A prompt with the server's name in it; the new one is saved, or the
    /// server's refusal said.
    static func askName(_ id: String, context: AppContext, on controller: UIViewController) {
        typealias S = Strings.ServerName
        let connections = context.account.agentConnections
        guard let current = connections.accounts.first(where: { $0.id == id })?.name else { return }
        Task { @MainActor [weak controller] in
            guard let controller, let typed = await DetailAlerts.prompt(S.title, S.message, defaultValue: current, placeholder: current, confirmTitle: S.save, on: controller) else { return }
            let name = typed.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, name != current else { return }
            do {
                try await connections.rename(id, to: name)
                Haptics.play(.renamed)
            } catch {
                fail(Strings.ServerName.couldNotSave, error, on: controller)
            }
        }
    }

    /// The photo library, one picture; it goes up cut square and shrunk.
    static func pickPicture(_ id: String, context: AppContext, on controller: UIViewController) {
        guard controller.presentedViewController == nil else { return }
        var configuration = PHPickerConfiguration()
        configuration.filter = .images
        configuration.selectionLimit = 1
        configuration.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: configuration)
        let delegate = PictureDelegate { [weak controller] image in
            guard let controller else { return }
            Task { @MainActor in
                guard let data = await Task.detached(operation: { image.jpegData(compressionQuality: 0.85) }).value else { return }
                do {
                    try await context.account.agentConnections.setAvatar(id, to: data)
                } catch {
                    fail(Strings.ServerName.couldNotChangePicture, error, on: controller)
                }
            }
        }
        picker.delegate = delegate
        // Kept while the picker is: it holds its delegate weakly.
        objc_setAssociatedObject(picker, &PictureDelegate.key, delegate, .OBJC_ASSOCIATION_RETAIN)
        controller.present(picker, animated: true)
    }

    private static func fail(_ title: String, _ error: Error, on controller: UIViewController) {
        let message = Store.describe(error)
        Alerts.show(title, message.isEmpty ? error.localizedDescription : message, on: controller)
    }
}

private final class PictureDelegate: NSObject, PHPickerViewControllerDelegate {
    nonisolated(unsafe) static var key = 0
    private let picked: @MainActor (UIImage) -> Void

    init(_ picked: @escaping @MainActor (UIImage) -> Void) { self.picked = picked }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let provider = results.first?.itemProvider else { return }
        let item = Provided(provider: provider)
        Task { @MainActor [picked] in
            guard let image = await Self.load(item) else { return }
            picked(image)
        }
    }

    /// The picker's file only lives inside its callback, so it is decoded,
    /// cut square and shrunk there, off the main thread.
    private nonisolated static func load(_ item: Provided) async -> UIImage? {
        await withCheckedContinuation { continuation in
            _ = item.provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { @Sendable url, _ in
                guard let url, let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return continuation.resume(returning: nil) }
                let options: [CFString: Any] = [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: 1024,
                ]
                guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return continuation.resume(returning: nil) }
                continuation.resume(returning: shrink(ProfileSource.prepare(UIImage(cgImage: image))))
            }
        }
    }

    private nonisolated static func shrink(_ image: UIImage) -> UIImage {
        let side = min(image.size.width * image.scale, 512)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { _ in
            image.draw(in: CGRect(x: 0, y: 0, width: side, height: side))
        }
    }
}

/// NSItemProvider is safe to hand across threads, but this SDK doesn't
/// mark it Sendable.
private struct Provided: @unchecked Sendable {
    let provider: NSItemProvider
}
#endif
