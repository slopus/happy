#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The ways into a Happy Cloud server's plugins.
@MainActor
enum PluginScreens {
    /// Opens one plugin's page on `session` from `controller`: a Gen UI
    /// `plugin` action, a plugins gate in onboarding, a row of the list.
    /// Pushed on the controller's navigation; presented in one of its own
    /// when it has none.
    static func open(pluginId: String, session: Session, from controller: UIViewController) {
        let page = PluginViewController(session: session, pluginId: pluginId)
        if let navigation = controller.navigationController ?? (controller as? UINavigationController) {
            navigation.pushViewController(page, animated: true)
            return
        }
        page.navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak page] _ in
            page?.dismiss(animated: true)
        })
        let navigation = UINavigationController(rootViewController: page)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        controller.present(navigation, animated: true)
    }

    /// A plugin's or an installation's mark as a row draws it: the
    /// picture once read (its ThumbHash until then), the plugin glyph on a
    /// tile without one. Reading it calls `arrived` once it's in.
    static func mark(_ image: PluginImage?, in row: inout SettingsRow, session: Session, arrived: @escaping () -> Void) {
        // The glyph keeps the icon's lane, and shows while there is no picture.
        row.icon = ("plugin", .blue)
        guard let image else { return }
        let pixels = Int(SettingsLayout.Metrics.tile * UIScreen.main.scale)
        row.squareImage = true
        if let picture = session.images.cachedPicture(image.path, thumbhash: image.thumbhash, pixels: pixels) {
            row.image = picture
            return
        }
        row.image = ThumbHashImages.image(image.thumbhash)
        Task { @MainActor in
            if await session.images.picture(image.path, thumbhash: image.thumbhash, pixels: pixels) != nil { arrived() }
        }
    }
}

/// Desktop's Plugins page (HappyAgentPluginsPage): what the team has
/// installed, then every plugin the server offers. A row opens the plugin.
/// Opened from home's Plugins row under Artifacts, on a Happy Cloud server.
final class PluginsViewController: SettingsPageViewController {
    private let session: Session
    private var watch: Watch?
    private var marksAsked: Set<String> = []

    init(session: Session) {
        self.session = session
        super.init(title: Strings.Plugins.title)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "plugins"
        watch = session.plugins.watch { [weak self] in self?.reload() }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        session.plugins.load()
    }

    override func makeRows() -> [[SettingsRow]] {
        typealias Text = Strings.Plugins
        switch session.plugins.state {
        case .loading:
            return [[SettingsRow(id: "plugins-loading", title: Text.loading, accessory: .none, dimmed: true)]]
        case .failed:
            return [[
                SettingsRow(id: "plugins-failed", title: Text.loadFailed, accessory: .none, dimmed: true),
                SettingsRow(id: "plugins-retry", title: Text.tryAgain, icon: ("refresh", .action), accessory: .none, action: { [weak self] in self?.session.plugins.load() }),
            ]]
        case .loaded(let catalog):
            return cards(catalog)
        }
    }

    private func cards(_ catalog: PluginCatalog) -> [[SettingsRow]] {
        typealias Text = Strings.Plugins
        var cards: [[SettingsRow]] = []
        if let installations = catalog.installations, catalog.canManage || !installations.isEmpty {
            var card = installations.map { installation in
                var row = SettingsRow(id: "installation-\(installation.id)", title: installation.title, action: { [weak self] in self?.open(installation.pluginId) })
                row.subtitle = Text.status(installation)
                row.dimmed = !installation.available
                mark(installation.image ?? catalog.plugin(installation.pluginId)?.image, in: &row)
                return row
            }
            if card.isEmpty {
                card = [SettingsRow(id: "plugins-installed-empty", title: Text.nothingInstalled, accessory: .none, dimmed: true)]
                card[0].footer = Text.nothingInstalledHint
            }
            card[0].header = Text.installed
            cards.append(card)
        }
        var available = catalog.plugins.map { plugin in
            var row = SettingsRow(id: "plugin-\(plugin.id)", title: plugin.name,
                                  value: catalog.installations(of: plugin.id).isEmpty ? nil : Text.installedValue,
                                  action: { [weak self] in self?.open(plugin.id) })
            row.subtitle = plugin.description.isEmpty ? Text.version(plugin.version) : plugin.description
            row.subtitleLines = 2
            mark(plugin.image, in: &row)
            return row
        }
        if available.isEmpty { available = [SettingsRow(id: "plugins-none", title: Text.noneOffered, accessory: .none, dimmed: true)] }
        available[0].header = Text.available
        if !catalog.canManage { available[available.count - 1].footer = Text.membersCantInstall }
        cards.append(available)
        return cards
    }

    private func mark(_ image: PluginImage?, in row: inout SettingsRow) {
        let asked = image.map { !marksAsked.insert($0.path).inserted } ?? true
        PluginScreens.mark(image, in: &row, session: session) { [weak self] in
            if !asked { self?.reload() }
        }
    }

    private func open(_ pluginId: String) {
        PluginScreens.open(pluginId: pluginId, session: session, from: self)
    }
}

/// Desktop's plugin page (HappyAgentPluginPage): what the plugin is, each
/// of the team's installations of it and what each still needs, then the
/// tools it gives agents.
final class PluginViewController: SettingsPageViewController {
    let pluginId: String
    let session: Session
    private var watch: Watch?
    private var marksAsked: Set<String> = []

    init(session: Session, pluginId: String) {
        self.session = session
        self.pluginId = pluginId
        super.init(title: session.plugins.state.catalog?.name(of: pluginId) ?? Strings.Plugins.title)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "plugin"
        watch = session.plugins.watch { [weak self] in
            guard let self else { return }
            if let catalog = session.plugins.state.catalog { title = catalog.name(of: pluginId) }
            reload()
        }
    }

    override func makeRows() -> [[SettingsRow]] {
        typealias Text = Strings.Plugins
        switch session.plugins.state {
        case .loading:
            return [[SettingsRow(id: "plugin-loading", title: Text.loading, accessory: .none, dimmed: true)]]
        case .failed:
            return [[
                SettingsRow(id: "plugin-failed", title: Text.loadFailed, accessory: .none, dimmed: true),
                SettingsRow(id: "plugin-retry", title: Text.tryAgain, icon: ("refresh", .action), accessory: .none, action: { [weak self] in self?.session.plugins.load() }),
            ]]
        case .loaded(let catalog):
            return cards(catalog)
        }
    }

    func cards(_ catalog: PluginCatalog) -> [[SettingsRow]] {
        typealias Text = Strings.Plugins
        let plugin = catalog.plugin(pluginId)
        let installations = catalog.installations(of: pluginId)
        guard plugin != nil || !installations.isEmpty else {
            return [[SettingsRow(id: "plugin-missing", title: Text.notOffered, accessory: .none, dimmed: true)]]
        }
        var head = SettingsRow(id: "plugin-head", title: catalog.name(of: pluginId), accessory: .none)
        head.subtitle = plugin.map { Text.version($0.version) }
        mark(plugin?.image ?? installations.first?.image, in: &head)
        let about: String? = if let plugin { plugin.description.isEmpty ? nil : plugin.description } else { Text.noLongerOffered }
        head.footer = [about, catalog.canManage ? nil : Text.membersCantSetUp].compactMap { $0 }.joined(separator: "\n\n")
        var cards: [[SettingsRow]] = [[head]]
        for installation in installations {
            var status = SettingsRow(id: "installation-\(installation.id)-status", title: Text.status, value: Text.status(installation), accessory: .none)
            status.header = installation.title
            status.dimmed = !installation.available
            status.footer = installation.toolPrefix.isEmpty ? nil : Text.toolPrefix(installation.toolPrefix)
            cards.append([status])
        }
        if let tools = plugin?.tools, !tools.isEmpty {
            var card = tools.map { tool in
                var row = SettingsRow(id: "tool-\(tool.name)", title: tool.name, accessory: .none)
                row.subtitle = tool.summary.isEmpty ? nil : tool.summary
                row.subtitleLines = 0
                return row
            }
            card[0].header = Text.tools
            cards.append(card)
        }
        return cards
    }

    private func mark(_ image: PluginImage?, in row: inout SettingsRow) {
        let asked = image.map { !marksAsked.insert($0.path).inserted } ?? true
        PluginScreens.mark(image, in: &row, session: session) { [weak self] in
            if !asked { self?.reload() }
        }
    }
}
#endif
