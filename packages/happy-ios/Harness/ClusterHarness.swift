#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
@testable import HappyCore
@testable import HappyUI
import HappyWire
import UIKit

private struct ClusterOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct ClusterNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A Happy Cloud server as happy-cluster answers its plugin routes
/// (API.md, "Plugins"), for screenshots before the routes are deployed:
/// GitHub (an App sign-in and a token), Linear (no sign-in) and Sentry
/// (a key) offered; GitHub installed twice, once signed in. Writes change
/// what it lists, as the server's do. `manager: false` refuses the
/// installations, as the server does a member without `mcp.manage`.
actor ClusterServer: AgentTransport {
    static let bootstrap = #"""
    {"cursor":"cursor-1","profile":{"userId":"steve","name":"Steve","photo":null},"userSettings":[],
     "projects":[],"workspaces":[],
     "bots":[{"id":"cos","name":"Chief of Staff","systemKey":"chief_of_staff","status":"active","agent":{"id":"cos-agent","workspaceId":"cos-w","status":"idle"}}],
     "tasks":[{"id":"t1","name":"Plan the launch","ownerUserId":"steve","status":"active","agent":{"id":"t1-agent","workspaceId":"w1","status":"idle"}}],
     "taskMemberships":[{"taskId":"t1"}],"surfaces":[]}
    """#

    static let catalog = #"""
    {"plugins":[
      {"id":"github","name":"GitHub","description":"Repositories, issues and pull requests, for agents to read and act on.","version":"1.0.0",
       "image":{"digest":"github","mime":"image/png","thumbhash":null},
       "tools":[{"name":"list_repositories","summary":"Lists the repositories the installation can reach."},
                {"name":"get_issue","summary":"Reads one issue with its comments."},
                {"name":"create_pull_request","summary":"Opens a pull request from a branch."}],
       "auth":{"required":true,"methods":[
         {"id":"install","label":"GitHub App","type":"oauth","scopes":["contents:read","metadata:read"]},
         {"id":"token","label":"Access token","type":"fields","fields":[
           {"key":"token","label":"Personal access token","help":"Make one at github.com/settings/tokens with repo access.","required":true,"secret":true,"multiline":false}]}]}},
      {"id":"linear","name":"Linear","description":"Issues, projects and cycles.","version":"0.4.2",
       "image":{"digest":"linear","mime":"image/png","thumbhash":null},
       "tools":[{"name":"search_issues","summary":"Finds issues by text."}],"auth":{"required":false,"methods":[]}},
      {"id":"sentry","name":"Sentry","description":"Errors and performance from production.","version":"2.1.0",
       "image":{"digest":"sentry","mime":"image/png","thumbhash":null},
       "tools":[{"name":"list_issues","summary":"Lists unresolved issues."}],
       "auth":{"required":true,"methods":[
         {"id":"key","label":"Auth token","type":"fields","fields":[
           {"key":"token","label":"Auth token","help":"From Settings › Auth Tokens.","required":true,"secret":true,"multiline":false},
           {"key":"org","label":"Organization slug","help":"","required":true,"secret":false,"multiline":false}]}]}}
    ]}
    """#

    struct Installation {
        var id: String
        var plugin: String
        var ordinal: Int
        var label: String?
        var status: String
        var authMethod: String?

        var json: String {
            let name = ["github": "GitHub", "linear": "Linear", "sentry": "Sentry"][plugin] ?? plugin
            let prefix = ordinal > 1 ? "plugin_\(plugin)_\(ordinal)_" : "plugin_\(plugin)_"
            func quoted(_ text: String?) -> String { text.map { "\"\($0)\"" } ?? "null" }
            return #"{"id":"\#(id)","plugin":"\#(plugin)","pluginName":"\#(name)","ordinal":\#(ordinal),"label":\#(quoted(label)),"status":"\#(status)","reason":null,"authMethod":\#(quoted(authMethod)),"toolPrefix":"\#(prefix)","image":{"digest":"\#(plugin)","mime":"image/png","thumbhash":null},"available":true}"#
        }
    }

    let manager: Bool
    private(set) var installations: [Installation] = [
        .init(id: "i1", plugin: "github", ordinal: 1, label: nil, status: "active", authMethod: "token"),
        .init(id: "i2", plugin: "github", ordinal: 2, label: "Acme", status: "not_configured", authMethod: nil),
    ]
    private var next = 3

    init(manager: Bool = true, installed: Bool = true) {
        self.manager = manager
        if !installed { installations = [] }
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        func ok(_ text: String, status: Int = 200) -> HTTP1Response { HTTP1Response(status: status, headers: ["content-type": "application/json"], body: Data(text.utf8)) }
        func refuse(_ status: Int, _ code: String, _ error: String) -> HTTP1Response { ok(#"{"code":"\#(code)","error":"\#(error)"}"#, status: status) }
        let sent = body.flatMap { try? JSONValue.decode($0) }
        let installation = path.hasPrefix("/v0/plugins/installations/") ? path.dropFirst("/v0/plugins/installations/".count).split(separator: "/").map(String.init) : []
        switch (method, path) {
        case ("GET", "/v0/bootstrap/desktop"): return ok(Self.bootstrap)
        case ("GET", "/v0/health"): return ok(#"{"ok":true}"#)
        case ("GET", "/v0/permissions"):
            return ok(manager ? #"{"granted":["content.write","bots.manage","mcp.manage","config.manage","providers.manage","providers.own"]}"# : #"{"granted":["content.write","providers.own"]}"#)
        case ("GET", "/v0/plugins"): return ok(Self.catalog)
        case ("GET", "/v0/plugins/installations"):
            guard manager else { return refuse(403, "forbidden", "This needs the mcp.manage permission.") }
            return ok(#"{"installations":[\#(installations.map(\.json).joined(separator: ","))]}"#)
        case ("POST", "/v0/plugins/installations"):
            guard manager else { return refuse(403, "forbidden", "This needs the mcp.manage permission.") }
            let plugin = sent?["plugin"]?.stringValue ?? ""
            let ordinal = (installations.filter { $0.plugin == plugin }.map(\.ordinal).max() ?? 0) + 1
            let made = Installation(id: "i\(next)", plugin: plugin, ordinal: ordinal, label: nil, status: plugin == "linear" ? "active" : "not_configured", authMethod: nil)
            next += 1
            installations.append(made)
            return ok(#"{"installation":\#(made.json)}"#, status: 201)
        default:
            break
        }
        if let id = installation.first, let index = installations.firstIndex(where: { $0.id == id }) {
            switch (method, installation.dropFirst().first) {
            case ("DELETE", nil):
                installations.remove(at: index)
                return ok(#"{"deleted":true,"secretsDeleted":1,"cleanedUpOutside":true}"#)
            case ("POST", "configure"):
                let values = sent?["values"]?.objectValue ?? [:]
                if values["token"]?.stringValue?.hasPrefix("bad") == true {
                    return ok(#"{"code":"invalid_fields","error":"Some fields were refused.","fields":{"token":"GitHub didn’t accept this token. Check that it hasn’t expired."}}"#, status: 422)
                }
                installations[index].status = "active"
                installations[index].authMethod = sent?["method"]?.stringValue
                return ok(#"{"installation":\#(installations[index].json)}"#)
            case ("POST", "connect"):
                return ok(#"{"authorizeUrl":"https://github.com/apps/happy-engineering/installations/new?state=harness"}"#)
            case ("POST", "disconnect"):
                installations[index].status = "not_configured"
                installations[index].authMethod = nil
                return ok(#"{"installation":\#(installations[index].json),"removed":["s1"]}"#)
            default:
                break
            }
        }
        if path.hasPrefix("/v0/plugins/images/"), let picture = Self.mark(String(path.dropFirst("/v0/plugins/images/".count))) {
            return HTTP1Response(status: 200, headers: ["content-type": "image/png"], body: picture)
        }
        return refuse(404, "not_found", "Not here.")
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.notConnectedToInternet) }
    func reset() async {}
    func close() async {}

    /// Each plugin's mark: its letter on its colour.
    private static func mark(_ digest: String) -> Data? {
        let marks: [String: (UIColor, String)] = [
            "github": (UIColor(red: 0.09, green: 0.1, blue: 0.12, alpha: 1), "G"),
            "linear": (UIColor(red: 0.37, green: 0.42, blue: 0.82, alpha: 1), "L"),
            "sentry": (UIColor(red: 0.21, green: 0.16, blue: 0.29, alpha: 1), "S"),
        ]
        guard let (color, letter) = marks[digest] else { return nil }
        let side: CGFloat = 120
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).pngData { _ in
            color.setFill()
            UIRectFill(CGRect(x: 0, y: 0, width: side, height: side))
            let text = NSAttributedString(string: letter, attributes: [.font: UIFont.systemFont(ofSize: 64, weight: .bold), .foregroundColor: UIColor.white])
            let size = text.size()
            text.draw(at: CGPoint(x: (side - size.width) / 2, y: (side - size.height) / 2))
        }
    }
}

/// A Happy Cloud server's home over `ClusterServer`
/// (`-screen cluster`), opened on its plugins (`-open plugins`) or one
/// plugin (`-open plugin:github`), as a member who can't manage them
/// (`-member`) or with nothing installed (`-fresh`), in dark (`-dark`).
@MainActor
final class ClusterHarness {
    private var account: AccountController?

    init(window: HarnessWindow, arguments: [String]) {
        Task { await open(window: window, arguments: arguments) }
    }

    private func open(window: HarnessWindow, arguments: [String]) async {
        let server = ClusterServer(manager: !arguments.contains("-member"), installed: !arguments.contains("-fresh"))
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/cluster",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in server },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: ClusterOffline(), connector: ClusterNoSocket()
        )
        self.account = account
        do {
            let origin = HappyCloud.server(named: "acme")
            let connection = try await account.agentConnections.addServer(AgentOrigin(origin),
                signIn: ServerSignInRecord(method: HappyCloud.method(server: origin), grant: OAuthGrant(clientId: "harness"), userId: "steve"),
                access: OAuthAccess(token: "harness", expiresAt: nil), name: "Acme")
            let context = AppContext(account: account, variant: .development, version: "cluster")
            guard let session = Session.session(for: connection.id, context: context) else { return }
            let home = AgentHomeViewController(context: context, id: connection.id)
            let navigation = UINavigationController(rootViewController: home)
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            window.rootViewController = navigation
            if arguments.contains("-dark") { window.overrideUserInterfaceStyle = .dark }
            window.layoutIfNeeded()
            let open = arguments.firstIndex(of: "-open").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
            try? await Task.sleep(for: .seconds(1))
            switch open {
            case "plugins":
                navigation.pushViewController(PluginsViewController(session: session), animated: false)
            case let open? where open.hasPrefix("plugin:"):
                navigation.pushViewController(PluginsViewController(session: session), animated: false)
                PluginScreens.open(pluginId: String(open.dropFirst("plugin:".count)), session: session, from: navigation)
            default:
                break
            }
        } catch {
            print("CLUSTER_HARNESS error: \(error)")
        }
    }
}
#endif
