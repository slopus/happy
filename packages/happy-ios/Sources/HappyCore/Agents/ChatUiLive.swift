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
    /// `compute_join`: its pool's machines, from Happy Cloud's
    /// `GET /v0/compute/pools/:id`, `compute.nodes.updated`.
    case pool(UiPool)

    /// Where each live type reads from, as one key per route; nil for a
    /// component that draws only its own results.
    public static func source(_ type: String, props: JSONValue) -> String? {
        switch type {
        case "provider_sign_in": props["provider"]?.stringValue.map { "provider_cli:\($0)" }
        case "default_model": "config"
        case "github_connect": "git"
        // The team's default pool when the offer names none.
        case "compute_join": "pool:\(props["pool"]?.stringValue ?? "")"
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
        /// The program opened the page on the computer itself.
        public var openedByProgram: Bool
        public var error: String?

        public var going: Bool { status == "running" || status == "waiting" }
    }

    public var id: String
    public var name: String
    public var installed: Bool
    public var installer: String?
    /// Where its installer comes from (`x.ai`).
    public var installerHost: String?
    /// `signed_in`, `signed_out` or `unknown`.
    public var signIn: String
    public var email: String?
    public var plan: String?
    public var operation: Operation?
    public var version: String
    /// Each account configured for it, when the computer lists them.
    public var accounts: [Account]?

    public struct Account: Equatable, Sendable {
        public var id: String
        public var label: String
        public var email: String?
        public var plan: String?
        /// `signed_in`, `signed_out` or `unknown`.
        public var signIn: String
    }

    public init?(_ value: JSONValue?) {
        guard let value, let id = value["id"]?.stringValue else { return nil }
        self.id = id
        name = value["name"]?.stringValue ?? UiProviderCli.name(id)
        installed = value["installation"]?["status"]?.stringValue == "installed"
        installer = value["installer"]?["command"]?.stringValue
        installerHost = value["installer"]?["sourceHost"]?.stringValue
        signIn = value["signIn"]?["status"]?.stringValue ?? "unknown"
        email = value["signIn"]?["account"]?["email"]?.stringValue
        plan = value["signIn"]?["account"]?["plan"]?.stringValue
        version = value["version"]?.stringValue ?? ""
        accounts = value["accounts"]?.arrayValue?.compactMap { account in
            guard let id = account["id"]?.stringValue else { return nil }
            return Account(id: id, label: account["label"]?.stringValue ?? id, email: account["email"]?.stringValue, plan: account["plan"]?.stringValue,
                           signIn: account["signIn"]?.stringValue ?? "unknown")
        }
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
                openedByProgram: authorization?["openedByProgram"]?.boolValue ?? false,
                error: operation["error"]?["message"]?.stringValue
            )
        } else {
            operation = nil
        }
    }

    /// Its accounts: those it lists, else its one sign-in when it is signed in.
    public var allAccounts: [Account] {
        if let accounts { return accounts }
        guard signIn == "signed_in" else { return [] }
        return [Account(id: id, label: email ?? name, email: email, plan: plan, signIn: "signed_in")]
    }

    /// "1 account", "2 accounts".
    public static func accounts(_ count: Int) -> String { count == 1 ? "1 account" : "\(count) accounts" }

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

/// A compute pool and the machines in it, as a join widget lists them.
public struct UiPool: Equatable, Sendable {
    public struct Node: Equatable, Sendable {
        public var name: String
        /// `online`, `offline`, `draining`, `enrolling` or `revoked`.
        public var status: String
    }

    public var name: String
    public var nodes: [Node]

    public init(_ detail: ComputePoolDetail) {
        name = detail.pool.name
        nodes = detail.nodes.filter { $0.status != "revoked" }.map { Node(name: $0.displayName, status: $0.status) }
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
        /// A row's control drawn as this Ionicons glyph alone, `label`
        /// what VoiceOver reads.
        public var glyph: String?
        /// In a row, which controls stay when not all fit: 0 is needed most.
        public var rank: Int

        public init(_ label: String, _ tap: Tap, primary: Bool = false, enabled: Bool = true, glyph: String? = nil, rank: Int = 0) {
            self.label = label
            self.tap = tap
            self.primary = primary
            self.enabled = enabled
            self.glyph = glyph
            self.rank = rank
        }
    }

    /// A live component drawn as one row (desktop's `UiRow`): the
    /// provider's mark, its name (`title`), one line (`lines`' only one)
    /// with a glyph by its tone, and its controls in the order they stand.
    public struct Row: Equatable, Sendable {
        public enum Tone: Equatable, Sendable { case quiet, busy, done, error }

        public var provider: String
        public var tone: Tone

        public init(provider: String, tone: Tone) {
            self.provider = provider
            self.tone = tone
        }
    }

    public var title: String
    public var lines: [Line] = []
    public var buttons: [Button] = []
    public var row: Row?

    public init(title: String, lines: [Line] = [], buttons: [Button] = [], row: Row? = nil) {
        self.title = title
        self.lines = lines
        self.buttons = buttons
        self.row = row
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
            return signIn(shown, granted: granted, busy: busy, refused: refused)
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
            let pool: UiPool? = if case .pool(let pool) = shown.live { pool } else { nil }
            card.title = (pool?.name ?? props["pool"]?.stringValue).map { "Add a machine to \($0)" } ?? "Add a machine"
            if let result = shown.result, let commands = result["commands"]?.arrayValue?.compactMap(\.stringValue), !commands.isEmpty {
                card.lines.append(Line("Run on the machine", .muted))
                card.lines += commands.map { Line($0, .code) }
                expires(result["expiresAt"])
                card.buttons.append(Button("Copy commands", .copy(commands.joined(separator: "\n")), primary: true))
            } else {
                control("Create join commands", "compute_join.create", act("compute_join.create"), primary: true)
            }
            // The machines that joined, live, so the person sees theirs arrive.
            if let pool {
                card.lines.append(Line(pool.nodes.isEmpty ? "No machines yet" : "Machines", .muted))
                card.lines += pool.nodes.map { Line("\($0.name) · \($0.status)") }
            }
        default:
            break
        }
        if busy { card.lines.append(Line("Checking…", .muted)) }
        if let refused, !refused.isEmpty { card.lines.append(Line(refused, .error)) }
        return card
    }

    /// `provider_sign_in` as one row (happy-desktop `UiProviderSignInRow`):
    /// how it stands in one line and the one control it needs now. "Set
    /// up" installs; a token is offered only while a sign-in waits or
    /// after one failed; the page opens here only when it can be finished
    /// here (a device page, or one that shows a code to paste back).
    static func signIn(_ shown: UiShown, granted: Set<String>?, busy: Bool, refused: String?) -> UiCard {
        let props = shown.props
        let id = props["provider"]?.stringValue ?? ""
        let cli: UiProviderCli? = if case .provider(let cli) = shown.live { cli } else { nil }
        let name = cli?.name ?? UiProviderCli.name(id)
        let accounts = cli?.allAccounts ?? []
        let adding = props["account"]?.stringValue == "new"
        var card = UiCard(title: name, row: Row(provider: id, tone: .quiet))
        var withheld: String?
        func control(_ label: String, _ type: String, _ tap: Tap, primary: Bool = false, glyph: String? = nil, rank: Int = 0) -> Button {
            let allowed = UiCatalog.allowed(type, props: props, granted: granted)
            if !allowed, withheld == nil { withheld = UiCatalog.actions[type].flatMap { UiCatalog.permission($0, props: props) }.flatMap(who) }
            return Button(label, tap, primary: primary, enabled: allowed && !busy, glyph: glyph, rank: rank)
        }
        func act(_ type: String) -> Tap { .act(UiAction(type: type, payload: .object([:]))) }
        // While another account signs in, the line counts it.
        func counted(_ rest: String) -> String {
            adding && !accounts.isEmpty ? "Adding account \(accounts.count + 1) · \(rest)" : rest.prefix(1).uppercased() + rest.dropFirst()
        }
        func row(_ line: String, _ tone: Row.Tone, _ buttons: [Button] = []) -> UiCard {
            card.row?.tone = tone
            card.buttons = buttons
            // A control the viewer may not use says who can, in place of the line.
            let usable = buttons.contains { $0.enabled } || busy
            if let withheld, !usable, tone == .quiet {
                card.lines = [Line(withheld, .muted)]
            } else {
                card.lines = [Line(line, tone == .error ? .error : tone == .quiet ? .muted : .plain)]
            }
            return card
        }
        func token() -> Button { control("Use a token", "provider_sign_in.submit_token", .secret(action: "provider_sign_in.submit_token", field: "token", title: "Paste a setup token or API key"), rank: 2) }
        func cancel() -> Button { control("Cancel", "provider_sign_in.cancel", act("provider_sign_in.cancel"), glyph: "close", rank: 1) }
        func again() -> Button { control("Try again", "provider_sign_in.sign_in", act("provider_sign_in.sign_in"), primary: true) }
        if let refused, !refused.isEmpty { return row(refused, .error, [token(), again()]) }
        guard let cli else {
            // An older server that doesn't say: its fallback, and a sign-in.
            if !shown.fallback.isEmpty, !busy { return row(shown.fallback, .quiet, [control("Sign in", "provider_sign_in.sign_in", act("provider_sign_in.sign_in"), primary: true)]) }
            return row("Checking \(name) on this computer…", .busy)
        }
        if let operation = cli.operation, operation.status == "waiting", operation.url != nil || operation.userCode != nil || operation.acceptsCode {
            if operation.acceptsCode {
                let code = control("Paste code", "provider_sign_in.submit_code", .secret(action: "provider_sign_in.submit_code", field: "code", title: "Paste the code from the page"), primary: true)
                // The code comes from the page: on a narrow row it outranks the cross.
                var buttons = [code, control("Cancel", "provider_sign_in.cancel", act("provider_sign_in.cancel"), glyph: "close", rank: 2)]
                if let url = operation.url { buttons.insert(Button(operation.openedByProgram ? "Reopen page" : "Open page", .open(url), enabled: !busy, glyph: "open-outline", rank: 1), at: 0) }
                return row(counted("paste the code from the page"), .busy, buttons)
            }
            if let userCode = operation.userCode {
                var buttons = [Button("Copy code", .copy(userCode), enabled: !busy, rank: 2), cancel()]
                if let url = operation.url, operation.device { buttons.insert(Button("Open page", .open(url), primary: true, enabled: !busy), at: 1) }
                return row("Enter \(userCode) on \(name)'s page", .busy, buttons)
            }
            if let url = operation.url, operation.device { return row(counted("finish on the page"), .busy, [token(), Button("Open page", .open(url), primary: true, enabled: !busy), cancel()]) }
            return row(counted("finish in the browser on your computer"), .busy, [token(), cancel()])
        }
        if let operation = cli.operation, operation.going {
            let message = operation.message ?? (operation.kind == "install" ? "Setting up…" : "starting…")
            return row(operation.kind == "install" ? message : counted(message), .busy, [cancel()])
        }
        if let operation = cli.operation, operation.status == "failed" {
            return row(operation.error ?? operation.message ?? "That didn't work", .error, [token(), again()])
        }
        if busy { return row(counted("starting…"), .busy) }
        if !cli.installed {
            var setUp = control("Set up", "provider_sign_in.install", act("provider_sign_in.install"), primary: true)
            setUp.enabled = setUp.enabled && cli.installer != nil
            return row(cli.installerHost.map { "Not on this computer yet · comes from \($0)" } ?? "Not on this computer yet", .quiet, [setUp])
        }
        let signIn = { (label: String) in control(label, "provider_sign_in.sign_in", act("provider_sign_in.sign_in"), primary: true) }
        // An account reads as its email, its label only when it has none.
        func named(_ account: UiProviderCli.Account) -> String { account.email ?? account.label }
        if let lapsed = accounts.first(where: { $0.signIn == "signed_out" }), !adding {
            let line = accounts.count > 1 ? "\(UiProviderCli.accounts(accounts.count)) · \(named(lapsed)) needs to sign in again" : "\(named(lapsed)) needs to sign in again"
            return row(line, .quiet, [signIn("Sign in again")])
        }
        if accounts.isEmpty { return row(cli.signIn == "unknown" ? "Sign-in not checked" : "Not signed in", .quiet, [signIn("Sign in")]) }
        let first = accounts[0]
        let line = accounts.count == 1 ? [named(first), first.plan].compactMap { $0 }.joined(separator: " · ") : "\(UiProviderCli.accounts(accounts.count)) · \(named(first)) +\(accounts.count - 1)"
        // Signed in but not yet taken into use here: the one control that does.
        let used = shown.state.attempt.map { $0.type == "provider_sign_in.sign_in" && $0.outcome.status == "accepted" } ?? false
        if !adding, !used { return row(line, .done, [signIn("Use \(name)")]) }
        return row(line, .done, adding ? [signIn("Add account")] : [])
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
