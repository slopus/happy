#if canImport(UIKit)
import HappyCore
import HappyLayout
import SafariServices
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
}

/// Plugins' marks as a page's rows draw them: the picture once read (its
/// ThumbHash until then) over the plugin glyph, which keeps the icon's
/// lane and shows for a plugin without one. Each picture is asked for
/// once; `arrived` redraws the page when one comes.
@MainActor
final class PluginMarks {
    private let session: Session
    private let arrived: () -> Void
    private var pictures: [String: UIImage] = [:]
    private var asked: Set<String> = []

    init(session: Session, arrived: @escaping () -> Void) {
        self.session = session
        self.arrived = arrived
    }

    func apply(_ image: PluginImage?, to row: inout SettingsRow) {
        row.icon = ("plugin", .blue)
        guard let image else { return }
        row.squareImage = true
        row.image = pictures[image.path] ?? ThumbHashImages.image(image.thumbhash)
        guard asked.insert(image.path).inserted else { return }
        let pixels = Int(SettingsLayout.Metrics.tile * UIScreen.main.scale)
        Task { @MainActor [weak self, session] in
            guard let picture = await session.images.picture(image.path, thumbhash: image.thumbhash, pixels: pixels) else { return }
            self?.pictures[image.path] = picture
            self?.arrived()
        }
    }
}

/// Desktop's Plugins page (HappyAgentPluginsPage): what the team has
/// installed, then every plugin the server offers. A row opens the plugin.
/// Opened from home's Plugins row under Artifacts, on a Happy Cloud server.
final class PluginsViewController: SettingsPageViewController {
    private let session: Session
    private var watch: Watch?
    private lazy var marks = PluginMarks(session: session) { [weak self] in self?.reload() }

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

    private func mark(_ image: PluginImage?, in row: inout SettingsRow) { marks.apply(image, to: &row) }

    private func open(_ pluginId: String) {
        PluginScreens.open(pluginId: pluginId, session: session, from: self)
    }
}

/// Desktop's plugin page (HappyAgentPluginPage): what the plugin is, each
/// of the team's installations of it and what each still needs, then the
/// tools it gives agents. A manager installs it here, sets each
/// installation up by one of its plugin's methods (typed fields, or the
/// provider's page in the in-app browser, closed once it is active), signs
/// it out and removes it.
final class PluginViewController: SettingsPageViewController {
    let pluginId: String
    let session: Session
    private var watch: Watch?
    private lazy var marks = PluginMarks(session: session) { [weak self] in self?.reload() }
    /// The rows whose act is running: a spinner in place of their value.
    private(set) var busy: Set<String> = []
    /// The provider's page while a sign-in runs there, and the installation it is for.
    private var browser: (page: SFSafariViewController, installationId: String)?

    init(session: Session, pluginId: String) {
        self.session = session
        self.pluginId = pluginId
        super.init(title: session.plugins.state.catalog?.name(of: pluginId) ?? Strings.Plugins.title)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "plugin"
        watch = session.plugins.watch { [weak self] in self?.changed() }
    }

    private func changed() {
        guard let catalog = session.plugins.state.catalog else { return reload() }
        title = catalog.name(of: pluginId)
        // Signed in on the provider's page: the server says so, and the page goes.
        if let browser, catalog.installations?.first(where: { $0.id == browser.installationId })?.status == .active {
            self.browser = nil
            browser.page.dismiss(animated: true)
        }
        reload()
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
        if let plugin, catalog.canManage {
            cards.append([acting(SettingsRow(id: "plugin-install", title: installations.isEmpty ? Text.install : Text.installAgain, icon: ("add", .action),
                                             accessory: .none, action: { [weak self] in self?.install(plugin) }))])
        }
        for installation in installations {
            cards.append(card(installation, catalog: catalog))
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

    /// One installation: its state, then what a manager can do with it.
    private func card(_ installation: PluginInstallation, catalog: PluginCatalog) -> [SettingsRow] {
        typealias Text = Strings.Plugins
        let id = installation.id
        var status = SettingsRow(id: "installation-\(id)-status", title: Text.status, value: Text.status(installation), accessory: .none)
        status.header = installation.title
        status.dimmed = !installation.available
        var card = [status]
        if catalog.canManage, installation.available {
            if case .signIn(let methods) = catalog.setup(installation) {
                for method in methods {
                    card.append(acting(SettingsRow(id: "installation-\(id)-method-\(method.id)", title: Text.setUp(with: method.label), icon: (Self.glyph(method), .action),
                                                   accessory: .none, action: { [weak self] in self?.setUp(installation, method: method) })))
                }
            }
            if installation.isSignedIn {
                card.append(acting(SettingsRow(id: "installation-\(id)-sign-out", title: Text.signOut, icon: ("log-out-outline", .action), accessory: .none,
                                               action: { [weak self] in self?.signOut(installation) })))
            }
            card.append(acting(SettingsRow(id: "installation-\(id)-remove", title: Text.remove, icon: ("trash", .action), accessory: .none, destructive: true,
                                           action: { [weak self] in self?.confirmRemove(installation) })))
        }
        card[card.count - 1].footer = installation.toolPrefix.isEmpty ? nil : Text.toolPrefix(installation.toolPrefix)
        return card
    }

    private static func glyph(_ method: PluginAuthMethod) -> String {
        if case .oauth = method { return "globe-outline" }
        return "key-outline"
    }

    /// A row whose act is running shows a spinner and does nothing more.
    private func acting(_ row: SettingsRow) -> SettingsRow {
        guard busy.contains(row.id) else { return row }
        var row = row
        let spinner = UIActivityIndicatorView(style: .medium)
        spinner.startAnimating()
        row.valueView = spinner
        row.action = nil
        return row
    }

    private func mark(_ image: PluginImage?, in row: inout SettingsRow) { marks.apply(image, to: &row) }

    // MARK: Acts

    /// Runs `act` with `row` spinning; a refusal is said under `failure`.
    private func run<T: Sendable>(_ row: String, failure: String, _ act: @escaping @Sendable (AgentClient) async throws -> T, then: @escaping (T) -> Void = { _ in }) {
        guard !busy.contains(row) else { return }
        busy.insert(row)
        reload()
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let value = try await session.plugins.write(act)
                busy.remove(row)
                reload()
                then(value)
            } catch {
                busy.remove(row)
                reload()
                Alerts.show(failure, Strings.Plugins.words(error), on: self)
            }
        }
    }

    /// Installs it once more; an installation with one way to set it up
    /// goes straight to it.
    func install(_ plugin: Plugin) {
        let pluginId = plugin.id
        run("plugin-install", failure: Strings.Plugins.installFailed, { try await $0.installPlugin(pluginId) }) { [weak self] installation in
            guard installation.status != .active, plugin.authMethods.count == 1, let method = plugin.authMethods.first else { return }
            self?.setUp(installation, method: method)
        }
    }

    func setUp(_ installation: PluginInstallation, method: PluginAuthMethod) {
        switch method {
        case .fields(_, let label, let fields):
            let form = FieldsFormViewController(title: label, fields: fields.map(FieldsFormViewController.Field.init), footer: Strings.Plugins.setupHint,
                                               action: Strings.Plugins.connect, failure: Strings.Plugins.setupFailed, words: Strings.Plugins.words) { [weak self] values in
                guard let self else { throw CancellationError() }
                let id = installation.id
                _ = try await session.plugins.write { try await $0.configurePluginInstallation(id, method: method.id, values: values) }
            }
            navigationController?.pushViewController(form, animated: true)
        case .oauth:
            let id = installation.id
            run("installation-\(id)-method-\(method.id)", failure: Strings.Plugins.connectFailed, { try await $0.connectPluginInstallation(id, method: method.id) }) { [weak self] url in
                self?.openSignIn(url, installationId: id)
            }
        }
    }

    /// The provider's page in the app's own browser. The server finishes
    /// the sign-in; `plugins.changed` says so and the page goes
    /// (`changed`). Closed by hand, the list is read again.
    private func openSignIn(_ url: URL, installationId: String) {
        let page = SFSafariViewController(url: url)
        page.dismissButtonStyle = .close
        page.delegate = self
        browser = (page, installationId)
        present(page, animated: true)
    }

    func signOut(_ installation: PluginInstallation) {
        let id = installation.id
        run("installation-\(id)-sign-out", failure: Strings.Plugins.signOutFailed) { try await $0.disconnectPluginInstallation(id) }
    }

    func confirmRemove(_ installation: PluginInstallation) {
        typealias Text = Strings.Plugins
        let alert = UIAlertController(title: Text.removeTitle(installation.title), message: Text.removeMessage, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel))
        alert.addAction(UIAlertAction(title: Text.removeConfirm, style: .destructive) { [weak self] _ in self?.remove(installation) })
        present(alert, animated: true)
    }

    func remove(_ installation: PluginInstallation) {
        let id = installation.id
        run("installation-\(id)-remove", failure: Strings.Plugins.removeFailed) { try await $0.removePluginInstallation(id) }
    }
}

extension PluginViewController: @MainActor SFSafariViewControllerDelegate {
    func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
        browser = nil
        session.plugins.load()
    }
}

extension FieldsFormViewController.Field {
    init(_ field: PluginAuthMethod.Field) {
        self.init(key: field.key, label: field.label, help: field.help, required: field.required, secret: field.secret)
    }
}

extension PluginFieldsRefusal: FieldsRefusal {}
#endif
