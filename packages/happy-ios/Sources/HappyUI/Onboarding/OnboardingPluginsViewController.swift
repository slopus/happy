#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The plugins gate: the plugins the server needs connected, then every
/// other one it offers, each a row with Set Up, or Connected with a check
/// once it has an active installation. Set Up opens the plugin's own page
/// on the flow (`PluginScreens.open`), where it is installed and signed
/// in as from Plugins. A change to what is connected reads onboarding
/// again, and once the server says the gate is done the flow moves on.
/// Skip for Now while optional. Once something is connected here and
/// nothing needed is left, the step stays for more (`holds`), with
/// Continue in Skip's place.
final class OnboardingPluginsViewController: CloudStageViewController, OnboardingStepScreen {
    private let session: Session
    private let gate: OnboardingGate.Plugins
    private var watch: Watch?
    private var rows: [String: CloudServerRow] = [:]
    private var order: [String] = []
    private let spinner = UIActivityIndicatorView(style: .medium)
    let status = CloudStageViewController.bodyLabel("")
    private var pictures: [String: UIImage] = [:]
    private var asked: Set<String> = []
    /// What was connected when onboarding was last read for it.
    private var connected: Set<String>?
    /// Plugins connected while the step was on screen: it stays for more
    /// (`holds`) until Continue.
    private var connectedHere = false
    private var letGo = false
    /// Lets the flow go on to the next step (Continue).
    var released: (() -> Void)?

    init(context: AppContext, session: Session, plugins: OnboardingGate.Plugins, optional: Bool) {
        self.session = session
        gate = plugins
        let needed = plugins.plugins.filter { $0.required && !$0.active }.map(\.name)
        super.init(context: context, scene: .wand, title: Strings.CloudOnboarding.pluginsTitle, body: Strings.CloudOnboarding.pluginsBody(needed: needed),
                   primary: Strings.CloudOnboarding.tryAgain, secondary: optional ? Strings.CloudOnboarding.skip : nil)
        pinsActions = true
        keepsActionRoom = false
    }

    var holds: Bool { connectedHere && !letGo }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "onboarding-plugins"
        primary.accessibilityIdentifier = "onboarding-primary"
        secondary?.accessibilityIdentifier = "onboarding-secondary"
        primary.isHidden = true
        primary.action = { [weak self] in
            guard let self else { return }
            if action(for: session.plugins.state) == .more { letGo = true; released?() } else { session.plugins.load() }
        }
        spinner.color = StartViewController.Colors.text
        status.textColor = UIColor(Palette.textDestructive)
        for subview in [spinner, status] as [UIView] { content.addSubview(subview) }
        watch = session.plugins.watch { [weak self] in self?.changed() }
        changed()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Back from a plugin's page.
        session.plugins.load()
    }

    private func changed() {
        let state = session.plugins.state
        if state == .loading, rows.isEmpty { spinner.startAnimating() } else { spinner.stopAnimating() }
        rebuild(state.catalog)
        // Connected here or anywhere (or before the gate was read): the
        // server says what the gate makes of it.
        if let catalog = state.catalog {
            let now = Set(gate.rows(catalog).filter(\.active).map(\.id))
            if let before = connected, !now.subtracting(before).isEmpty { connectedHere = true }
            if now != connected {
                connected = now
                Task { [session] in _ = try? await session.readOnboarding() }
            }
        }
        update()
    }

    private enum Action { case none, retry, more }

    /// Try Again after a failed read; Continue once what is needed is
    /// connected here, with more to connect, in Skip's place.
    private func action(for state: PluginsModel.State) -> Action {
        if state == .failed { return .retry }
        guard connectedHere, let catalog = state.catalog else { return .none }
        return gate.rows(catalog).allSatisfy { !$0.required || $0.active } ? .more : .none
    }

    private func update() {
        let offered = action(for: session.plugins.state)
        primary.isHidden = offered == .none
        primary.title = offered == .more ? Strings.CloudConnect.continueAction : Strings.CloudOnboarding.tryAgain
        secondary?.isHidden = offered == .more
        say(offered == .retry ? Strings.CloudOnboarding.pluginsFailed : nil)
    }

    private func rebuild(_ catalog: PluginCatalog?) {
        let plugins = gate.rows(catalog)
        if plugins.map(\.id) != order {
            rows.values.forEach { $0.removeFromSuperview() }
            rows = [:]
            order = plugins.map(\.id)
            for id in order {
                let row = CloudServerRow(action: Strings.CloudOnboarding.setUp, done: Strings.CloudOnboarding.connected)
                row.subtitleLines = 2
                row.compactButton = true
                row.picture.layer.cornerRadius = 12
                row.picture.layer.cornerCurve = .continuous
                row.join.accessibilityIdentifier = "onboarding-plugin-\(id)"
                row.join.onTap = { [weak self] in self?.open(id) }
                content.addSubview(row)
                rows[id] = row
            }
        }
        for plugin in plugins {
            guard let row = rows[plugin.id] else { continue }
            let offered = catalog?.plugin(plugin.id)
            let name = offered?.name ?? plugin.name
            row.title.string = name
            row.joinLabel = "\(Strings.CloudOnboarding.setUp) \(name)"
            row.subtitle.string = plugin.required ? Strings.CloudOnboarding.neededPlugin
                : offered.map { $0.description.isEmpty ? Strings.Plugins.version($0.version) : $0.description } ?? ""
            row.state = plugin.active ? .joined : .join
            row.picture.image = picture(offered?.image ?? catalog?.installations(of: plugin.id).first?.image)
        }
        relayout()
    }

    private func open(_ pluginId: String) {
        PluginScreens.open(pluginId: pluginId, session: session, from: self)
    }

    /// Its picture once read, its ThumbHash until then, else the plugin glyph.
    private func picture(_ image: PluginImage?) -> UIImage? {
        guard let image else { return Self.glyph }
        if let picture = pictures[image.path] { return picture }
        if asked.insert(image.path).inserted {
            let pixels = Int(CloudServerRowLayout.Metrics.picture * UIScreen.main.scale)
            Task { @MainActor [weak self, session] in
                guard let picture = await session.images.picture(image.path, thumbhash: image.thumbhash, pixels: pixels) else { return }
                self?.pictures[image.path] = picture
                self?.rebuild(self?.session.plugins.state.catalog)
            }
        }
        return ThumbHashImages.image(image.thumbhash) ?? Self.glyph
    }

    private static let glyph: UIImage? = {
        let side = CloudServerRowLayout.Metrics.picture
        let symbol = UIImage(systemName: "puzzlepiece.extension.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 22, weight: .medium))?
            .withTintColor(UIColor(Palette.startText), renderingMode: .alwaysOriginal)
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { _ in
            UIColor(Palette.startDot).setFill()
            UIRectFill(CGRect(x: 0, y: 0, width: side, height: side))
            guard let symbol else { return }
            symbol.draw(at: CGPoint(x: (side - symbol.size.width) / 2, y: (side - symbol.size.height) / 2))
        }
    }()

    func say(_ problem: String?) {
        status.string = problem ?? ""
        relayout()
    }

    /// The rows, the spinner while the list is first read, and the status
    /// line in room kept for it; they scroll under the title while Skip
    /// stays put (`pinsActions`).
    private func items(width: CGFloat, steady: Bool = false) -> [CloudColumnLayout.Item] {
        let rowItems = order.map { CloudColumnLayout.Item(height: rows[$0]?.height ?? CloudServerRowLayout.height(subtitleLines: 2), gap: 12) }
        return rowItems + [
            .init(size: CGSize(width: 44, height: spinner.isAnimating ? 44 : 0), gap: 12, centred: true),
            .init(height: steady ? Self.statusRoom : Self.statusHeight(status, width: width), gap: 16),
        ]
    }

    override func contentHeight(width: CGFloat) -> CGFloat { CloudColumnLayout.stack(items(width: width), width: width).height }
    override func steadyContentHeight(width: CGFloat) -> CGFloat { CloudColumnLayout.stack(items(width: width, steady: true), width: width).height }

    override func layoutContent() {
        let frames = CloudColumnLayout.stack(items(width: content.bounds.width), width: content.bounds.width).frames
        for (index, id) in order.enumerated() { rows[id]?.setLayoutFrame(frames[index]) }
        spinner.setLayoutFrame(frames[frames.count - 2])
        status.setLayoutFrame(frames[frames.count - 1])
    }
}
#endif
