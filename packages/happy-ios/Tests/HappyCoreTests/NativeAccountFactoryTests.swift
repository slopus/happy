import Foundation
import HappyCore
import XCTest

final class NativeAccountFactoryTests: XCTestCase {
    @MainActor
    func testIOSCompositionKeepsOriginalKeychainServices() async {
        let backend = RecordingAccountKeychain()
        let account = NativeAccountFactory.make(version: "test", directory: nil, backend: backend,
            importLegacyServer: { .confirmed(ServerConfig.defaultServerURL) })
        await account.restore()
        XCTAssertTrue(backend.services.contains("app:no-auth"))
        XCTAssertTrue(backend.services.contains("happy-ios:account"))
        XCTAssertFalse(backend.services.contains { $0.hasPrefix("com.slopus.happy.native.mac") })
        XCTAssertEqual(account.clientID, HappyClientID.make(version: "test"))
    }

    func testMacNamespacesEveryKeychainOperationWithoutChangingItemShape() throws {
        let base = RecordingAccountKeychain()
        let backend = NamespacedKeychainBackend(base: base, namespace: "mac.variant")
        let item = SecureStoreItem(key: "auth_credentials").writeTarget
        _ = try backend.copyData(item)
        _ = try backend.add(item, data: Data(), accessibility: .whenUnlocked)
        try backend.update(item, data: Data())
        backend.delete(item)
        try backend.removeAccount(item)
        _ = try backend.accounts(service: "happy-ios:account")
        XCTAssertEqual(base.services.filter { $0 == "mac.variant:app:no-auth" }.count, 5)
        XCTAssertTrue(base.services.contains("mac.variant:happy-ios:account"))
        XCTAssertEqual(base.queries.first?.account, item.account)
        XCTAssertEqual(base.queries.first?.generic, item.generic)
    }
}

private final class RecordingAccountKeychain: AccountKeychainBackend, @unchecked Sendable {
    private let lock = NSLock()
    private var recordedServices: [String] = []
    private var recordedQueries: [KeychainItemQuery] = []
    var services: [String] { lock.withLock { recordedServices } }
    var queries: [KeychainItemQuery] { lock.withLock { recordedQueries } }
    private func record(_ query: KeychainItemQuery) {
        lock.withLock { recordedServices.append(query.service); recordedQueries.append(query) }
    }
    func copyData(_ query: KeychainItemQuery) throws -> Data? { record(query); return nil }
    func add(_ query: KeychainItemQuery, data: Data, accessibility: KeychainAccessibility) throws -> KeychainAddResult { record(query); return .added }
    func update(_ query: KeychainItemQuery, data: Data) throws { record(query) }
    func delete(_ query: KeychainItemQuery) { record(query) }
    func removeAccount(_ query: KeychainItemQuery) throws { record(query) }
    func accounts(service: String) throws -> [String] { lock.withLock { recordedServices.append(service) }; return [] }
}