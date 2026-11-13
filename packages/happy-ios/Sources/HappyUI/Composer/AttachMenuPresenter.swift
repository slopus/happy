#if canImport(UIKit)
import HappyCore
import UIKit
import UniformTypeIdentifiers

/// The composer's "+", the same in every chat: Telegram's attachment menu
/// (`AttachSheetViewController`) over the screen, then whatever it chose,
/// the system's photo picker, the camera or Files, and
/// what comes back read into the composer's `ComposerImagePicker` in the
/// order it was picked, within the room left there.
///
/// As Telegram's menu does, it takes the keyboard down while it is up and
/// gives it back once the menu, and whatever it opened, is done. The draft,
/// its selection and what already waits in the composer stay as they were;
/// the menu's confirm adds its picks and makes its caption the draft, then
/// gives the composer the keyboard, nothing sent: the composer's own send
/// sends them.
@MainActor
final class AttachMenuPresenter: NSObject {
    /// What the presenter reads from and hands back to the composer it serves.
    struct Composer {
        /// The text view, which loses the keyboard while the menu is up.
        var textView: () -> UITextView?
        /// Brings the keyboard back to it.
        var focus: () -> Void
        /// The "+", which the menu's card hangs from on an iPad.
        var addControl: () -> UIView?
        /// The draft, which the menu's caption starts from and writes back to.
        var text: () -> String
        var setText: (String) -> Void
    }

    let pictures: ComposerImagePicker
    private let composer: Composer
    /// What the menu started is over: `added`, whether anything came into
    /// the composer, `keyboardWasUp`, whether the keyboard was up as the
    /// menu opened. Without one the keyboard comes back when it was up.
    var onSettled: ((_ added: Bool, _ keyboardWasUp: Bool) -> Void)?
    /// The menu while it is up.
    private(set) weak var sheet: AttachSheetViewController?
    private weak var host: UIViewController?
    private var keyboardOwed = false

    init(pictures: ComposerImagePicker, composer: Composer) {
        self.pictures = pictures
        self.composer = composer
    }

    /// The menu over `host`, once a transition `host` is in is over.
    func present(from host: UIViewController) {
        guard sheet == nil else { return }
        let sheet = AttachSheetViewController(limit: ComposerAttachmentRules.remaining(selected: pictures.images.count), caption: composer.text())
        let library = sheet.library
        sheet.onAction = { [weak self] action in
            guard let self else { return }
            self.sheet = nil
            switch action {
            case .photos: presentSystemPhotos()
            case .camera: presentCamera()
            case .photo(let photo): take(photo)
            case .files: presentFiles()
            case let .stage(ids, caption): stage(ids, caption: caption, from: library)
            }
        }
        sheet.onCaption = { [weak self] text in self?.composer.setText(text) }
        sheet.button = { [weak self] in self?.composer.addControl() }
        sheet.onGone = { [weak self] in
            self?.sheet = nil
            self?.settle(added: false)
        }
        sheet.source = { [weak self, weak sheet] in
            guard let self, let sheet, sheet.isViewLoaded, let control = composer.addControl() else { return nil }
            return control.convert(control.bounds, to: sheet.view)
        }
        keyboardOwed = keyboardOwed || composer.textView()?.isFirstResponder == true
        self.sheet = sheet
        self.host = host
        let show = { [weak host, weak self] in
            guard let host, let self, self.sheet === sheet else { return }
            composer.textView()?.resignFirstResponder()
            host.present(sheet, animated: false)
        }
        if let transition = host.transitionCoordinator {
            transition.animate(alongsideTransition: nil) { _ in show() }
        } else {
            show()
        }
    }

    /// What `host` shows on top, for the pickers the menu opens.
    private var top: UIViewController? {
        guard var top = host else { return nil }
        while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
        return top
    }

    /// Photos and videos in the system's picker, which runs outside the app
    /// and needs no access: the way in when the library is refused, and the
    /// Files tab's "Select Photos or Videos".
    private func presentSystemPhotos() {
        let room = pictures.room()
        guard room > 0, let top else { return settle(added: false) }
        LibrarySystemPicker.present(from: top, options: LibraryPicker.Options(limit: room)) { [weak self] picks in
            guard let self else { return LibraryPicker.discard(picks) }
            take(picks)
        }.onCancel = { [weak self] in self?.settle(added: false) }
    }

    /// Confirmed in the menu: its picks show in the composer at once, from
    /// the library's thumbnails, each with a ring while the picture itself
    /// is read (from iCloud if need be), a few side by side. The caption is
    /// the composer's text, and the composer has the keyboard, to send them
    /// with its own button.
    func stage(_ ids: [String], caption: String, from library: AttachLibrary) {
        composer.setText(caption)
        keyboardOwed = true
        settle(added: true)
        Task { await pictures.add(library: ids, from: library) }
    }

    /// The full camera on its own, where the menu couldn't open it.
    private func presentCamera() {
        guard pictures.room() > 0, let top else { return settle(added: false) }
        let camera = CameraViewController(camera: CameraEnvironment.engine())
        camera.onFinish = { [weak self, weak camera] photo in
            camera?.dismiss(animated: false)
            guard let self else { return }
            guard let photo else { return settle(added: false) }
            take(photo)
        }
        top.present(camera, animated: false)
    }

    /// The camera's photo into the composer, cut to its shape and
    /// converted as a paste is.
    private func take(_ photo: CameraPhoto) {
        Task {
            let before = pictures.images.count
            await pictures.add(photo: photo)
            settle(added: pictures.images.count > before)
        }
    }

    private func presentFiles() {
        guard pictures.room() > 0, let top else { return settle(added: false) }
        let files = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
        files.allowsMultipleSelection = true
        files.delegate = self
        top.present(files, animated: true)
    }

    /// The picks into the composer, then the keyboard as it was.
    private func take(_ picks: [LibraryPick]) {
        Task {
            let added = await read(picks)
            settle(added: added)
        }
    }

    /// In the order picked, each file copied in before the pick's own
    /// temporary copy goes: a picture converted as a paste is, a video or
    /// any other file kept as it is. True when anything came in.
    @discardableResult
    private func read(_ picks: [LibraryPick]) async -> Bool {
        let before = pictures.images.count
        for pick in picks {
            switch pick.media {
            case .image(let data, _): await pictures.add(picture: data)
            case .video(let url):
                let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "video/mp4"
                await pictures.add(file: url, name: url.lastPathComponent, mimeType: mime)
            case .file(let url, let type):
                await pictures.add(file: url, name: url.lastPathComponent, mimeType: type.preferredMIMEType ?? "application/octet-stream")
            }
        }
        LibraryPicker.discard(picks)
        return pictures.images.count > before
    }

    /// What the menu started is over; the keyboard is owed no longer.
    private func settle(added: Bool) {
        let owed = keyboardOwed
        keyboardOwed = false
        if let onSettled {
            onSettled(added, owed)
        } else if owed {
            composer.focus()
        }
    }
}

extension AttachMenuPresenter: UIDocumentPickerDelegate {
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        settle(added: false)
    }

    /// Files' copies, pictures among them read as pictures, off the main thread.
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let room = max(1, ComposerAttachmentRules.remaining(selected: pictures.images.count))
        for extra in urls.dropFirst(room) { try? FileManager.default.removeItem(at: extra) }
        let urls = Array(urls.prefix(room))
        Task { [weak self] in
            let picks = await Task.detached(priority: .userInitiated) { urls.compactMap { LibraryPicker.document($0, videos: true) } }.value
            guard let self else { return LibraryPicker.discard(picks) }
            take(picks)
        }
    }
}
#endif
