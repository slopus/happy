#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
@testable import HappyCore
@testable import HappyUI
import HappyWire
import UIKit

private struct PeopleOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct PeopleNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A Happy Cloud team server, as happy-cluster answers: Steve signed in,
/// two tasks of his; search finds a task and two people for "ad" (Ada
/// with a picture, Adam without), and Ada's profile is served with her
/// numbers and the tasks she was last at.
private actor PeopleServer: AgentTransport {
    static let adaHash = "HBkSHYSIeHiPiHh8eJd4eTN0EEQG"
    static let steveHash = "1QcSHQRnh493V4dIh4eXh1h4kJUI"

    static let bootstrap = #"""
    {"cursor":"cursor-1","profile":{"userId":"steve","name":"Steve","photo":{"thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI"}},"userSettings":[],
     "projects":[],"workspaces":[],"bots":[],
     "tasks":[
       {"id":"mine","name":"Plan the launch","ownerUserId":"steve","status":"active","agent":{"id":"mine-agent","workspaceId":"w1","status":"idle"}},
       {"id":"review","name":"Ada's onboarding review","ownerUserId":"ada","status":"active","agent":{"id":"review-agent","workspaceId":"w2","status":"idle"}}],
     "taskMemberships":[{"taskId":"mine"},{"taskId":"review"}],
     "surfaces":[]}
    """#

    static func profile() -> String {
        let now = Date().timeIntervalSince1970 * 1000
        func ago(_ minutes: Double) -> Int { Int(now - minutes * 60_000) }
        return #"""
        {"user":{"id":"ada","name":"Ada Lovelace","photo":{"thumbhash":"\#(adaHash)"},"version":"1","updatedAt":1,"kind":"member","canLogIn":true,
                 "role":"Design lead","follows":null,"teamRole":"owner"},
         "stats":{"tasks":{"total":42,"active":3},"lastActivityAt":\#(ago(12)),"activeDays":18,
                  "usage":{"hour":{"anthropic":{"claude-opus-5":{"input":48000,"cacheRead":210000,"cacheWrite":12000,"output":9000,"reasoning":1500}}},
                           "day":{"anthropic":{"claude-opus-5":{"input":610000,"cacheRead":2400000,"cacheWrite":130000,"output":98000,"reasoning":21000}},
                                  "openai":{"gpt-6.1":{"input":90000,"cacheRead":0,"cacheWrite":0,"output":31000,"reasoning":12000}}},
                           "week":{"anthropic":{"claude-opus-5":{"input":3100000,"cacheRead":14000000,"cacheWrite":700000,"output":520000,"reasoning":90000}}},
                           "month":{"anthropic":{"claude-opus-5":{"input":12000000,"cacheRead":61000000,"cacheWrite":2900000,"output":2100000,"reasoning":400000}}}}},
         "recentTasks":[
           {"id":"review","name":"Ada's onboarding review","agent":{"id":"review-agent","workspaceId":"w2","status":"thinking","lastActivityAt":\#(ago(12))}},
           {"id":"icons","name":"Redraw the settings icons","agent":{"id":"icons-agent","workspaceId":"w3","status":"idle","lastActivityAt":\#(ago(190))}},
           {"id":"palette","name":"Dark mode palette pass","agent":{"id":"palette-agent","workspaceId":"w4","status":"idle","lastActivityAt":\#(ago(60 * 26))}},
           {"id":"audit","name":"Accessibility audit","agent":{"id":"audit-agent","workspaceId":"w5","status":"idle","archivedAt":1,"lastActivityAt":\#(ago(60 * 24 * 6))}}]}
        """#
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        func ok(_ text: String) -> HTTP1Response { HTTP1Response(status: 200, body: Data(text.utf8)) }
        if path == "/v0/bootstrap/desktop" { return ok(Self.bootstrap) }
        if path == "/v0/health" { return ok(#"{"ok":true,"capabilities":{"search":true}}"#) }
        if path == "/v0/search" {
            return ok(#"""
            {"results":[{"type":"agent","key":"agent:review-agent","rank":1,"agentId":"review-agent","workspaceId":"w2","kind":"task","title":"Ada's onboarding review"},
                        {"type":"user","key":"user:ada","rank":2,"userId":"ada","name":"Ada Lovelace"},
                        {"type":"user","key":"user:adam","rank":3,"userId":"adam","name":"Adam Novak"}],"truncated":false,"partial":false}
            """#)
        }
        if path.hasPrefix("/v0/users?ids=") {
            return ok(#"{"users":[{"id":"ada","name":"Ada Lovelace","photo":{"thumbhash":"\#(Self.adaHash)"}},{"id":"adam","name":"Adam Novak","photo":null},{"id":"steve","name":"Steve","photo":{"thumbhash":"\#(Self.steveHash)"}}]}"#)
        }
        if path == "/v0/roles" { return ok(#"{"roles":[{"id":"owner","name":"Owner","builtIn":true},{"id":"member","name":"Member","builtIn":true}]}"#) }
        if path.hasPrefix("/v0/users/ada/profile") { return ok(Self.profile()) }
        if let picture = Self.picture(path) { return HTTP1Response(status: 200, headers: ["content-type": "image/png"], body: picture) }
        return HTTP1Response(status: 404, body: Data(#"{"error":"Not here.","code":"not_found"}"#.utf8))
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.notConnectedToInternet) }
    func reset() async {}
    func close() async {}

    /// Faces served solid in their ThumbHash's colours: Steve blue, Ada red.
    private static func picture(_ path: String) -> Data? {
        let colors: [UIColor]
        switch path {
        case "/v0/users/steve/photo", "/v0/profile/photo": colors = [.systemBlue, .systemTeal]
        case "/v0/users/ada/photo": colors = [.systemRed, .systemOrange]
        default: return nil
        }
        return UIGraphicsImageRenderer(size: CGSize(width: 240, height: 240)).pngData { context in
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors.map(\.cgColor) as CFArray, locations: [0, 1])!
            context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 240, y: 240), options: [])
        }
    }
}

/// Home on a Happy Cloud server with "ad" typed into search
/// (`-screen people -open search`), or Ada's profile over it
/// (`-open profile`), for screenshots.
@MainActor
final class PeopleHarness {
    private var account: AccountController?

    init(window: HarnessWindow, arguments: [String]) {
        Task { await open(window: window, arguments: arguments) }
    }

    private func open(window: HarnessWindow, arguments: [String]) async {
        let server = PeopleServer()
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/people",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in server },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: PeopleOffline(), connector: PeopleNoSocket()
        )
        self.account = account
        do {
            let origin = HappyCloud.server(named: "acme")
            let connection = try await account.agentConnections.addServer(AgentOrigin(origin),
                signIn: ServerSignInRecord(method: HappyCloud.method(server: origin), grant: OAuthGrant(clientId: "harness"), userId: "steve"),
                access: OAuthAccess(token: "harness", expiresAt: nil), name: "Acme")
            let context = AppContext(account: account, variant: .development, version: "people")
            guard let session = Session.session(for: connection.id, context: context) else { return }
            let home = AgentHomeViewController(context: context, id: connection.id)
            let navigation = UINavigationController(rootViewController: home)
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            window.rootViewController = navigation
            window.layoutIfNeeded()
            if arguments.contains("-dark") { window.overrideUserInterfaceStyle = .dark }
            let open = arguments.firstIndex(of: "-open").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
            try? await Task.sleep(for: .seconds(1))
            switch open {
            case "search":
                home.search.begin()
                home.search.bar.text = "ad"
                home.search.updateSearchResults(for: home.search.controller)
            case "profile":
                navigation.pushViewController(UserProfileViewController(session: session, user: TeamUser(id: "ada", name: "Ada Lovelace")), animated: false)
            default:
                break
            }
        } catch {
            print("PEOPLE error: \(error)")
        }
    }
}
#endif
