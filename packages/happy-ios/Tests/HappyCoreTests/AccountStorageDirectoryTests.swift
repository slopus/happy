import Foundation
import XCTest
@testable import HappyCore
import HappyStore

@MainActor
final class AccountStorageDirectoryTests: XCTestCase {
    private func missingRoot() -> URL {
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: parent) }
        return parent.appendingPathComponent("Support/Happy", isDirectory: true)
    }

    func testRegistryLoadPreparesRootBeforeAnyAccountExists() async throws {
        let root = missingRoot()
        let registry = try await AccountRegistryWriter().load(directory: root)
        XCTAssertEqual(registry, AccountRegistry())
        var isDirectory: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory))
        XCTAssertTrue(isDirectory.boolValue)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("accounts").path))
        #if canImport(Darwin)
        XCTAssertEqual(try root.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        #endif
    }

    func testWriterPreparesRootBeforeSavingAndRejectsStaleWorkBeforeIO() async throws {
        let root = missingRoot()
        let writer = AccountRegistryWriter { value, directory in
            dispatchPrecondition(condition: .notOnQueue(.main))
            let directory = try XCTUnwrap(directory)
            XCTAssertEqual(directory, root, "stale work must not reach the save closure")
            XCTAssertTrue(FileManager.default.fileExists(atPath: directory.path))
            try value.save(directory: directory)
        }
        let written = try await writer.save(AccountRegistry(), directory: root, revision: 2)
        XCTAssertTrue(written)
        let unusedRoot = missingRoot()
        let stale = try await writer.save(AccountRegistry(), directory: unusedRoot, revision: 1)
        XCTAssertFalse(stale)
        XCTAssertFalse(FileManager.default.fileExists(atPath: unusedRoot.path))
        let loaded = try await writer.load(directory: root)
        XCTAssertEqual(loaded, AccountRegistry())
    }

    func testPreparationFailureLeavesExistingFileAndInvalidatesOlderWrite() async throws {
        let root = missingRoot()
        try FileManager.default.createDirectory(at: root.deletingLastPathComponent(), withIntermediateDirectories: true)
        let bytes = Data("existing file".utf8)
        try bytes.write(to: root)
        let writer = AccountRegistryWriter { _, _ in XCTFail("save must not run when root preparation fails") }
        do {
            _ = try await writer.load(directory: root)
            XCTFail("a file at the root must fail")
        } catch { }
        do {
            _ = try await writer.save(AccountRegistry(), directory: root, revision: 2)
            XCTFail("root preparation must fail before save")
        } catch { }
        let unusedRoot = missingRoot()
        let stale = try await writer.save(AccountRegistry(), directory: unusedRoot, revision: 1)
        XCTAssertFalse(stale)
        XCTAssertFalse(FileManager.default.fileExists(atPath: unusedRoot.path))
        XCTAssertEqual(try Data(contentsOf: root), bytes)
    }

    func testControllerRestoreCreatesRootWithoutSigningIn() async throws {
        let root = missingRoot()
        let keychain = AccountsKeychain()
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: SecureStoreCredentialStore(backend: keychain), storeDirectory: root,
            accountCredentialStore: KeychainAccountCredentialStore(backend: keychain),
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: FakeHTTP(), connector: FakeConnector()
        )
        await controller.restore()
        XCTAssertNil(controller.session)
        XCTAssertTrue(controller.accounts.isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.path))
    }

    func testNilDirectoryKeepsRegistryInMemory() async throws {
        let writer = AccountRegistryWriter()
        let registry = try await writer.load(directory: nil)
        XCTAssertEqual(registry, AccountRegistry())
        let written = try await writer.save(registry, directory: nil, revision: 1)
        XCTAssertTrue(written)
    }
}