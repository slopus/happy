#if canImport(UIKit)
import HappyCore
import HappyLayout
import LinkPresentation
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// What a person does to a vault's entries, from its browser and its
/// previews alike: name prompts, the move picker, the Files and Photos
/// pickers into uploads, downloads into the share sheet, and the words
/// for what the computer refused.
@MainActor
final class VaultActions: NSObject, UIDocumentPickerDelegate, PHPickerViewControllerDelegate {
    let session: Session
    let surfaceId: String
    let vaultName: String
    private weak var host: UIViewController?
    private var library: VaultLibrary { session.engine.vaults }
    /// What the open document picker picks for.
    private var picking: Picking?
    private var downloading: Task<Void, Never>?

    private enum Picking {
        case files(parent: String?)
        case version(VaultEntry)
    }

    init(session: Session, surfaceId: String, vaultName: String, host: UIViewController) {
        self.session = session
        self.surfaceId = surfaceId
        self.vaultName = vaultName
        self.host = host
    }

    // MARK: Refusals

    /// What a refusal says to the person.
    static func message(_ error: Error, name: String? = nil) -> String {
        if let refusal = Strings.refusal(error) { return refusal }
        switch error {
        case AgentClientError.status(403, _, _): return Strings.forbidden
        case AgentClientError.status(409, "name_taken", _): return Strings.Vaults.nameTaken(VaultEntry.shownName(name ?? ""))
        case AgentClientError.status(409, _, let message):
            return message?.localizedCaseInsensitiveContains("trash") == true ? Strings.Vaults.inTrashRefused : Strings.Vaults.changedElsewhere
        case AgentClientError.status(404, _, _): return Strings.Vaults.gone
        case AgentClientError.status(413, _, let message): return message ?? Strings.Vaults.tooLarge
        case AgentClientError.status(_, _, let message?) where !message.isEmpty: return message
        default: return Strings.Vaults.offline
        }
    }

    func refuse(_ text: String) {
        guard let host else { return }
        Alerts.show(Strings.Vaults.failedTitle, text, on: host.presentedViewController ?? host)
    }

    func show(_ error: Error, name: String? = nil) {
        guard let host, !(error is CancellationError) else { return }
        Alerts.show(Strings.Vaults.failedTitle, Self.message(error, name: name), on: host.presentedViewController ?? host)
    }

    /// Runs a change and says so when it is refused; it already shows.
    func perform(name: String? = nil, _ change: @escaping @Sendable (VaultLibrary) async throws -> Void) {
        let library = library
        Task { [weak self] in
            do { try await change(library) } catch { self?.show(error, name: name) }
        }
    }

    /// A name a person may give: not empty, no `/` or `\`, not `.` or `..`.
    static func validName(_ text: String) -> String? {
        let name = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name != ".", name != "..", !name.contains("/"), !name.contains("\\"),
              !name.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }) else { return nil }
        return name
    }

    // MARK: Names

    /// Asks for a name, `current` filled in with its stem selected.
    func askName(title: String, current: String, action: String, done: @escaping (String) -> Void) {
        guard let host else { return }
        let alert = UIAlertController(title: title, message: nil, preferredStyle: .alert)
        alert.addTextField { field in
            field.text = current
            field.placeholder = Strings.Vaults.namePlaceholder
            field.autocapitalizationType = .sentences
            field.clearButtonMode = .whileEditing
            field.accessibilityIdentifier = "vault-name-field"
            DispatchQueue.main.async {
                let stem = (current as NSString).deletingPathExtension
                if let start = field.position(from: field.beginningOfDocument, offset: 0),
                   let end = field.position(from: start, offset: (stem.isEmpty ? current : stem).utf16.count) {
                    field.selectedTextRange = field.textRange(from: start, to: end)
                }
            }
        }
        alert.addAction(UIAlertAction(title: Strings.Vaults.cancel, style: .cancel))
        alert.addAction(UIAlertAction(title: action, style: .default) { [weak self, weak alert] _ in
            guard let text = alert?.textFields?.first?.text else { return }
            guard let name = Self.validName(text) else {
                if let host = self?.host { Alerts.show(Strings.Vaults.failedTitle, Strings.Vaults.invalidName, on: host) }
                return
            }
            done(name)
        })
        host.present(alert, animated: true)
    }

    func newFolder(in parent: String?) {
        askName(title: Strings.Vaults.newFolderTitle, current: Strings.Vaults.untitledFolder, action: Strings.Vaults.create) { [weak self] name in
            guard let self else { return }
            if VaultEntry.kind(named: name) == .artifact { return refuse(Strings.Vaults.artifactSuffixRefused) }
            let surfaceId = surfaceId
            perform(name: name) { try await $0.createFolder(surfaceId, parentId: parent, name: name) }
        }
    }

    func rename(_ entry: VaultEntry) {
        askName(title: Strings.Vaults.renameTitle, current: entry.shownName, action: Strings.Vaults.save) { [weak self] typed in
            guard let self else { return }
            // An app is renamed without its `.artifact`, which it keeps; nothing else may take it.
            if entry.kind != .artifact, VaultEntry.kind(named: typed) == .artifact { return self.refuse(Strings.Vaults.artifactSuffixRefused) }
            let name = entry.kind == .artifact ? VaultEntry.appName(typed) : typed
            guard name != entry.name else { return }
            let (surfaceId, chosen) = (surfaceId, name)
            perform(name: chosen) { try await $0.rename(surfaceId, entry.id, to: chosen) }
        }
    }

    func delete(_ entry: VaultEntry) {
        let surfaceId = surfaceId
        perform { try await $0.delete(surfaceId, entry.id) }
    }

    func move(_ entry: VaultEntry) {
        guard let host else { return }
        let picker = VaultFolderPickerViewController(session: session, surfaceId: surfaceId, vaultName: vaultName, folder: nil, path: [],
                                                     moving: entry, action: Strings.Vaults.moveHere) { [weak self] parent in
            guard let self, parent.id != entry.parentId else { return }
            let surfaceId = surfaceId
            perform(name: entry.name) { try await $0.move(surfaceId, entry.id, to: parent) }
        }
        host.present(UINavigationController(rootViewController: picker), animated: true)
    }

    // MARK: Uploads

    func chooseFiles(into parent: String?) { pickDocuments(.files(parent: parent), types: [.item], many: true) }

    /// A file's next version is any file; an app's, an `.artifact` bundle,
    /// which the computer checks.
    func chooseNewVersion(of entry: VaultEntry) { pickDocuments(.version(entry), types: [.item], many: false) }

    private func pickDocuments(_ purpose: Picking, types: [UTType], many: Bool) {
        guard let host else { return }
        picking = purpose
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
        picker.allowsMultipleSelection = many
        picker.delegate = self
        host.present(picker, animated: true)
    }

    nonisolated func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        MainActor.assumeIsolated {
            guard let purpose = picking else { return }
            picking = nil
            let staged = urls.compactMap { url in Self.stage(url, name: url.lastPathComponent, move: true) }
            switch purpose {
            case .files(let parent): place(staged, into: parent)
            case .version(let entry):
                guard let file = staged.first else { return }
                Task { [library, surfaceId] in await library.upload(surfaceId, parentId: entry.parentId, file: file.url, name: entry.name, kind: entry.kind, replacing: entry.id) }
            }
        }
    }

    nonisolated func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        MainActor.assumeIsolated { picking = nil }
    }

    private var photosParent: String??

    func choosePhotos(into parent: String?) {
        guard let host else { return }
        var configuration = PHPickerConfiguration(photoLibrary: .shared())
        configuration.selectionLimit = 0
        configuration.selection = .ordered
        // The originals, as they are in the library.
        configuration.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = self
        photosParent = .some(parent)
        host.present(picker, animated: true)
    }

    nonisolated func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        let providers = results.map { SendableProvider(provider: $0.itemProvider) }
        MainActor.assumeIsolated {
            picker.dismiss(animated: true)
            guard case .some(let parent) = photosParent else { return }
            photosParent = nil
            Task { [weak self] in
                var staged: [(url: URL, name: String)] = []
                for item in providers {
                    if let file = await Self.load(item) { staged.append(file) }
                }
                self?.place(staged, into: parent)
            }
        }
    }

    private struct SendableProvider: @unchecked Sendable { let provider: NSItemProvider }

    /// The picked asset's original file, copied out of the callback it
    /// only lives in: a video as a movie, anything else as its image.
    private nonisolated static func load(_ item: SendableProvider) async -> (url: URL, name: String)? {
        let provider = item.provider
        let type = provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) ? UTType.movie : UTType.image
        let identifier = provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: type) == true } ?? type.identifier
        let suggested = provider.suggestedName
        return await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: identifier) { url, _ in
                guard let url else { return continuation.resume(returning: nil) }
                let ext = url.pathExtension
                let name = suggested.map { ext.isEmpty || $0.hasSuffix(".\(ext)") ? $0 : "\($0).\(ext)" } ?? url.lastPathComponent
                continuation.resume(returning: stage(url, name: name, move: false).map { ($0.url, $0.name) })
            }
        }
    }

    /// Where uploads wait for the library, which removes each once sent.
    private nonisolated static var staging: URL { FileManager.default.temporaryDirectory.appendingPathComponent("VaultUploads", isDirectory: true) }

    private nonisolated static func stage(_ url: URL, name: String, move: Bool) -> (url: URL, name: String)? {
        let folder = staging.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let target = folder.appendingPathComponent(name.isEmpty ? "file" : name)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            if move { try FileManager.default.moveItem(at: url, to: target) } else { try FileManager.default.copyItem(at: url, to: target) }
            return (target, target.lastPathComponent)
        } catch {
            return nil
        }
    }

    /// Uploads `files` into `parent`: one named `*.artifact` as an app,
    /// anything else as a file. A name already there asks whether to make
    /// a new version of it or keep both.
    private func place(_ files: [(url: URL, name: String)], into parent: String?) {
        let library = library, surfaceId = surfaceId
        Task { [weak self] in
            for file in files {
                guard let self else { return }
                let kind = VaultEntry.kind(named: file.name)
                let existing = await library.sibling(surfaceId, parentId: parent, named: file.name)
                if let existing, existing.kind == kind, await self.askReplace(existing.shownName) {
                    await library.upload(surfaceId, parentId: parent, file: file.url, name: existing.name, kind: kind, replacing: existing.id)
                } else {
                    let name = existing == nil ? file.name : await library.freeName(surfaceId, parentId: parent, for: file.name)
                    await library.upload(surfaceId, parentId: parent, file: file.url, name: name, kind: kind)
                }
            }
        }
    }

    /// Replace (a new version) or keep both.
    private func askReplace(_ name: String) async -> Bool {
        guard let host else { return false }
        return await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: Strings.Vaults.replaceTitle(name), message: Strings.Vaults.replaceMessage, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: Strings.Vaults.keepBoth, style: .default) { _ in continuation.resume(returning: false) })
            alert.addAction(UIAlertAction(title: Strings.Vaults.replace, style: .default) { _ in continuation.resume(returning: true) })
            (host.presentedViewController ?? host).present(alert, animated: true)
        }
    }

    // MARK: Sharing

    /// The entry's bytes in the share sheet: a file as itself, a folder or
    /// an app as its `.artifact` zip. `version` picks one of a file's or an app's.
    func share(_ entry: VaultEntry?, version: Int? = nil, from item: UIBarButtonItem? = nil, view: UIView? = nil) {
        let path: String
        let name: String
        switch entry?.kind {
        case nil:
            path = AgentClient.vaultZipPath(surfaceId, folderId: nil)
            name = "\(vaultName).zip"
        case .folder:
            path = AgentClient.vaultZipPath(surfaceId, folderId: entry!.id)
            name = "\(entry!.name).zip"
        case .artifact:
            // The `.artifact` bundle, which uploads back as it was.
            path = AgentClient.vaultArtifactZipPath(surfaceId, entry!.id, version: version ?? entry!.latestVersion ?? 1)
            name = entry!.name
        case .file:
            path = AgentClient.vaultContentPath(surfaceId, entry!.id, version: version) + "?download=true"
            name = entry!.name
        }
        // An app's file keeps `.artifact`, so it uploads back as one; people see its name without.
        let shown = VaultEntry.shownName(name)
        download(path, name: name, shown: shown) { [weak self] url in self?.present(share: url, title: shown, from: item, view: view) }
    }

    /// Reads `path` into a file of its own with a progress alert, which
    /// cancels it.
    func download(_ path: String, name: String, shown: String? = nil, done: @escaping (URL) -> Void) {
        guard let host else { return }
        let shown = shown ?? name
        let alert = UIAlertController(title: Strings.Vaults.downloading, message: shown, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Vaults.cancel, style: .cancel) { [weak self] _ in self?.downloading?.cancel() })
        host.present(alert, animated: true)
        let target = FileManager.default.temporaryDirectory.appendingPathComponent("VaultShare/\(UUID().uuidString)/\(name)")
        let client = session.client
        downloading = Task { [weak self, weak alert] in
            // Off the main actor: the client's read hops away on its own.
            let result: Result<Void, Error>
            do {
                try await client.download(path, to: target) { written, total in
                    let text = total.map { "\(VaultListItems.size(written)) / \(VaultListItems.size($0))" } ?? VaultListItems.size(written)
                    Task { @MainActor in alert?.message = "\(shown)\n\(text)" }
                }
                try Task.checkCancellation()
                result = .success(())
            } catch {
                try? FileManager.default.removeItem(at: target.deletingLastPathComponent())
                result = .failure(error)
            }
            guard let self else { return }
            let finish = {
                switch result {
                case .success: done(target)
                case .failure(let error): if !(error is CancellationError) { self.show(error) }
                }
            }
            if let alert, alert.presentingViewController != nil { alert.dismiss(animated: true, completion: finish) } else { finish() }
        }
    }

    private func present(share url: URL, title: String, from item: UIBarButtonItem?, view: UIView?) {
        guard let host else { return }
        let shared: Any = title == url.lastPathComponent ? url : SharedFile(url: url, title: title)
        let sheet = UIActivityViewController(activityItems: [shared], applicationActivities: nil)
        if let popover = sheet.popoverPresentationController {
            if let item { popover.barButtonItem = item } else {
                popover.sourceView = view ?? host.view
                popover.sourceRect = (view ?? host.view).bounds
            }
        }
        sheet.completionWithItemsHandler = { _, _, _, _ in
            Task.detached(priority: .utility) { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        }
        host.present(sheet, animated: true)
    }
}

/// A file in the share sheet under a name other than its own: an app's
/// `.artifact` file headed by the app's name.
private final class SharedFile: NSObject, UIActivityItemSource {
    let url: URL
    let title: String

    init(url: URL, title: String) {
        self.url = url
        self.title = title
    }

    func activityViewControllerPlaceholderItem(_ controller: UIActivityViewController) -> Any { url }

    func activityViewController(_ controller: UIActivityViewController, itemForActivityType activityType: UIActivity.ActivityType?) -> Any? { url }

    func activityViewController(_ controller: UIActivityViewController, subjectForActivityType activityType: UIActivity.ActivityType?) -> String { title }

    /// The app's name over its tile, as the list draws it; no URL, which
    /// would show the file's own name under it.
    func activityViewControllerLinkMetadata(_ controller: UIActivityViewController) -> LPLinkMetadata? {
        let metadata = LPLinkMetadata()
        metadata.title = title
        let side: CGFloat = 80
        let tile = UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { _ in
            UIColor(Palette.tileTealFill).setFill()
            UIBezierPath(roundedRect: CGRect(x: 0, y: 0, width: side, height: side), cornerRadius: 18).fill()
            Glyphs.image("globe-outline", size: 44).withTintColor(UIColor(Palette.tileTeal), renderingMode: .alwaysOriginal)
                .draw(in: CGRect(x: 18, y: 18, width: 44, height: 44))
        }
        metadata.iconProvider = NSItemProvider(object: tile)
        return metadata
    }
}
#endif
