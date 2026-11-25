#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
@testable import HappyCore
@testable import HappyUI
import HappyWire
import UIKit

private struct SignInOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct SignInNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A paired computer that serves provider sign-in as happy-agent PR #176's
/// API.md has it: three accounts (Codex, Claude, Grok), each sign-in a
/// made-up operation that waits for its code a second after it starts. No
/// vendor is ever reached and nothing is signed in.
private actor ProviderSignInDaemon: AgentTransport {
    enum Scenario: String {
        /// Every account on the machine's own login.
        case system
        /// Codex signed in to Happy, Claude on a saved token, Grok configured.
        case `internal`
        /// Sign-ins fail as they wait: the code expired.
        case failure
        /// Sign-ins fail as they save.
        case saveFailed
        /// A team member who isn't the owner: every change is refused.
        case owner
        /// One account in each row state: working on Happy's login, on the
        /// system login, renewing failing (expiring soon), needing sign-in,
        /// off, and an older daemon's reading only.
        case states
    }

    struct Account {
        var id: String
        var name: String
        var type: String
        var source: String
        var email: String?
        var plan: String?
        var signIn: String
        var enabled = true
        /// The usage entry's newer fields (`lastUsedAt`, `login`), as JSON
        /// members, or nil for an older daemon's entry.
        var health: String? = nil
    }

    private let scenario: Scenario
    private var accounts: [Account]
    private var operations: [String: String] = [:]
    private var versions = 1

    init(scenario: Scenario) {
        self.scenario = scenario
        if scenario == .states {
            let now = Date().timeIntervalSince1970 * 1000
            func ago(_ minutes: Double) -> Int { Int(now - minutes * 60_000) }
            func ahead(_ minutes: Double) -> Int { Int(now + minutes * 60_000) }
            accounts = [
                Account(id: "codex_work", name: "Work ChatGPT", type: "codex", source: "internal", email: "ada@example.com", plan: "Pro", signIn: "signed_in",
                        health: #""lastUsedAt":\#(ago(4)),"login":{"refreshedAt":\#(ago(65)),"expiresAt":\#(ahead(9 * 60)),"refreshError":null}"#),
                Account(id: "claude", name: "Claude", type: "claude", source: "system", signIn: "signed_in",
                        health: #""lastUsedAt":\#(ago(30)),"login":{"refreshedAt":\#(ago(180)),"expiresAt":null,"refreshError":null}"#),
                Account(id: "codex_home", name: "Home ChatGPT", type: "codex", source: "internal", email: "ada@example.com", plan: "Plus", signIn: "signed_in",
                        health: #""lastUsedAt":\#(ago(120)),"login":{"refreshedAt":\#(ago(26 * 60)),"expiresAt":\#(ahead(180)),"refreshError":{"status":503,"code":null,"permanent":false,"since":\#(ago(40)),"at":\#(ago(6))}}"#),
                Account(id: "claude_team", name: "Team Claude", type: "claude", source: "internal", signIn: "signed_out",
                        health: #""lastUsedAt":\#(ago(5 * 24 * 60)),"login":{"refreshedAt":\#(ago(6 * 24 * 60)),"expiresAt":\#(ago(4 * 24 * 60)),"refreshError":{"status":400,"code":"invalid_grant","permanent":true,"since":\#(ago(4 * 24 * 60)),"at":\#(ago(60))}}"#),
                Account(id: "grok", name: "Grok", type: "grok", source: "system", signIn: "unknown", enabled: false,
                        health: #""lastUsedAt":null,"login":null"#),
                Account(id: "codex_old", name: "Studio ChatGPT", type: "codex", source: "system", signIn: "unknown"),
            ]
            return
        }
        let signedIn = scenario == .internal
        accounts = [
            Account(id: "codex_work", name: "Work ChatGPT", type: "codex", source: signedIn ? "internal" : "system",
                    email: signedIn ? "ada@example.com" : nil, plan: signedIn ? "Pro" : nil, signIn: "signed_in"),
            Account(id: "claude", name: "Claude", type: "claude", source: signedIn ? "internal" : "system", signIn: signedIn ? "signed_in" : "signed_out"),
            Account(id: "grok", name: "Grok", type: "grok", source: signedIn ? "configured" : "system", signIn: "signed_in"),
        ]
    }

    private func version() -> String {
        versions += 1
        return String(format: "01991f3a-5c1e-7000-8000-%012d", versions)
    }

    private func methods(_ type: String) -> String { type == "claude" ? #"["browser"]"# : #"["device","browser"]"# }

    private func credential(_ account: Account) -> String {
        #"{"source":"\#(account.source)","methods":\#(methods(account.type)),"acceptsToken":\#(account.type == "claude")}"#
    }

    private func object(_ id: String) -> String? {
        guard let account = accounts.first(where: { $0.id == id }) else { return nil }
        let who = account.source == "internal" && account.email != nil ? #"{"email":"\#(account.email!)","plan":"\#(account.plan ?? "")"}"# : "null"
        return #"{"providerSignIn":{"providerId":"\#(id)","cliId":"\#(account.type)","installed":true,"credential":\#(credential(account)),"account":\#(who),"operation":\#(operations[id] ?? "null"),"version":"\#(version())","updatedAt":1755400000000}}"#
    }

    private func operation(_ status: String, type: String, authorized: Bool, error: String = "null") -> String {
        let authorization = !authorized ? "null" : type == "claude"
            ? #"{"method":"browser","url":"https://claude.ai/oauth/authorize?code=true","userCode":null,"openedByProgram":false,"acceptsCode":true,"expiresAt":1755400600000}"#
            : #"{"method":"device","url":"https://auth.openai.com/codex/device","userCode":"FQ7K-2MXD","openedByProgram":false,"acceptsCode":false,"expiresAt":1755400600000}"#
        return #"{"id":"op-1","kind":"sign_in","status":"\#(status)","message":"Signing in","authorization":\#(authorization),"output":[],"error":\#(error),"startedAt":1755400000000,"finishedAt":null}"#
    }

    private func advance(_ id: String, type: String) async {
        try? await Task.sleep(for: .seconds(1))
        operations[id] = operation("waiting", type: type, authorized: true)
        guard scenario == .failure else { return }
        try? await Task.sleep(for: .seconds(1.5))
        operations[id] = operation("failed", type: type, authorized: true,
                                   error: #"{"code":"expired","message":"The sign-in code expired before it was used. The account keeps the login it had."}"#)
    }

    private func finish(_ id: String) async {
        try? await Task.sleep(for: .seconds(1))
        guard let index = accounts.firstIndex(where: { $0.id == id }) else { return }
        if scenario == .saveFailed {
            operations[id] = operation("failed", type: accounts[index].type, authorized: true,
                                       error: #"{"code":"save_failed","message":"Signed in, but runtime.toml couldn't be written. The account keeps the login it had."}"#)
            return
        }
        accounts[index].source = "internal"
        accounts[index].email = "ada@example.com"
        accounts[index].plan = "Max"
        accounts[index].signIn = "signed_in"
        operations[id] = operation("succeeded", type: accounts[index].type, authorized: true)
    }

    static let health = #"{"ready":true,"capabilities":{"providerSignIn":true}}"#

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        func ok(_ text: String) -> HTTP1Response { HTTP1Response(status: 200, body: Data(text.utf8)) }
        func refused(_ status: Int, _ code: String, _ message: String) -> HTTP1Response {
            HTTP1Response(status: status, body: Data(#"{"error":"\#(message)","code":"\#(code)"}"#.utf8))
        }
        switch (method, path) {
        case ("GET", "/v0/health"):
            return ok(Self.health)
        case ("GET", "/v0/bootstrap/desktop"):
            // The bootstrap carries health, as a daemon's does: the app reads capabilities there.
            return ok(#"{"cursor":"c1","health":\#(Self.health),"profile":{"userId":null,"name":"Steve"},"userSettings":[],"projects":[],"workspaces":[],"bots":[],"tasks":[],"taskMemberships":[],"surfaces":[]}"#)
        case ("GET", "/v0/config"):
            let providers = accounts.map { #""\#($0.id)":{"type":"\#($0.type)","name":"\#($0.name)","enabled":\#($0.enabled),"models":[],"credential":\#(self.credential($0))}"# }
            return ok(#"{"config":{"defaults":{"providerId":"codex_work","modelId":"m"},"models":{},"providers":{\#(providers.joined(separator: ","))}}}"#)
        case ("GET", "/v0/usage"):
            // An older daemon's entry: its sign-in, and when it was last read.
            let checked = Int(Date().timeIntervalSince1970 * 1000) - 3 * 60_000
            return ok(#"{"providers":[\#(accounts.map { #"{"providerId":"\#($0.id)","signIn":"\#($0.signIn)","refreshedAt":\#(checked)\#($0.health.map { "," + $0 } ?? "")}"# }.joined(separator: ","))]}"#)
        case ("PATCH", "/v0/config"):
            if scenario == .owner { return refused(403, "forbidden", "Only the team owner can change the configuration.") }
            if let body, let value = try? JSONValue.decode(body), let changes = value["providers"]?.objectValue {
                for (id, change) in changes {
                    if let on = change["enabled"]?.boolValue, let index = accounts.firstIndex(where: { $0.id == id }) { accounts[index].enabled = on }
                }
            }
            return ok("{}")
        default: break
        }
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count >= 4, parts[0] == "v0", parts[1] == "providers", let account = accounts.first(where: { $0.id == parts[2] }) else {
            return refused(404, "not_found", "Not here.")
        }
        let rest = parts.dropFirst(3).joined(separator: "/")
        if method != "GET", scenario == .owner { return refused(403, "forbidden", "Only the team owner can change provider sign-in.") }
        switch (method, rest) {
        case ("GET", "sign-in"):
            break
        case ("POST", "sign-in"):
            operations[account.id] = operation("running", type: account.type, authorized: false)
            Task { await self.advance(account.id, type: account.type) }
        case ("POST", "sign-in/code"):
            operations[account.id] = operation("running", type: account.type, authorized: true)
            Task { await self.finish(account.id) }
        case ("POST", "sign-in/cancel"):
            operations[account.id] = operation("cancelled", type: account.type, authorized: false)
        case ("PUT", "token"):
            guard account.type == "claude" else { return refused(409, "not_supported", "Only Claude accounts take a token.") }
            if let index = accounts.firstIndex(where: { $0.id == account.id }) { accounts[index].source = "internal"; accounts[index].email = nil }
        default:
            return refused(404, "not_found", "Not here.")
        }
        return ok(object(account.id) ?? "{}")
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.cannotConnectToHost) }
    func reset() async {}
    func close() async {}
}

/// Settings › Provider accounts over `ProviderSignInDaemon`
/// (`-screen providerSignIn`):
/// - `-scenario system|internal|failure|saveFailed|owner` picks the daemon;
/// - `-open settings|list|codex|claude|detail` picks the screen: the
///   computer's settings, the accounts, one's sign-in started, or the page
///   of the account `-account` names;
/// - `-snapshot <name>` writes the screen to Documents/<name>.png once it
///   settles (after `-wait` seconds, 6 by default), for a real device.
@MainActor
final class ProviderSignInHarness {
    private var account: AccountController?

    init(window: HarnessWindow, arguments: [String]) {
        Task { await open(window: window, arguments: arguments) }
    }

    private func open(window: HarnessWindow, arguments: [String]) async {
        func value(_ flag: String) -> String? { arguments.firstIndex(of: flag).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil } }
        let scenario = value("-scenario").flatMap(ProviderSignInDaemon.Scenario.init(rawValue:)) ?? .system
        let daemon = ProviderSignInDaemon(scenario: scenario)
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/provider-sign-in",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in daemon },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: SignInOffline(), connector: SignInNoSocket()
        )
        self.account = account
        if arguments.contains("-dark") { window.overrideUserInterfaceStyle = .dark }
        do {
            let connection = try await account.agentConnections.add(
                AgentConnectionCredentials(address: "studio.local", port: 7777, deviceID: "provider-sign-in", deviceToken: "harness"), name: "Studio Mac")
            let context = AppContext(account: account, variant: .development, version: "provider-sign-in")
            guard let session = Session.session(for: connection.id, context: context) else { return }
            if scenario == .owner { ProviderSignInAccess.refused(session.accountID) }
            let open = value("-open") ?? "list"
            let root: UIViewController = open == "settings" ? UIViewController() : ProviderAccountsViewController(session: session)
            let navigation = UINavigationController(rootViewController: root)
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            window.rootViewController = navigation
            window.layoutIfNeeded()
            if open == "settings" {
                let settings = SettingsViewController(context: context, computer: connection.id)
                navigation.pushViewController(settings, animated: false)
                // Down to the Agents group, once the computer said it serves sign-in.
                try? await Task.sleep(for: .seconds(3))
                if let scroll = settings.view.subviews.compactMap({ $0 as? UIScrollView }).first {
                    let bottom = scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom
                    scroll.setContentOffset(CGPoint(x: 0, y: max(-scroll.adjustedContentInset.top, bottom - 200)), animated: false)
                }
            }
            if open == "detail", let list = root as? ProviderAccountsViewController {
                let accounts = try await session.client.providerAccounts()
                guard let picked = accounts.first(where: { $0.id == value("-account") }) ?? accounts.first else { return }
                try? await Task.sleep(for: .seconds(1))
                list.open(picked)
            }
            if open == "codex" || open == "claude", let list = root as? ProviderAccountsViewController {
                let accounts = try await session.client.providerAccounts()
                guard let picked = accounts.first(where: { $0.type == open }) else { return }
                try? await Task.sleep(for: .seconds(1))
                list.open(picked)
                try? await Task.sleep(for: .seconds(0.6))
                (navigation.topViewController as? ProviderAccountViewController)?.signIn()
                // `-code <code>`: pasted back once the page waits for it.
                if let code = value("-code") {
                    try? await Task.sleep(for: .seconds(2.5))
                    (navigation.topViewController as? AccountSignInViewController)?.enterCode(code)
                }
            }
            try? await Task.sleep(for: .seconds(Double(value("-wait") ?? "") ?? 6))
            if let name = value("-snapshot") { snapshot(window, name) }
            print("PROVIDER-SIGN-IN ready \(scenario.rawValue) \(open)")
        } catch {
            print("PROVIDER-SIGN-IN error: \(error)")
        }
    }

    private func snapshot(_ window: UIWindow, _ name: String) {
        window.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        guard let data = image.pngData(), let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        let url = documents.appendingPathComponent("\(name).png")
        try? data.write(to: url)
        print("PROVIDER-SIGN-IN snapshot \(url.path)")
    }
}
#endif
