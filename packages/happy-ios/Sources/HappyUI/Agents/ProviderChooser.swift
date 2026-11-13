#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
import UIKit

/// Adding an inference provider on a Happy Cloud server, from any screen
/// (`host`): the chooser of the ways the server runs (`offer`) and the
/// role allows, where it goes when the role leaves a choice, then the way
/// itself (`ProviderFlows`). Settings › Inference and onboarding's
/// inference step share it.
@MainActor
final class ProviderChooser {
    private let session: Session
    private weak var host: UIViewController?
    private let added: () -> Void
    private let changed: () -> Void
    /// The sign-ins the server runs (`codex`, `claude`); empty until read,
    /// and when it has none yet.
    var offer = CloudAddOffer()

    init(session: Session, host: UIViewController, added: @escaping () -> Void, changed: @escaping () -> Void = {}) {
        self.session = session
        self.host = host
        self.added = added
        self.changed = changed
    }

    /// The families the chooser lists: what the server runs, and Custom
    /// where the role may add for the team.
    var families: [ProviderFamily] {
        ProviderFamily.offered(offer, custom: CloudProvider.destinations(session.gate).contains(.team))
    }

    func choose(destination: CloudProvider.Destination? = nil) {
        let navigation = UINavigationController(rootViewController: chooser(destination: destination))
        if let sheet = navigation.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
        }
        host?.present(navigation, animated: true)
    }

    /// The families, each with a line for its ways; one with two ways
    /// asks which next, in the same sheet.
    func chooser(destination: CloudProvider.Destination? = nil) -> SettingsPageViewController {
        typealias Text = Strings.Providers
        let families = families
        let page = SettingsPageViewController(title: Text.add) { [weak self] in
            [families.map { family in
                var row = SettingsRow(id: "provider-family-\(family.kind.rawValue)", title: Text.family(family.kind))
                row.subtitle = Text.ways(family)
                Self.mark(family.kind, on: &row)
                row.accessory = family.methods.count > 1 ? .chevron : .none
                row.action = { self?.pick(family, destination: destination) }
                return row
            }]
        }
        page.navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak page] _ in
            page?.dismiss(animated: true)
        })
        return page
    }

    private func pick(_ family: ProviderFamily, destination: CloudProvider.Destination?) {
        if family.methods.count == 1, let method = family.methods.first { return add(method, destination: destination) }
        typealias Text = Strings.Providers
        let ways = SettingsPageViewController(title: Text.family(family.kind)) { [weak self] in
            [family.methods.map { method in
                var row = SettingsRow(id: "provider-method-\(Self.id(method))", title: Text.method(method).title, accessory: .none)
                row.subtitle = Text.method(method).detail
                row.subtitleLines = 2
                row.action = { self?.add(method, destination: destination) }
                return row
            }]
        }
        (host?.presentedViewController as? UINavigationController)?.pushViewController(ways, animated: true)
    }

    /// The sheet goes first: each way opens over the screen it came from.
    private func add(_ method: ProviderFamily.Method, destination: CloudProvider.Destination?) {
        let go = { [weak self] in
            guard let self else { return }
            switch method {
            case .signIn: open(.providersAddOpenAI, destination: destination)
            case .setupToken: open(.providersAddAnthropic, destination: destination)
            case .apiKey(let vendor): open(.providersAddAPIKey, vendor: vendor, destination: destination)
            case .custom: addCustom()
            }
        }
        guard let sheet = host?.presentedViewController else { return go() }
        sheet.dismiss(animated: true, completion: go)
    }

    private static func id(_ method: ProviderFamily.Method) -> String {
        switch method {
        case .signIn: "sign-in"
        case .setupToken: "setup-token"
        case .apiKey(let vendor): "api-key-\(vendor)"
        case .custom: "custom"
        }
    }

    /// ChatGPT's and Claude's own marks on a tile; Grok and Custom a glyph.
    private static func mark(_ kind: ProviderFamily.Kind, on row: inout SettingsRow) {
        switch kind {
        case .chatGPT: row.icon = ("sparkles-outline", .green); row.image = chatGPTTile
        case .claude: row.icon = ("sparkles-outline", .orange); row.image = claudeTile
        case .grok: row.icon = ("flash-outline", .gray)
        case .custom: row.icon = ("code-slash-outline", .blue)
        }
        row.squareImage = row.image != nil
    }

    // Drawn once: a new picture on every reload would dissolve in again.
    private static let chatGPTTile = tile("icon-gpt", Palette.settingsTileGreen)
    private static let claudeTile = tile("icon-claude", Palette.settingsTileOrange)

    private static func tile(_ name: String, _ fill: ColorToken) -> UIImage? {
        guard let mark = UIImage.happy(name) else { return nil }
        let side = SettingsLayout.Metrics.tile, size = SettingsLayout.Metrics.glyph * 0.9
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { _ in
            UIColor(fill).setFill()
            UIBezierPath(roundedRect: CGRect(x: 0, y: 0, width: side, height: side), cornerRadius: SettingsLayout.Metrics.tileRadius).fill()
            let fit = min(size / mark.size.width, size / mark.size.height)
            let drawn = CGSize(width: mark.size.width * fit, height: mark.size.height * fit)
            mark.withTintColor(.white, renderingMode: .alwaysOriginal)
                .draw(in: CGRect(x: (side - drawn.width) / 2, y: (side - drawn.height) / 2, width: drawn.width, height: drawn.height))
        }
    }

    /// The team's own provider: owners with `providers.manage` only.
    func addCustom() {
        guard let host else { return }
        ProviderFlows(client: session.client, destination: .team, host: host) { [weak self] in self?.added() }.addCustom()
    }

    /// One way of adding, after asking where it goes when the role leaves
    /// a choice and the link didn't make it.
    func open(_ page: HappyLink.SettingsPage, vendor: String? = nil, destination: CloudProvider.Destination? = nil) {
        let allowed = CloudProvider.destinations(session.gate)
        if let destination, !allowed.contains(destination) {
            if let host { Alerts.show(Strings.Providers.destinationRefused, Strings.Providers.destinationRefusedHint, on: host) }
            return
        }
        guard !allowed.isEmpty, let host else { return }
        if page == .providersAdd || page == .providers { return page == .providers ? () : choose(destination: destination) }
        // A way this server doesn't offer (a link from elsewhere): the chooser.
        let offered = switch page {
        case .providersAddOpenAI: offer.signIns.contains(.codex)
        case .providersAddAnthropic: offer.setupToken
        case .providersAddAPIKey: offer.apiKeys
        default: false
        }
        guard offered else { return choose(destination: destination) }
        let picked = destination ?? (allowed.count == 1 ? allowed[0] : nil)
        guard let picked else { return chooseDestination(page, vendor: vendor) }
        let flows = ProviderFlows(client: session.client, destination: picked, host: host, unavailable: { [weak self] cli in
            self?.offer.signIns.remove(cli)
            self?.changed()
        }) { [weak self] in self?.added() }
        switch page {
        case .providersAddOpenAI:
            host.navigationController?.pushViewController(DeviceSignInViewController(flows: flows), animated: true)
        case .providersAddAnthropic:
            host.navigationController?.pushViewController(ClaudeSignInViewController(flows: flows), animated: true)
        case .providersAddAPIKey:
            flows.addKey(vendor: vendor ?? "openai")
        default:
            break
        }
    }

    func chooseDestination(_ page: HappyLink.SettingsPage, vendor: String?) {
        let sheet = UIAlertController(title: Strings.Providers.saveTo, message: nil, preferredStyle: .actionSheet)
        for option in CloudProvider.destinations(session.gate) {
            sheet.addAction(UIAlertAction(title: option == .mine ? Strings.Providers.mine : Strings.Providers.team, style: .default) { [weak self] _ in
                self?.open(page, vendor: vendor, destination: option)
            })
        }
        sheet.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel))
        if let popover = sheet.popoverPresentationController, let view = host?.view {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        }
        host?.present(sheet, animated: true)
    }
}
#endif
