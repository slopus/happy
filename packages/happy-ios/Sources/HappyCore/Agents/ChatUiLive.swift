import Foundation
import HappyWire

/// What a live component draws from: the server's own state, read through
/// the routes desktop reads (happy-agent `API.md`, "Chat UI"), never from
/// the component's props.
public enum UiLive: Equatable, Sendable {
    /// `provider_sign_in`: `GET /v0/provider-clis/:cliId`, `provider_cli.updated`.
    case provider(UiProviderCli)
    /// `default_model`: `GET /v0/config` `defaults`, `config.updated`.
    case defaults(UiModelDefaults)
    /// `github_connect`: whether a GitHub credential is in
    /// `GET /v0/git/credentials`, `gitCredential.*`.
    case github(connected: Bool)

    /// Where each live type reads from, as one key per route; nil for a
    /// component that draws only its own results.
    public static func source(_ type: String, props: JSONValue) -> String? {
        switch type {
        case "provider_sign_in": props["provider"]?.stringValue.map { "provider_cli:\($0)" }
        case "default_model": "config"
        case "github_connect": "git"
        default: nil
        }
    }
}

/// A provider CLI object (`API.md`, "Provider CLIs"), as far as a widget
/// shows it. Its `version` is a UUIDv7: a later reading has the greater.
public struct UiProviderCli: Equatable, Sendable {
    public struct Operation: Equatable, Sendable {
        public var kind: String
        /// `running`, `waiting`, `succeeded`, `failed` or `cancelled`.
        public var status: String
        public var message: String?
        /// The vendor's page, https only.
        public var url: URL?
        public var userCode: String?
        public var acceptsCode: Bool
        /// A `device` page can be finished on any device; a `browser` one
        /// only on the computer, unless it shows a code to paste back.
        public var device: Bool
        public var error: String?

        public var going: Bool { status == "running" || status == "waiting" }
    }

    public var id: String
    public var name: String
    public var installed: Bool
    public var installer: String?
    /// `signed_in`, `signed_out` or `unknown`.
    public var signIn: String
    public var email: String?
    public var plan: String?
    public var operation: Operation?
    public var version: String

    public init?(_ value: JSONValue?) {
        guard let value, let id = value["id"]?.stringValue else { return nil }
        self.id = id
        name = value["name"]?.stringValue ?? UiProviderCli.name(id)
        installed = value["installation"]?["status"]?.stringValue == "installed"
        installer = value["installer"]?["command"]?.stringValue
        signIn = value["signIn"]?["status"]?.stringValue ?? "unknown"
        email = value["signIn"]?["account"]?["email"]?.stringValue
        plan = value["signIn"]?["account"]?["plan"]?.stringValue
        version = value["version"]?.stringValue ?? ""
        if let operation = value["operation"], let kind = operation["kind"]?.stringValue {
            let authorization = operation["authorization"]
            self.operation = Operation(
                kind: kind,
                status: operation["status"]?.stringValue ?? "running",
                message: operation["message"]?.stringValue,
                url: authorization?["url"]?.stringValue.flatMap(CloudSignIn.web),
                userCode: authorization?["userCode"]?.stringValue,
                acceptsCode: authorization?["acceptsCode"]?.boolValue ?? false,
                device: authorization?["method"]?.stringValue == "device",
                error: operation["error"]?["message"]?.stringValue
            )
        } else {
            operation = nil
        }
    }

    /// The assistant's name before the server has said it.
    public static func name(_ id: String) -> String {
        switch id {
        case "claude": "Claude Code"
        case "codex": "Codex"
        case "grok": "Grok"
        case "antigravity": "Antigravity"
        default: id
        }
    }
}

/// The default model for new conversations, with the catalog it is picked
/// from.
public struct UiModelDefaults: Equatable, Sendable {
    public var providerId: String
    public var modelId: String
    public var effort: String
    public var catalog: ModelCatalog

    public init?(response data: Data) {
        guard let catalog = ModelCatalog(response: data),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data) else { return nil }
        self.catalog = catalog
        providerId = catalog.defaultProviderId
        modelId = catalog.defaultModelId
        effort = value["config"]?["defaults"]?["effort"]?.stringValue ?? catalog.provider(catalog.defaultProviderId)?.models.first { $0.id == catalog.defaultModelId }?.defaultEffort ?? "medium"
    }

    /// The models a default can be set to: each usable account's, in
    /// catalog order.
    public var choices: [(provider: ModelCatalog.Provider, model: ModelCatalog.Model)] {
        catalog.providers.filter { !$0.isDisabled && !$0.hidden }.flatMap { provider in
            provider.models.filter { !provider.hiddenModels.contains($0.id) }.map { (provider, $0) }
        }
    }

    public var title: String {
        let model = catalog.provider(providerId)?.models.first { $0.id == modelId } ?? catalog.models.first { $0.id == modelId }
        return "\(model?.name ?? modelId) · \(effort)"
    }
}

/// A live component's latest silent action and how it stood.
public struct UiAttempt: Equatable, Sendable {
    public var type: String
    public var outcome: UiOutcome

    public init(type: String, outcome: UiOutcome) {
        self.type = type
        self.outcome = outcome
    }
}

/// A live component as a card: a title, lines of state, and the controls
/// the state allows. Built from the server's state, the latest attempt,
/// and a result this screen holds (`UiShown.result`, secrets included,
/// never kept).
public struct UiCard: Equatable, Sendable {
    public enum Style: Equatable, Sendable { case plain, muted, code, error }

    public struct Line: Equatable, Sendable {
        public var text: String
        public var style: Style

        public init(_ text: String, _ style: Style = .plain) {
            self.text = text
            self.style = style
        }
    }

    public enum Tap: Equatable, Sendable {
        case act(UiAction)
        /// Asks for a secret in a secure field, then sends it as
        /// `{ field: value }`.
        case secret(action: String, field: String, title: String)
        /// Picks a model and effort, then sends `default_model.set`.
        case pickModel
        case open(URL)
        case copy(String)
    }

    public struct Button: Equatable, Sendable {
        public var label: String
        public var tap: Tap
        public var primary: Bool
        public var enabled: Bool

        public init(_ label: String, _ tap: Tap, primary: Bool = false, enabled: Bool = true) {
            self.label = label
            self.tap = tap
            self.primary = primary
            self.enabled = enabled
        }
    }

    public var title: String
    public var lines: [Line] = []
    public var buttons: [Button] = []

    public init(title: String, lines: [Line] = [], buttons: [Button] = []) {
        self.title = title
        self.lines = lines
        self.buttons = buttons
    }

    /// `granted` nil holds every permission.
    public static func make(_ shown: UiShown, granted: Set<String>?) -> UiCard {
        let props = shown.props
        let busy = shown.state.attempt?.outcome.status == "pending"
        var card = UiCard(title: "")
        var refused: String?
        if let attempt = shown.state.attempt, attempt.outcome.status == "rejected" || attempt.outcome.status == "failed" {
            refused = attempt.outcome.reason ?? attempt.outcome.code
        }
        /// A control that sends `type`, shown disabled when the person may
        /// not, or while an action is on its way.
        func control(_ label: String, _ type: String, _ tap: Tap, primary: Bool = false) {
            let allowed = UiCatalog.allowed(type, props: props, granted: granted)
            card.buttons.append(Button(label, tap, primary: primary, enabled: allowed && !busy))
            if !allowed, let needed = UiCatalog.actions[type].flatMap({ UiCatalog.permission($0, props: props) }), let who = who(needed),
               !card.lines.contains(Line(who, .muted)) {
                card.lines.append(Line(who, .muted))
            }
        }
        func act(_ type: String, _ payload: [String: JSONValue] = [:]) -> Tap { .act(UiAction(type: type, payload: .object(payload))) }
        func expires(_ value: JSONValue?) {
            guard let ms = value?.numberValue else { return }
            card.lines.append(Line("Expires at \(Date(timeIntervalSince1970: ms / 1000).formatted(date: .omitted, time: .shortened))", .muted))
        }
        switch shown.type {
        case "provider_sign_in":
            let id = props["provider"]?.stringValue ?? ""
            let cli: UiProviderCli? = if case .provider(let cli) = shown.live { cli } else { nil }
            card.title = cli?.name ?? UiProviderCli.name(id)
            let token = Tap.secret(action: "provider_sign_in.submit_token", field: "token", title: "Paste a setup token or API key")
            if let cli, let operation = cli.operation, operation.going {
                if let message = operation.message { card.lines.append(Line(message)) }
                if let code = operation.userCode { card.lines.append(Line(code, .code)) }
                if let url = operation.url, operation.device || operation.acceptsCode {
                    card.buttons.append(Button("Open sign-in page", .open(url), primary: true, enabled: !busy))
                }
                if let code = operation.userCode { card.buttons.append(Button("Copy code", .copy(code))) }
                if operation.acceptsCode {
                    control("Paste code", "provider_sign_in.submit_code", .secret(action: "provider_sign_in.submit_code", field: "code", title: "Paste the code from the page"))
                }
                control("Cancel", "provider_sign_in.cancel", act("provider_sign_in.cancel"))
            } else if let cli {
                if let error = cli.operation?.error, cli.operation?.status == "failed" { card.lines.append(Line(error, .error)) }
                if !cli.installed {
                    card.lines.append(Line("Not installed on the computer", .muted))
                    if let installer = cli.installer {
                        card.lines.append(Line(installer, .code))
                        control("Install", "provider_sign_in.install", act("provider_sign_in.install"), primary: true)
                    }
                } else if cli.signIn == "signed_in" {
                    let account = [cli.email, cli.plan].compactMap { $0 }.joined(separator: " · ")
                    card.lines.append(Line(account.isEmpty ? "Signed in" : "Signed in as \(account)"))
                    control("Use this account", "provider_sign_in.sign_in", act("provider_sign_in.sign_in"), primary: true)
                } else {
                    card.lines.append(Line(cli.signIn == "signed_out" ? "Not signed in" : "Sign-in not checked", .muted))
                    control("Sign in", "provider_sign_in.sign_in", act("provider_sign_in.sign_in"), primary: true)
                }
                if cli.installed { control("Paste a token", "provider_sign_in.submit_token", token) }
            } else {
                if !shown.fallback.isEmpty { card.lines.append(Line(shown.fallback, .muted)) }
                control("Sign in", "provider_sign_in.sign_in", act("provider_sign_in.sign_in"), primary: true)
                control("Paste a token", "provider_sign_in.submit_token", token)
            }
        case "default_model":
            card.title = "Default model"
            if case .defaults(let defaults) = shown.live {
                card.lines.append(Line(defaults.title))
                if !defaults.choices.isEmpty { control("Change", "default_model.set", .pickModel) }
            } else if !shown.fallback.isEmpty {
                card.lines.append(Line(shown.fallback, .muted))
            }
        case "invite":
            card.title = "Invite a teammate"
            let role = props["role"]?.stringValue ?? "member"
            if let result = shown.result, let code = result["code"]?.stringValue {
                card.lines.append(Line(code, .code))
                if let server = result["serverName"]?.stringValue { card.lines.append(Line("Joins \(server) as \(role)", .muted)) }
                expires(result["expiresAt"])
                card.buttons.append(Button("Copy code", .copy(code), primary: true))
                if let invite = result["inviteId"]?.stringValue { control("Revoke", "invite.revoke", act("invite.revoke", ["inviteId": .string(invite)])) }
            } else {
                card.lines.append(Line("Role: \(role)", .muted))
                control("Create invite", "invite.create", act("invite.create", ["role": .string(role)]), primary: true)
            }
        case "github_connect":
            card.title = "GitHub"
            if case .github(true) = shown.live {
                card.lines.append(Line("Connected"))
            } else if let result = shown.result, let code = result["userCode"]?.stringValue {
                card.lines.append(Line("Enter this code on GitHub", .muted))
                card.lines.append(Line(code, .code))
                expires(result["expiresAt"])
                card.buttons.append(Button("Copy code", .copy(code), primary: true))
                if let url = result["verificationUri"]?.stringValue.flatMap(CloudSignIn.web) { card.buttons.append(Button("Open GitHub", .open(url))) }
            } else {
                control("Link your GitHub account", "github_connect.device_start", act("github_connect.device_start"), primary: true)
            }
        case "compute_join":
            card.title = props["pool"]?.stringValue.map { "Add a machine to \($0)" } ?? "Add a machine"
            if let result = shown.result, let commands = result["commands"]?.arrayValue?.compactMap(\.stringValue), !commands.isEmpty {
                card.lines.append(Line("Run on the machine", .muted))
                card.lines += commands.map { Line($0, .code) }
                expires(result["expiresAt"])
                card.buttons.append(Button("Copy commands", .copy(commands.joined(separator: "\n")), primary: true))
            } else {
                control("Create join commands", "compute_join.create", act("compute_join.create"), primary: true)
            }
        default:
            break
        }
        if busy { card.lines.append(Line("Checking…", .muted)) }
        if let refused, !refused.isEmpty { card.lines.append(Line(refused, .error)) }
        return card
    }

    /// The line a control that can't be used says, by what it needs.
    static func who(_ permission: String) -> String? {
        switch permission {
        case "providers.manage": "Owners and admins can connect AIs for the team"
        case "providers.own": "Your role can't connect AIs here"
        case "config.manage": "Owners and admins can change the default model"
        case "members.manage": "Owners and admins can invite teammates"
        case "pools.manage": "Owners and admins can add machines"
        case "repositories.manage": "Owners and admins can connect repositories"
        case "content.write": "Your role can't answer here"
        default: nil
        }
    }
}
