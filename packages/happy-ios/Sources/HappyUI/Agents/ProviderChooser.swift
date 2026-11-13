#if canImport(UIKit)
import HappyCore
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

    func choose(destination: CloudProvider.Destination? = nil) {
        host?.present(chooser(destination: destination), animated: true)
    }

    func chooser(destination: CloudProvider.Destination? = nil) -> UIAlertController {
        typealias Text = Strings.Providers
        let sheet = UIAlertController(title: Text.add, message: nil, preferredStyle: .actionSheet)
        if offer.signIns.contains(.codex) {
            sheet.addAction(UIAlertAction(title: Text.signInChatGPT, style: .default) { [weak self] _ in self?.open(.providersAddOpenAI, destination: destination) })
        }
        if offer.setupToken {
            sheet.addAction(UIAlertAction(title: Text.claudeSetupToken, style: .default) { [weak self] _ in self?.open(.providersAddAnthropic, destination: destination) })
        }
        if offer.apiKeys {
            sheet.addAction(UIAlertAction(title: "\(Text.addAPIKey) · \(Text.openAI)", style: .default) { [weak self] _ in
                self?.open(.providersAddAPIKey, vendor: "openai", destination: destination)
            })
            sheet.addAction(UIAlertAction(title: "\(Text.addAPIKey) · \(Text.anthropic)", style: .default) { [weak self] _ in
                self?.open(.providersAddAPIKey, vendor: "anthropic", destination: destination)
            })
            sheet.addAction(UIAlertAction(title: "\(Text.addAPIKey) · \(Text.grok)", style: .default) { [weak self] _ in
                self?.open(.providersAddAPIKey, vendor: "grok", destination: destination)
            })
        }
        if CloudProvider.destinations(session.gate).contains(.team) {
            sheet.addAction(UIAlertAction(title: Text.custom, style: .default) { [weak self] _ in self?.addCustom() })
        }
        sheet.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel))
        if let popover = sheet.popoverPresentationController, let view = host?.view {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        }
        return sheet
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
