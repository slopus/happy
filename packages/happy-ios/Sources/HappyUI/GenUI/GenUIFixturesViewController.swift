#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Developer › Gen UI fixtures: every compiled render document the app
/// bundles (`Tests/HappyCoreTests/Fixtures/GenUI`, the `GenUI` folder of the
/// app bundle), each drawn by the real renderer on the chat's ground.
/// Reached from Settings' About card once developer mode is on (ten taps
/// on Version). Nothing is wired to a chat: a tap reports what the host
/// would be asked to do, in an alert.
final class GenUIFixturesViewController: SettingsPageViewController {
    static var folder: URL? {
        Bundle.main.resourceURL.map { $0.appendingPathComponent("GenUI") }.flatMap { FileManager.default.fileExists(atPath: $0.path) ? $0 : nil }
    }

    /// The documents' names, `01-stats` for `01-stats.render.json`, sorted.
    static var names: [String] {
        guard let folder, let files = try? FileManager.default.contentsOfDirectory(atPath: folder.path) else { return [] }
        return files.filter { $0.hasSuffix(".render.json") }.map { String($0.dropLast(".render.json".count)) }.sorted()
    }

    init() {
        weak var page: GenUIFixturesViewController?
        super.init(title: "Gen UI fixtures") {
            let rows = GenUIFixturesViewController.names.map { name in
                SettingsRow(id: "genui-\(name)", title: name, action: {
                    page?.navigationController?.pushViewController(GenUIFixtureViewController(name: name), animated: true)
                })
            }
            return [rows.isEmpty ? [SettingsRow(id: "genui-none", title: "No fixtures in this build", accessory: .none)] : rows]
        }
        page = self
    }
}

/// One fixture as a block of an agent's message, scrolling when it is
/// taller than the screen. Light and dark follow the system.
final class GenUIFixtureViewController: UIViewController {
    private let name: String
    private let document: GenUIRenderDocument
    private let scroll = UIScrollView()
    private let block = GenUIBlockView()
    private var width: CGFloat?

    init(name: String) {
        self.name = name
        let url = GenUIFixturesViewController.folder?.appendingPathComponent("\(name).render.json")
        document = url.flatMap { try? Data(contentsOf: $0) }.flatMap(GenUIRenderDocument.parse)
            ?? GenUIRenderDocument(fallback: "Can't read the Gen UI fixture \(name).", root: nil, elements: [:])
        super.init(nibName: nil, bundle: nil)
        title = name
        block.interaction.onAction = { [weak self] key, action in self?.report("Action", "\(key)\n\(action)") }
        block.interaction.onViewer = { [weak self] key, group, index in self?.report("Image viewer", "\(key)\n\(group) #\(index)") }
        block.onHeight = { [weak self] _ in self?.view.setNeedsLayout() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.surface)
        scroll.alwaysBounceVertical = true
        view.addSubview(scroll)
        scroll.addSubview(block)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        scroll.frame = view.bounds
        let margin = MessageLayout.Metrics.marginH
        let width = max(0, scroll.bounds.width - scroll.safeAreaInsets.left - scroll.safeAreaInsets.right - 2 * margin)
        if width != self.width {
            self.width = width
            let traits = GenUITraits(text: nil, displayScale: traitCollection.displayScale)
            block.load(document, width: width, traits: traits, files: GenUIFixturesViewController.folder.map(GenUIFolderFiles.init))
        }
        let height = block.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        block.frame = CGRect(x: scroll.safeAreaInsets.left + margin, y: margin, width: width, height: height)
        scroll.contentSize = CGSize(width: scroll.bounds.width, height: height + 2 * margin)
    }

    private func report(_ title: String, _ message: String) {
        Alerts.show(title, message, on: self)
    }
}
#endif
