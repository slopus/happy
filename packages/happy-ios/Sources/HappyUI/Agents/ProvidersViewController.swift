#if canImport(UIKit)
import HappyCore
import HappyWire
import UIKit

/// A Happy Cloud server's AI providers (ONBOARDING-API §1): the connections
/// a chat can run on, Included (the operator's "Happy (free)"), the team's
/// and the person's own, and the ways to add one their role allows. The
/// list is read again on `config.updated` and whenever it shows.
final class ProvidersViewController: SettingsPageViewController {
    private let session: Session
    private var providers: [CloudProvider]?
    private var failed = false
    /// The sign-ins the server runs (`codex`, `claude`); empty until read,
    /// and when it has none yet.
    private var offer = CloudAddOffer()
    private var watch: Task<Void, Never>?
    /// The role decides what can be added: shown again when it is read.
    private var accessWatch: Watch?

    init(session: Session) {
        self.session = session
        super.init(title: Strings.Providers.title)
    }

    deinit { watch?.cancel() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "providers"
        accessWatch = session.watchAccess { [weak self] in self?.reload() }
        watch = Task { @MainActor [weak self] in
            guard let store = self?.session.store else { return }
            for await _ in await store.events(matching: ["config.updated"]) { self?.load() }
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        load()
    }

    /// Reads the connections and what the server lets people add.
    func load() {
        let client = session.client
        Task { @MainActor [weak self] in
            do {
                let listing = try await client.cloudProviderListing()
                self?.providers = CloudProvider.sorted(listing.providers)
                self?.failed = false
                self?.offer = await Self.offer(listing.offer, client)
            } catch {
                self?.failed = self?.providers == nil
            }
            self?.reload()
        }
    }

    /// The server's own `capabilities`; without them, API keys and the
    /// sign-ins `GET /v0/provider-clis` lists (none where it isn't
    /// mounted), and no setup token.
    static func offer(_ said: CloudAddOffer?, _ client: AgentClient) async -> CloudAddOffer {
        if let said { return said }
        guard let value = try? await client.providerCLIs() else { return CloudAddOffer() }
        return CloudAddOffer(signIns: Set(value.compactMap(CloudSignIn.CLI.init(rawValue:))))
    }

    /// Whether the chooser has anything to offer.
    private static func offers(_ offer: CloudAddOffer) -> Bool {
        offer.apiKeys || offer.setupToken || !offer.signIns.isEmpty
    }

    override func makeRows() -> [[SettingsRow]] {
        typealias Text = Strings.Providers
        var cards: [[SettingsRow]] = []
        if !CloudProvider.destinations(session.gate).isEmpty, Self.offers(offer) {
            cards.append([SettingsRow(id: "providers-add", title: Text.add, icon: ("add", .action), action: { [weak self] in self?.choose() }, footer: Text.footer)])
        }
        guard let providers else {
            if failed { cards.append([SettingsRow(id: "providers-failed", title: Text.loadFailed, accessory: .none, dimmed: true)]) }
            return cards
        }
        for section in CloudProvider.Section.allCases {
            let shown = providers.filter { $0.section == section }
            let title = switch section { case .included: Text.included; case .team: Text.team; case .mine: Text.mine }
            var card = shown.flatMap(Self.rows)
            if card.isEmpty { card = [SettingsRow(id: "providers-\(section)-empty", title: title, value: Text.empty, accessory: .none, dimmed: true)] }
            card[card.count - 1].footer = Text.footer(section)
            cards.append(card)
        }
        return cards
    }

    /// A connection and, where it is listed, each of its credentials.
    static func rows(_ provider: CloudProvider) -> [SettingsRow] {
        typealias Text = Strings.Providers
        let vendors = provider.vendors.map(vendorName).joined(separator: " · ")
        var head = SettingsRow(id: "provider-\(provider.id)", title: provider.name,
                               value: provider.enabled ? nil : Text.off, accessory: .none)
        head.subtitle = [vendors.isEmpty ? nil : vendors, provider.source == .operator ? nil : Text.credentials(provider.credentialCount)]
            .compactMap { $0 }.joined(separator: " · ")
        head.dimmed = !provider.enabled
        let credentials = (provider.credentials ?? []).map { credential in
            SettingsRow(id: "credential-\(credential.id)", title: credential.title,
                        value: credential.needsAttention ? Text.needsAttention : credential.enabled ? nil : Text.off,
                        accessory: .none, destructive: credential.needsAttention, dimmed: !credential.enabled)
        }
        return [head] + credentials
    }

    static func vendorName(_ vendor: String) -> String {
        switch vendor {
        case "openai": "OpenAI"
        case "anthropic": "Anthropic"
        case "codex": "ChatGPT"
        case "claude-code": "Claude"
        case "grok": "Grok"
        case "bedrock": "Bedrock"
        default: vendor
        }
    }

    /// The chooser: the sign-ins the server offers, then an API key.
    func choose(destination: CloudProvider.Destination? = nil) {
        typealias Text = Strings.Providers
        let sheet = UIAlertController(title: Text.add, message: nil, preferredStyle: .actionSheet)
        if offer.signIns.contains(.codex) {
            sheet.addAction(UIAlertAction(title: Text.signInChatGPT, style: .default) { [weak self] _ in self?.open(.providersAddOpenAI, destination: destination) })
        }
        if offer.signIns.contains(.claude) || offer.setupToken {
            sheet.addAction(UIAlertAction(title: Text.signInClaude, style: .default) { [weak self] _ in self?.open(.providersAddAnthropic, destination: destination) })
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
        sheet.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel))
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        }
        present(sheet, animated: true)
    }

    /// One way of adding, after asking where it goes when the role leaves
    /// a choice and the link didn't make it.
    func open(_ page: HappyLink.SettingsPage, vendor: String? = nil, destination: CloudProvider.Destination? = nil) {
        let allowed = CloudProvider.destinations(session.gate)
        guard !allowed.isEmpty else { return }
        if page == .providersAdd || page == .providers { return page == .providers ? () : choose(destination: destination) }
        // A way this server doesn't offer (a link from elsewhere): the chooser.
        let offered = switch page {
        case .providersAddOpenAI: offer.signIns.contains(.codex)
        case .providersAddAnthropic: offer.signIns.contains(.claude) || offer.setupToken
        case .providersAddAPIKey: offer.apiKeys
        default: false
        }
        guard offered else { return choose(destination: destination) }
        let picked = destination.flatMap { allowed.contains($0) ? $0 : nil } ?? (allowed.count == 1 ? allowed[0] : nil)
        guard let picked else {
            let sheet = UIAlertController(title: Strings.Providers.saveTo, message: nil, preferredStyle: .actionSheet)
            for option in allowed {
                sheet.addAction(UIAlertAction(title: option == .mine ? Strings.Providers.mine : Strings.Providers.team, style: .default) { [weak self] _ in
                    self?.open(page, vendor: vendor, destination: option)
                })
            }
            sheet.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel))
            if let popover = sheet.popoverPresentationController {
                popover.sourceView = view
                popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            }
            return present(sheet, animated: true)
        }
        let flows = ProviderFlows(client: session.client, destination: picked, host: self) { [weak self] in self?.load() }
        switch page {
        case .providersAddOpenAI:
            navigationController?.pushViewController(DeviceSignInViewController(flows: flows), animated: true)
        case .providersAddAnthropic:
            navigationController?.pushViewController(ClaudeSignInViewController(flows: flows, offered: offer.signIns.contains(.claude), setupToken: offer.setupToken), animated: true)
        case .providersAddAPIKey:
            flows.addKey(vendor: vendor ?? "openai")
        default:
            break
        }
    }

    /// Opens a providers link (`happy://settings/providers…`) on `session`.
    static func open(_ page: HappyLink.SettingsPage, options: HappyLink.ProviderOptions = .init(), session: Session, from controller: UIViewController) {
        guard let navigation = controller.navigationController ?? (controller as? UINavigationController) else { return }
        let list = navigation.viewControllers.last as? ProvidersViewController ?? ProvidersViewController(session: session)
        if navigation.viewControllers.last !== list { navigation.pushViewController(list, animated: true) }
        guard page != .providers else { return }
        let destination = options.destination.flatMap(CloudProvider.Destination.init(rawValue:))
        Task { @MainActor in
            // The chooser offers only what the server runs: read that first.
            list.offer = await offer((try? await session.client.cloudProviderListing())?.offer, session.client)
            list.open(page, vendor: options.vendor, destination: destination)
        }
    }
}

#endif
