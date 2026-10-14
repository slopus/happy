import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

@MainActor
final class AccountCacheLifecycleTests: XCTestCase {
    private let path = "/repo/private.swift"

    private func root() -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    private func snapshot(_ text: String) -> FileViewer.Snapshot {
        FileViewer.Snapshot(content: .init(content: text, isBinary: false), diff: nil)
    }

    private func account(_ seed: UInt8, root: URL? = nil, filesOverride: URL? = nil) async throws -> AccountSession {
        try await Task.detached {
            let credentials = Credentials(token: "test", secret: Data(repeating: seed, count: 32))
            var files = filesOverride
            var cacheDirectory: URL?
            let store: LocalStore
            if let root {
                let id = try accountID(credentials)
                try AccountSession.prepareDirectory(directory: root, id: id)
                let accountDirectory = AccountSession.accountDirectory(directory: root, id: id)
                files = accountDirectory.appendingPathComponent("files", isDirectory: true)
                cacheDirectory = SessionFileCache.directory(inAccount: accountDirectory)
                store = try LocalStore.open(at: accountDirectory.appendingPathComponent("store.sqlite"))
            } else {
                store = try LocalStore.inMemory()
            }
            return try AccountSession(
                credentials: credentials, store: store,
                dependencies: .init(serverURL: URL(string: "https://test.invalid")!, clientID: "ios/test", transport: FakeHTTP(), connector: FakeConnector()),
                filesDirectory: files, fileCacheDirectory: cacheDirectory
            )
        }.value
    }

    private func controller(root: URL, keychain: AccountsKeychain) -> AccountController {
        AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: SecureStoreCredentialStore(backend: keychain), storeDirectory: root,
            accountCredentialStore: KeychainAccountCredentialStore(backend: keychain),
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: FakeHTTP(), connector: FakeConnector()
        )
    }

    func testStopClosesOnlyItsOwnFourCachesAndLateUseCannotReopenThem() async throws {
        let first = try await account(1), second = try await account(2)
        XCTAssertFalse(first.diffDocuments === second.diffDocuments)
        XCTAssertFalse(first.diffSyntax === second.diffSyntax)
        XCTAssertFalse(first.codeSyntax === second.codeSyntax)
        XCTAssertFalse(first.fileCache === second.fileCache)
        let input = DiffSyntax.Input(language: "python", lines: [.init(text: "return privateValue", type: .ctx)])
        let source = DiffFileItem.Source.contents(path: path, oldText: "old", newText: "new")
        await Task.detached {
            for session in [first, second] {
                XCTAssertFalse(DiffFileItem.document(source, cache: session.diffDocuments).files.isEmpty)
                _ = session.diffSyntax.result("same-key", input)
                _ = session.codeSyntax.tokens("return privateValue", language: "python", until: .now.advanced(by: .seconds(5)))
            }
        }.value
        first.fileCache.set(sessionId: "same", path: path, snapshot("first"))
        second.fileCache.set(sessionId: "same", path: path, snapshot("second"))
        await first.stop()
        await first.stop()
        XCTAssertTrue(first.diffDocuments.isClosed)
        XCTAssertTrue(first.diffSyntax.isClosed)
        XCTAssertTrue(first.codeSyntax.isClosed)
        XCTAssertTrue(first.fileCache.isClosed)
        XCTAssertEqual(first.diffDocuments.retainedUsage.count, 0)
        XCTAssertEqual(first.diffSyntax.retainedUsage.results, 0)
        XCTAssertEqual(first.codeSyntax.retainedUsage.count, 0)
        XCTAssertFalse(second.diffDocuments.isClosed)
        XCTAssertFalse(second.diffSyntax.isClosed)
        XCTAssertFalse(second.codeSyntax.isClosed)
        XCTAssertFalse(second.fileCache.isClosed)
        XCTAssertEqual(second.diffDocuments.retainedUsage.count, 1)
        XCTAssertNotNil(second.diffSyntax.peek("same-key"))
        XCTAssertGreaterThan(second.codeSyntax.retainedUsage.count, 0)
        let late = await Task.detached {
            let document = DiffFileItem.document(source, cache: first.diffDocuments)
            let code = first.codeSyntax.tokens("late privateValue", language: "python")
            return (document, code)
        }.value
        XCTAssertTrue(late.0.files.isEmpty)
        XCTAssertEqual(late.1, .plain)
        first.fileCache.set(sessionId: "same", path: path, snapshot("late"))
        XCTAssertNil(first.fileCache.get(sessionId: "same", path: path))
        XCTAssertEqual(second.fileCache.get(sessionId: "same", path: path), snapshot("second"))
        await second.stop()
    }

    func testFilesDirectoryWithoutExplicitCacheDirectoryRemainsMemoryOnly() async throws {
        let customFiles = root().appendingPathComponent("files", isDirectory: true)
        let session = try await account(3, filesOverride: customFiles)
        XCTAssertNil(session.fileCache.disk)
        session.fileCache.set(sessionId: "same", path: path, snapshot("memory"))
        XCTAssertEqual(session.fileCache.get(sessionId: "same", path: path), snapshot("memory"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: customFiles.deletingLastPathComponent().path))
        await session.stop()
    }

    func testControllerRestorePreparesAccountCacheAndRestartGetsFreshOwnerWithSeenFile() async throws {
        let root = root(), keychain = AccountsKeychain()
        keychain.items.seed(SecureStoreCredentialStore.item.writeTarget, Data(TokenStorageFixtures.typicalJSON.utf8))
        let firstController = controller(root: root, keychain: keychain)
        await firstController.restore()
        let first = try XCTUnwrap(firstController.session)
        let expected = SessionFileCache.directory(inAccount: AccountSession.accountDirectory(directory: root, id: first.keys.anonID))
        XCTAssertEqual(first.fileCache.disk?.directory, expected)
        XCTAssertTrue(FileManager.default.fileExists(atPath: expected.path))
        first.fileCache.set(sessionId: "same", path: path, snapshot("seen before restart"))
        await first.stop()
        let restartedController = controller(root: root, keychain: keychain)
        await restartedController.restore()
        let restarted = try XCTUnwrap(restartedController.session)
        XCTAssertFalse(restarted.fileCache === first.fileCache)
        XCTAssertFalse(restarted.fileCache.isClosed)
        let persisted = await restarted.fileCache.snapshot(sessionId: "same", path: path)
        XCTAssertEqual(persisted, snapshot("seen before restart"))
        await restarted.stop()
    }

    func testSignOutWaitsForCacheCloseBeforeRemovingDirectoryAndLateSetCannotRecreateIt() async throws {
        let root = root(), keychain = AccountsKeychain()
        keychain.items.seed(SecureStoreCredentialStore.item.writeTarget, Data(TokenStorageFixtures.typicalJSON.utf8))
        let account = controller(root: root, keychain: keychain)
        await account.restore()
        let session = try XCTUnwrap(account.session)
        let directory = AccountSession.accountDirectory(directory: root, id: session.keys.anonID)
        let disk = try XCTUnwrap(session.fileCache.disk)
        session.fileCache.set(sessionId: "same", path: path, snapshot("queued"))
        let release = disk.hold()
        defer { release() }
        let removal = Task { try await account.signOut(accountID: session.keys.anonID) }
        await eventually { session.fileCache.isClosed }
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.path), "removal must await the held disk writer")
        release()
        try await removal.value
        XCTAssertNil(account.session)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        session.fileCache.set(sessionId: "same", path: path, snapshot("late"))
        await disk.drain()
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        let late = await session.fileCache.snapshot(sessionId: "same", path: path)
        XCTAssertNil(late)
    }

    func testDeleteSessionRoutePurgesMemoryAndDiskWithoutTouchingOtherSessionOrAccount() async throws {
        let root = root(), first = try await account(4, root: root), second = try await account(5, root: root)
        first.fileCache.set(sessionId: "deleted", path: path, snapshot("first"))
        first.fileCache.set(sessionId: "kept", path: path, snapshot("kept"))
        second.fileCache.set(sessionId: "deleted", path: path, snapshot("second"))
        await first.fileCache.disk?.drain()
        await second.fileCache.disk?.drain()
        let (stream, status) = AsyncStream<RealtimeStatus>.makeStream()
        _ = stream
        let update: JSONValue = .object([
            "id": .string("delete"), "seq": .number(1), "createdAt": .number(1),
            "body": .object(["t": .string("delete-session"), "sid": .string("deleted")]),
        ])
        await AccountSession.route(.event(name: "update", payload: update), sync: first.sync, status: status, fileCache: first.fileCache)
        status.finish()
        await first.fileCache.disk?.drain()
        XCTAssertNil(first.fileCache.get(sessionId: "deleted", path: path))
        XCTAssertEqual(first.fileCache.get(sessionId: "kept", path: path), snapshot("kept"))
        XCTAssertEqual(second.fileCache.get(sessionId: "deleted", path: path), snapshot("second"))
        await first.stop()
        let restarted = try await account(4, root: root)
        let deleted = await restarted.fileCache.snapshot(sessionId: "deleted", path: path)
        let kept = await restarted.fileCache.snapshot(sessionId: "kept", path: path)
        XCTAssertNil(deleted)
        XCTAssertEqual(kept, snapshot("kept"))
        await restarted.stop()
        await second.stop()
    }

    func testOptionalCachePreparationFailureStillOpensPrimaryAccountStore() async throws {
        let root = root()
        let credentials = Credentials(token: "test", secret: Data(repeating: 6, count: 32))
        let directory = AccountSession.accountDirectory(directory: root, id: try accountID(credentials))
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let cacheDirectory = SessionFileCache.directory(inAccount: directory)
        let marker = Data("a file blocks only the optional cache".utf8)
        try marker.write(to: cacheDirectory)
        let session = try await account(6, root: root)
        try await Task.detached { try session.store.setCursor(.sessionsChangedSince, 42) }.value
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("store.sqlite").path))
        session.fileCache.set(sessionId: "same", path: path, snapshot("memory"))
        await session.fileCache.disk?.drain()
        XCTAssertEqual(session.fileCache.get(sessionId: "same", path: path), snapshot("memory"))
        XCTAssertEqual(try Data(contentsOf: cacheDirectory), marker)
        await session.stop()
    }

    func testInitialRootFailureKeepsControllerFileCacheInMemory() async throws {
        let root = root(), keychain = AccountsKeychain()
        let marker = Data("blocked root".utf8)
        try marker.write(to: root)
        keychain.items.seed(SecureStoreCredentialStore.item.writeTarget, Data(TokenStorageFixtures.typicalJSON.utf8))
        let account = controller(root: root, keychain: keychain)
        await account.restore()
        let session = try XCTUnwrap(account.session)
        XCTAssertNil(session.fileCache.disk)
        session.fileCache.set(sessionId: "same", path: path, snapshot("memory"))
        XCTAssertEqual(session.fileCache.get(sessionId: "same", path: path), snapshot("memory"))
        XCTAssertEqual(try Data(contentsOf: root), marker)
        await session.stop()
    }

    func testExplicitDocumentOwnerPreservesContextWhitespaceAndBudgetOptions() async {
        await Task.detached {
            let cache = DiffDocumentCache()
            let context = DiffFileItem.Source.contents(path: "a.ts", oldText: "before\nold\nafter\n", newText: "before\nnew\nafter\n", contextLines: 0)
            let document = DiffFileItem.document(context, cache: cache)
            XCTAssertEqual(document.files.first?.rows.compactMap(\.line).map(\.text), ["old", "new"])
            let whitespace = DiffFileItem.Source.contents(path: "a.ts", oldText: "old\n", newText: " old\n", ignoreWhitespace: true)
            let ignored = DiffFileItem.document(whitespace, cache: cache)
            XCTAssertEqual(ignored.additions, 0)
            XCTAssertEqual(ignored.deletions, 0)
            let old = (0..<400).map { "a\($0)" }.joined(separator: "\n")
            let new = (0..<400).map { "b\($0)" }.joined(separator: "\n")
            let budget = DiffFileItem.Source.contents(path: "a.ts", oldText: old, newText: new,
                budget: DiffEngine.Budget(timeoutMs: 10_000, maxEditLength: 10))
            XCTAssertEqual(DiffFileItem.document(budget, cache: cache).error, DiffEngine.tooLargeError)
            cache.close()
        }.value
    }
}