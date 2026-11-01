#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Telegram's Data and Storage, for one account: Connection on top (where
/// Telegram has Network Usage and Proxy), what its kept media takes on this
/// phone (read off the main thread), Clear Media, and
/// Automatic Media Download's switches and size limits, one setting for
/// every network.
final class DataStorageViewController: SettingsPageViewController {
    private let library: MediaLibrary?
    private let defaults: UserDefaults
    /// The Connection page, made when its row is tapped; nil hides the row.
    private let connection: (() -> UIViewController?)?
    private var usage: Int64?
    private var rules: MediaAutoDownload
    private var clearing = false

    init(library: MediaLibrary?, defaults: UserDefaults = .standard, connection: (() -> UIViewController?)? = nil) {
        self.library = library
        self.defaults = defaults
        self.connection = connection
        rules = MediaAutoDownload.load(defaults)
        super.init(title: Strings.DataStorage.title)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        measure()
    }

    /// Reads the size kept, off the main thread.
    func measure() {
        guard let library else { return }
        Task { @MainActor [weak self] in
            let bytes = await Task.detached(priority: .userInitiated) { library.usage() }.value
            self?.usage = bytes
            self?.reload()
        }
    }

    /// The size kept, once read; for tests.
    var shownUsage: Int64? { usage }

    override func makeRows() -> [[SettingsRow]] {
        typealias Row = SettingsRow
        typealias Text = Strings.DataStorage
        let size = usage.map { MediaSizeText.size(Int($0)) } ?? Text.calculating
        let storage = [
            Row(id: "storage-usage", title: Text.storageUsage, icon: ("folder-outline", .blue), value: size, accessory: .none),
            Row(id: "clear-media", title: Text.clearMedia, accessory: .none, destructive: true, action: (library == nil || clearing || usage == 0) ? nil : { [weak self] in self?.confirmClear() },
                footer: Text.clearMediaFooter),
        ]
        var automatic: [Row] = []
        for kind in MediaAutoDownload.Kind.allCases {
            let rule = rules[kind]
            let (title, glyph, tile): (String, String, Row.Tile) = switch kind {
            case .photos: (Text.photos, "image-outline", .orange)
            case .videos: (Text.videos, "videocam", .purple)
            case .files: (Text.files, "document-outline", .green)
            }
            automatic.append(Row(id: "auto-\(kind.rawValue)", title: title, icon: (glyph, tile), accessory: .toggle, isOn: rule.enabled, toggled: { [weak self] on in
                self?.change(kind) { $0.enabled = on }
            }))
            if rule.enabled {
                automatic.append(Row(id: "auto-\(kind.rawValue)-limit", title: Text.limit, value: Text.limitValue(rule.limit), action: { [weak self] in self?.chooseLimit(kind) }))
            }
        }
        automatic[automatic.count - 1].footer = Text.autoDownloadFooter
        guard connection != nil else { return [storage, automatic] }
        return [[Row(SettingsIndex.connection, action: { [weak self] in self?.openConnection() })], storage, automatic]
    }

    private func openConnection() {
        guard let page = connection?() else { return }
        navigationController?.pushViewController(page, animated: true)
    }

    private func change(_ kind: MediaAutoDownload.Kind, _ edit: (inout MediaAutoDownload.Rule) -> Void) {
        edit(&rules[kind])
        rules.save(defaults)
    }

    /// The sizes on offer, the current one ticked.
    private func chooseLimit(_ kind: MediaAutoDownload.Kind) {
        let page = SettingsPageViewController(title: Strings.DataStorage.limit) { [weak self] in
            guard let self else { return [] }
            return [MediaAutoDownload.limits.map { limit in
                SettingsRow(id: "limit-\(limit)", title: Strings.DataStorage.limitValue(limit), value: self.rules[kind].limit == limit ? "✓" : nil, accessory: .none, action: { [weak self] in
                    self?.change(kind) { $0.limit = limit }
                    self?.reload()
                    self?.navigationController?.popViewController(animated: true)
                })
            }]
        }
        navigationController?.pushViewController(page, animated: true)
    }

    private func confirmClear() {
        let size = usage.map { MediaSizeText.size(Int($0)) } ?? ""
        let sheet = UIAlertController(title: nil, message: Strings.DataStorage.clearConfirm(size), preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: Strings.DataStorage.clear, style: .destructive) { [weak self] _ in self?.clear() })
        sheet.addAction(UIAlertAction(title: Strings.cancel, style: .cancel))
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        }
        present(sheet, animated: true)
    }

    /// Empties the account's media; what is open reads it again when shown.
    func clear() {
        guard let library, !clearing else { return }
        clearing = true
        reload()
        Task { @MainActor [weak self] in
            await library.clear()
            self?.clearing = false
            self?.measure()
        }
    }
}
#endif
