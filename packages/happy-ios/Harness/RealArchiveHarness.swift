#if (DEBUG || HAPPY_FIXTURES) && canImport(UIKit)
import HappyCore
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit

/// Explicit opt-in only. Credentials live in memory and a one-use, mode-0600
/// file supplied to this isolated harness's Documents directory. Never shares
/// the real app's keychain, store, preferences, or screenshots.
private struct ArchiveCheckTransport: HTTPTransport {
    let base = URLSessionTransport()
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        guard request.method == "GET" || (request.method == "POST" &&
            ["/v1/auth", "/v1/account/settings"].contains(request.url.path)) else {
            throw URLError(.noPermissionsToReadFile)
        }
        return try await base.send(request)
    }
}
private struct ArchiveCheckNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

@MainActor
final class RealArchiveHarness {
    private let window: HarnessWindow
    private var account: AccountController?
    private var probe: HomeArchiveProbe?
    private let state = UILabel(frame: CGRect(x: 0, y: 0, width: 2, height: 2))
    private var originalHidden: Bool?
    private var observedBeforeHidden = true
    private var restoring = false
    private var total = 0
    private var archived = 0
    private var deferredRows = 0
    private var fallbackRows = 0
    private let restoreHiddenOnly = ProcessInfo.processInfo.arguments.contains("-restore-archive-hidden")
    private let runID = UUID().uuidString
    private let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]

    init(window: HarnessWindow) {
        self.window = window
        state.isAccessibilityElement = true
        state.accessibilityIdentifier = "home.real-archive-state"
        state.accessibilityValue = "loading"
        window.addSubview(state)
        Task { await open() }
    }

    private func open() async {
        let controller = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()),
            clientID: "ios/archive-regression", credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            localSettingsFactory: { _ in InMemoryKeyValueStore() },
            transport: ArchiveCheckTransport(), connector: ArchiveCheckNoSocket())
        account = controller
        do {
            try? FileManager.default.removeItem(at: documents.appendingPathComponent("archive-real-report.json"))
            let url = documents.appendingPathComponent("archive-recovery-secret")
            let secret = try await Task.detached {
                defer { try? FileManager.default.removeItem(at: url) }
                return try String(contentsOf: url, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            }.value
            let credentials = try await controller.authService.restore(secretKey: secret)
            try await controller.signIn(credentials)
            guard let session = controller.session else { throw URLError(.userAuthenticationRequired) }
            // run(.sessions) completes ALL pages, not merely the first snapshot.
            await session.sync.run(.sessions)
            await session.sync.run(.machines)
            await session.sync.run(.settings)
            await session.sync.run(.projects)
            let snapshot = try await Task.detached { try session.store.homeSnapshot() }.value
            // Recovery mode uses the already recorded baseline, never the
            // possibly temporary setting left by an aborted UI test.
            observedBeforeHidden = AccountSettings(snapshot.settings).hideArchivedSessions
            originalHidden = restoreHiddenOnly ? true : observedBeforeHidden
            total = snapshot.sessions.count
            archived = snapshot.sessions.filter(\.isArchived).count
            if restoreHiddenOnly { await restore(); return }
            guard snapshot.sessionsSynced, archived > 0 else { throw URLError(.zeroByteResource) }
            controller.localSettings.homeListRenderer = .ultraList
            let context = AppContext(account: controller, variant: .preview, version: "archive-regression")
            let navigation = UINavigationController(rootViewController: HomeViewController(context: context, session: session))
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            let shell = TabletShellViewController(context: context, detail: navigation)
            window.rootViewController = shell
            shell.rootDidChange()
            // Probe only unambiguous archived titles; no names leave the app.
            let details = await Task.detached {
                var shown = snapshot
                shown.settings.pending["hideInactiveSessions"] = .bool(false)
                let list = SessionList(shown)
                let rows = list.items.compactMap { item -> SessionRow? in
                    if case .session(let row) = item { return row }; return nil
                }
                let live = Set(rows.filter { !$0.archived }.map { $0.title ?? "New chat" })
                let prefixes = Set(rows.filter(\.archived).map { $0.title ?? "New chat" }).filter { title in
                    !live.contains { $0 == title || $0.hasPrefix(title + ",") }
                }
                let model = HomeListModel(list, offline: nil, expandedProjects: [])
                var deferred = 0, fallback = 0
                for row in model.rows {
                    let archived: Bool
                    switch row {
                    case .flat(.session(let value)): archived = value.archived
                    case .project(.archived): archived = true
                    default: archived = false
                    }
                    guard archived else { continue }
                    if HomeRowDrawing.canDeferArchiveText(row) { deferred += 1 }
                    else { fallback += 1 }
                }
                return (Array(prefixes), deferred, fallback)
            }.value
            deferredRows = details.1; fallbackRows = details.2
            probe = HomeArchiveProbe(window: window, snapshots: session.store.homeSnapshots(), archivedPrefixes: details.0)
            let restore = UIButton(type: .system)
            restore.setTitle("Restore visibility", for: .normal)
            restore.accessibilityIdentifier = "home.real-archive-restore"
            restore.backgroundColor = .systemBackground
            restore.frame = CGRect(x: 10, y: window.bounds.height - 65, width: 170, height: 40)
            restore.addAction(UIAction { [weak self] _ in Task { await self?.restore() } }, for: .touchUpInside)
            window.addSubview(restore)
            window.bringSubviewToFront(state)
            state.accessibilityValue = "ready; sessions=\(total); archived=\(archived); hidden=\(originalHidden == true)"
            // A test failure still restores while the harness remains alive.
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(180))
                await self?.restore()
            }
        } catch {
            state.accessibilityValue = "failed (details withheld)"
        }
    }

    private func restore() async {
        guard !restoring, let originalHidden, let session = account?.session else { return }
        restoring = true
        do {
            // No accepted tap may finish after the restore write and put
            // the temporary test choice back on the server.
            await session.archiveVisibilityWriter.flush()
            try await session.sync.updateSettings(["hideInactiveSessions": .bool(originalHidden)])
            await session.sync.run(.settings) // push, then fresh server pull
            let confirmed = try await Task.detached {
                let settings = try session.store.settingsSnapshot()
                return settings.pending.isEmpty && AccountSettings(settings).hideArchivedSessions == originalHidden
            }.value
            guard confirmed else { throw URLError(.cannotParseResponse) }
            let report: [String: Any] = ["sessions": total, "archived": archived,
                "runID": runID, "confirmedAt": ISO8601DateFormatter().string(from: Date()),
                "deferredArchiveRows": deferredRows, "eagerArchiveRows": fallbackRows,
                "originalHidden": originalHidden, "restoredAndServerConfirmed": true,
                "observedBeforeHidden": observedBeforeHidden,
                "samples": try JSONSerialization.jsonObject(with: probe?.report ?? Data("[]".utf8))]
            let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            let url = documents.appendingPathComponent("archive-real-report.json")
            try await Task.detached { try data.write(to: url, options: .atomic) }.value
            state.accessibilityValue = "restored; sessions=\(total); archived=\(archived); hidden=\(originalHidden)"
        } catch {
            restoring = false
            state.accessibilityValue = "restore failed (details withheld); retry Restore visibility"
        }
    }
}
#endif
