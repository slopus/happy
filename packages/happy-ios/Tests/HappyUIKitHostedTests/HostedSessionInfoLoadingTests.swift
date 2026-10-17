#if canImport(UIKit)
import Foundation
import HappyCore
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private struct DetailsNoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct DetailsNoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

private final class DetailsSource: @unchecked Sendable {
    private let lock = NSLock()
    private var continuations: [AsyncStream<SessionDetailSnapshot>.Continuation] = []
    private var failures: [@Sendable (SessionDetailFailure) -> Void] = []

    var starts: Int { lock.withLock { continuations.count } }

    func observe(_ onError: @escaping @Sendable (SessionDetailFailure) -> Void) -> AsyncStream<SessionDetailSnapshot> {
        let pair = AsyncStream<SessionDetailSnapshot>.makeStream()
        lock.withLock { continuations.append(pair.continuation); failures.append(onError) }
        return pair.stream
    }

    func yield(_ snapshot: SessionDetailSnapshot) {
        lock.withLock { continuations.last }?.yield(snapshot)
    }

    func fail(_ index: Int? = nil) {
        let pair = lock.withLock { () -> ((@Sendable (SessionDetailFailure) -> Void), AsyncStream<SessionDetailSnapshot>.Continuation)? in
            let offset = index ?? (failures.count - 1)
            guard failures.indices.contains(offset) else { return nil }
            return (failures[offset], continuations[offset])
        }
        guard let (callback, continuation) = pair else { XCTFail("The test observation has not started"); return }
        callback(SessionDetailFailure(kind: .database, code: 11))
        continuation.finish()
    }
}

@MainActor
final class HostedSessionInfoLoadingTests: XCTestCase {
    private func until(_ condition: () -> Bool) async throws -> Bool {
        let end = ContinuousClock.now + .seconds(5)
        while !condition(), ContinuousClock.now < end { try await Task.sleep(for: .milliseconds(10)) }
        return condition()
    }

    private func rows(_ info: UIViewController) -> [ItemRowView] {
        func descend(_ view: UIView) -> [ItemRowView] {
            view.subviews.flatMap { ($0 as? ItemRowView).map { [$0] } ?? descend($0) }
        }
        guard let list = info.view.subviews.compactMap({ $0 as? GroupedListView }).first else { return [] }
        return list.sections.flatMap { descend($0) }
    }

    private func fixture(attach: Bool = true) async throws -> (SessionInfoViewController, DetailsSource, SessionDetailSnapshot, UINavigationController, UIWindow) {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: DetailsNoNetwork(), connector: DetailsNoSockets()
        )
        try await controller.signIn(Credentials(token: "fixture", secret: Data(repeating: 7, count: 32)))
        let account = try XCTUnwrap(controller.session)
        let record = SessionRecord(
            id: "PRIVATE-session-id", seq: 3, createdAt: 1, updatedAt: 2, active: false, activeAt: 2, projectId: nil,
            metadataVersion: 1, metadataCipher: "PRIVATE-cipher",
            metadata: .object(["summary": .object(["text": .string("PRIVATE-title")]), "path": .string("/PRIVATE/path")]),
            agentStateVersion: 0, agentStateCipher: nil, agentState: nil, dataKeyCipher: nil, decryptable: true
        )
        let store = account.store
        try await Task.detached { try store.upsertSessions([record]) }.value
        let home = Task { for await _ in account.homeFeed.snapshots() {} }
        let ready = try await until { account.homeFeed.latest?.sessions.isEmpty == false }
        XCTAssertTrue(ready)
        let current = await account.sessionDetails.current(sessionId: record.id)
        let snapshot = try XCTUnwrap(current)
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let source = DetailsSource()
        let info = SessionInfoViewController(context: context, session: account, sessionId: record.id,
                                             firstPaintTimeout: .milliseconds(100), snapshots: { source.observe($0) })
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let navigation = UINavigationController(rootViewController: UIViewController())
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in
            home.cancel()
            window.isHidden = true
            hostWindow?.makeKey()
            await controller.signOut()
        }
        if attach { navigation.pushViewController(info, animated: false) }
        info.loadViewIfNeeded()
        return (info, source, snapshot, navigation, window)
    }

    func testNoFirstSnapshotShowsLoadingThenRetryAndLateDataCanStillAppear() async throws {
        let (info, source, snapshot, _, _) = try await fixture()
        XCTAssertTrue(rows(info).contains { $0.title == Strings.SessionDetail.loading })
        XCTAssertEqual(info.title, "PRIVATE-title")
        XCTAssertNotNil(info.navigationItem.rightBarButtonItem?.menu, "Copy is reachable even if the body is invisible")
        let delayed = try await until { self.rows(info).contains { $0.title == Strings.SessionInfoLoading.delayed } }
        XCTAssertTrue(delayed)
        XCTAssertEqual(info.title, "PRIVATE-title")
        let report = try XCTUnwrap(info.loadingDiagnostics().data(using: .utf8))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: report) as? [String: Any])
        let first = try XCTUnwrap(json["firstFailure"] as? [String: Any])
        XCTAssertEqual(first["stage"] as? String, "no-snapshot-or-apply")
        source.yield(snapshot)
        let recovered = try await until { self.rows(info).contains { $0.title == Strings.SessionDetail.happySessionId } }
        XCTAssertTrue(recovered)
        XCTAssertFalse(rows(info).contains { $0.title == Strings.SessionInfoLoading.delayed })
        XCTAssertEqual(source.starts, 1, "a delayed stream can recover without restarting it")
    }

    func testObservationFailureRetryIgnoresOldCallbacksAndPreservesGoodContent() async throws {
        let (info, source, snapshot, _, _) = try await fixture()
        source.fail()
        let failed = try await until { self.rows(info).contains { $0.title == Strings.SessionInfoLoading.failed } }
        XCTAssertTrue(failed)
        XCTAssertEqual(info.title, "PRIVATE-title")
        let retry = try XCTUnwrap(rows(info).first { $0.title == Strings.SessionInfoLoading.retry })
        retry.sendActions(for: .touchUpInside)
        XCTAssertEqual(source.starts, 2)
        source.fail(0)
        source.yield(snapshot)
        let recovered = try await until { self.rows(info).contains { $0.title == Strings.SessionDetail.happySessionId } }
        XCTAssertTrue(recovered)
        XCTAssertFalse(rows(info).contains { $0.title == Strings.SessionInfoLoading.failed })
        source.fail()
        let failedAgain = try await until { self.rows(info).contains { $0.title == Strings.SessionInfoLoading.failed } }
        XCTAssertTrue(failedAgain)
        let goodRow = try XCTUnwrap(rows(info).first { $0.title == Strings.SessionDetail.happySessionId })
        XCTAssertNotNil(goodRow.window)
        try XCTUnwrap(rows(info).first { $0.title == Strings.SessionInfoLoading.retry }).sendActions(for: .touchUpInside)
        XCTAssertTrue(rows(info).contains { $0 === goodRow }, "Retry retains the readable body")
        let text = info.loadingDiagnostics()
        for forbidden in ["PRIVATE", "/PRIVATE/path", "metadataCipher", "sessionId", "SELECT", "token", "secret"] {
            XCTAssertFalse(text.contains(forbidden), "report leaked \(forbidden)")
        }
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        let first = try XCTUnwrap(json["firstFailure"] as? [String: Any])
        let failure = try XCTUnwrap(first["storeFailure"] as? [String: Any])
        XCTAssertEqual(failure["category"] as? String, "database")
        XCTAssertEqual(failure["code"] as? Int, 11)
    }

    func testWatchdogDoesNotRunBeforeTheScreenAppears() async throws {
        let (info, _, _, navigation, _) = try await fixture(attach: false)
        try await Task.sleep(for: .milliseconds(250))
        XCTAssertFalse(info.loadingDiagnostics().contains("firstFailure"))
        XCTAssertTrue(rows(info).contains { $0.title == Strings.SessionDetail.loading })
        navigation.pushViewController(info, animated: false)
        let delayed = try await until { self.rows(info).contains { $0.title == Strings.SessionInfoLoading.delayed } }
        XCTAssertTrue(delayed)
    }

    func testWatchdogRestartsWhenTheVisibleScreenBecomesActiveAgain() async throws {
        let (info, _, _, _, _) = try await fixture()
        NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
        try await Task.sleep(for: .milliseconds(250))
        XCTAssertFalse(info.loadingDiagnostics().contains("firstFailure"), "inactive time is not a failed first paint")
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        let delayed = try await until { self.rows(info).contains { $0.title == Strings.SessionInfoLoading.delayed } }
        XCTAssertTrue(delayed, "a visible foreground attempt must get its own deadline")
    }
}
#endif