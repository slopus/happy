#if (DEBUG || HAPPY_FIXTURES) && canImport(UIKit)
import HappyCore
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit

private struct HomeHarnessOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}
private struct HomeHarnessNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// Drives the real Home screen with the existing seeded account, including
/// its dock, Settings navigation and live store observation. No live account.
@MainActor
final class HomeRendererHarness {
    private var account: AccountController?
    init(window: UIWindow, arguments: [String]) {
        func option(_ name: String) -> String? {
            arguments.firstIndex(of: name).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
        }
        let renderer = HomeListRenderer(rawValue: option("-renderer") ?? "UITableView") ?? .tableView
        let restoreRenderer = option("-renderer") == "stored"
        let grouping = option("-grouping") ?? "flat"
        let sessionCount = Int(option("-sessionCount") ?? "0") ?? 0
        Task {
            let controller = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/home-renderer-harness", credentialStore: InMemoryCredentialStore(), storeDirectory: nil, rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, localSettingsFactory: { UserDefaultsStore(suiteName: "home-renderer-harness.\($0)") }, transport: HomeHarnessOffline(), connector: HomeHarnessNoSocket())
            do {
                try await controller.signIn(Credentials(token: "home-harness", secret: Data(repeating: 19, count: 32)))
                guard let session = controller.session else { fatalError("Home harness missing session") }
                self.account = controller
                if !restoreRenderer { controller.localSettings.homeListRenderer = renderer }
                let store = session.store
                try await Task.detached {
                    try SeededAccount.seed(store)
                    if sessionCount > 0, let template = try store.sessions().first {
                        try store.upsertSessions((0..<sessionCount).map { index in
                            var row = template
                            row.id = "stress-\(index)"
                            row.createdAt += Int64(index)
                            var metadata = row.metadata?.objectValue ?? [:]
                            metadata["lastMeaningfulMessageAt"] = .number(Double(SeededAccount.base + Int64(index)))
                            metadata["summary"] = .object(["text": .string("Session \(index)")])
                            row.metadata = .object(metadata)
                            return row
                        })
                    }
                    try store.addPendingSettings(["sessionListGrouping": .string(grouping), "hideInactiveSessions": .bool(false)])
                }.value
                let context = AppContext(account: controller, variant: .development, version: "home-harness")
                let home = HomeViewController(context: context, session: session)
                let navigation = UINavigationController(rootViewController: home)
                AppCoordinator.applyAppearance(to: navigation.navigationBar)
                let shell = TabletShellViewController(context: context, detail: navigation)
                window.rootViewController = shell
                shell.rootDidChange()
            } catch { fatalError("Home harness: \(error)") }
        }
    }
}
#endif
