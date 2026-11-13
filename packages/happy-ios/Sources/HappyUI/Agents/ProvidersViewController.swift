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
    /// The ways to add one, offering what the server runs.
    private lazy var adding = ProviderChooser(session: session, host: self, added: { [weak self] in self?.load() },
                                              changed: { [weak self] in self?.reload() })
    private var offer: CloudAddOffer { adding.offer }
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
                self?.adding.offer = await Self.offer(listing.offer, client)
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
        if !CloudProvider.destinations(session.gate).isEmpty, Self.offers(offer) || CloudProvider.destinations(session.gate).contains(.team) {
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
        case "openai_compatible": "Custom"
        default: vendor
        }
    }

    /// The chooser: the sign-ins the server offers, then an API key.
    func choose(destination: CloudProvider.Destination? = nil) { adding.choose(destination: destination) }

    /// The team's own provider: owners with `providers.manage` only.
    func addCustom() { adding.addCustom() }

    func open(_ page: HappyLink.SettingsPage, vendor: String? = nil, destination: CloudProvider.Destination? = nil) {
        adding.open(page, vendor: vendor, destination: destination)
    }

    /// Opens a providers link (`happy://settings/providers…`) on `session`.
    static func open(_ page: HappyLink.SettingsPage, options: HappyLink.ProviderOptions = .init(), session: Session, from controller: UIViewController) {
        guard let navigation = controller.navigationController ?? (controller as? UINavigationController) else { return }
        let list = navigation.viewControllers.last as? ProvidersViewController ?? ProvidersViewController(session: session)
        if navigation.viewControllers.last !== list { navigation.pushViewController(list, animated: true) }
        guard page != .providers else { return }
        // Add links default to private (§9); nil is reserved for the manual chooser.
        let destination = options.destination.flatMap(CloudProvider.Destination.init(rawValue:)) ?? .mine
        Task { @MainActor in
            // The chooser offers only what the server runs: read that first.
            list.adding.offer = await offer((try? await session.client.cloudProviderListing())?.offer, session.client)
            let allowed = CloudProvider.destinations(session.gate)
            if options.destination == nil, !allowed.contains(.mine), !allowed.isEmpty {
                // A private default never silently becomes a shared credential.
                return list.adding.chooseDestination(page, vendor: options.vendor)
            }
            list.open(page, vendor: options.vendor, destination: destination)
        }
    }
}

#endif
