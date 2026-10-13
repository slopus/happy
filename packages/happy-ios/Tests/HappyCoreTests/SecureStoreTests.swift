import Foundation
@testable import HappyCore
import XCTest

/// A Keychain in memory with SecItem's matching rules for generic
/// passwords: service and account are the primary key, and a query matches
/// only when its generic attribute matches too. It records every call.
final class FakeKeychain: KeychainBackend, @unchecked Sendable {
    enum Call: Equatable {
        case copy(String)
        case add(String, String, KeychainAccessibility)
        case update(String, String)
        case delete(String)
    }

    struct Stored {
        var generic: Data
        var data: Data
        var accessibility: KeychainAccessibility?
    }

    private let lock = NSLock()
    private var items: [String: Stored] = [:]
    private var _calls: [Call] = []
    /// Statuses to throw from copyData, by service.
    var copyFailures: [String: Int32] = [:]

    var calls: [Call] {
        lock.withLock { _calls }
    }

    var services: [String] {
        lock.withLock { items.keys.map { String($0.split(separator: "|")[0]) }.sorted() }
    }

    func stored(_ query: KeychainItemQuery) -> Stored? {
        lock.withLock { items[key(query)] }
    }

    /// An item as another app build left it.
    func seed(_ query: KeychainItemQuery, _ data: Data, accessibility: KeychainAccessibility? = .whenUnlocked) {
        lock.withLock { items[key(query)] = Stored(generic: query.generic, data: data, accessibility: accessibility) }
    }

    func resetCalls() {
        lock.withLock { _calls = [] }
    }

    private func key(_ query: KeychainItemQuery) -> String {
        query.service + "|" + query.account.base64EncodedString()
    }

    private func match(_ query: KeychainItemQuery) -> Stored? {
        guard let item = items[key(query)], item.generic == query.generic else { return nil }
        return item
    }

    func copyData(_ query: KeychainItemQuery) throws -> Data? {
        try lock.withLock {
            _calls.append(.copy(query.service))
            if let status = copyFailures[query.service] { throw KeychainStatusError(status) }
            return match(query)?.data
        }
    }

    func add(_ query: KeychainItemQuery, data: Data, accessibility: KeychainAccessibility) throws -> KeychainAddResult {
        lock.withLock {
            _calls.append(.add(query.service, String(decoding: data, as: UTF8.self), accessibility))
            if items[key(query)] != nil { return .duplicate }
            items[key(query)] = Stored(generic: query.generic, data: data, accessibility: accessibility)
            return .added
        }
    }

    func update(_ query: KeychainItemQuery, data: Data) throws {
        try lock.withLock {
            _calls.append(.update(query.service, String(decoding: data, as: UTF8.self)))
            guard var item = match(query) else { throw KeychainStatusError(-25300) }
            item.data = data
            items[key(query)] = item
        }
    }

    func delete(_ query: KeychainItemQuery) {
        lock.withLock {
            _calls.append(.delete(query.service))
            if match(query) != nil { items[key(query)] = nil }
        }
    }
}

/// What `JSON.stringify` in tokenStorage.ts writes, captured from Node:
/// `JSON.stringify({ token, secret })` for each case.
enum TokenStorageFixtures {
    /// A base64url secret, as createAccount and QR restore store it.
    static let secretBytes = Data((0..<32).map { UInt8(truncatingIfNeeded: $0 * 37 + 11) })
    static let typical = Credentials(
        token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbHgxIn0.c2lnbmF0dXJl",
        secret: "CzBVep_E6Q4zWH2ix-wRNluApcrvFDleg6jN8hc8YYY"
    )
    static let typicalJSON = #"{"token":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbHgxIn0.c2lnbmF0dXJl","secret":"CzBVep_E6Q4zWH2ix-wRNluApcrvFDleg6jN8hc8YYY"}"#

    /// Standard padded base64, which the manual restore screen stores when
    /// the key is pasted that way. Slashes stay unescaped.
    static let padded = Credentials(token: "t/with/slashes", secret: "//r18Ovm4dzX0s3Iw765tK+qpaCblpGMh4J9eHNuaWQ=")
    static let paddedJSON = #"{"token":"t/with/slashes","secret":"//r18Ovm4dzX0s3Iw765tK+qpaCblpGMh4J9eHNuaWQ="}"#

    /// Every escape JSON.stringify makes, plus text it leaves alone.
    static let escaped = Credentials(token: "q\"b\\n\nt\tc\u{01}\u{1f} é 🙂  ", secret: "s")
    static let escapedJSON = #"{"token":"q\"b\\n\nt\tc\u0001\u001f é 🙂  ","secret":"s"}"#
}

final class SecureStoreItemTests: XCTestCase {
    let item = SecureStoreCredentialStore.item
    let key = Data("auth_credentials".utf8)

    func testItemDescriptionMatchesExpoSecureStore() {
        XCTAssertEqual(item.key, "auth_credentials")
        XCTAssertEqual(item.keychainService, "app")
        XCTAssertEqual(item.query(requireAuthentication: false), KeychainItemQuery(service: "app:no-auth", account: key, generic: key))
        XCTAssertEqual(item.query(requireAuthentication: true), KeychainItemQuery(service: "app:auth", account: key, generic: key))
        XCTAssertEqual(item.query(requireAuthentication: nil), KeychainItemQuery(service: "app", account: key, generic: key))
    }

    func testLookupWriteAndDeleteOrders() {
        XCTAssertEqual(item.readOrder.map(\.service), ["app:no-auth", "app:auth", "app"])
        XCTAssertEqual(item.writeTarget.service, "app:no-auth")
        XCTAssertEqual(item.supersededByWrite.map(\.service), ["app", "app:auth"])
        XCTAssertEqual(item.deleteOrder.map(\.service), ["app", "app:auth", "app:no-auth"])
        for query in item.readOrder + item.deleteOrder {
            XCTAssertEqual(query.account, key)
            XCTAssertEqual(query.generic, key)
        }
    }

    func testReadsFallBackInExpoOrder() throws {
        let keychain = FakeKeychain()
        keychain.seed(item.query(requireAuthentication: nil), Data("legacy".utf8))
        XCTAssertEqual(try item.read(from: keychain), "legacy")
        XCTAssertEqual(keychain.calls, [.copy("app:no-auth"), .copy("app:auth"), .copy("app")])

        keychain.resetCalls()
        keychain.seed(item.writeTarget, Data("current".utf8))
        XCTAssertEqual(try item.read(from: keychain), "current")
        XCTAssertEqual(keychain.calls, [.copy("app:no-auth")])
    }

    func testMissingItemReadsAsNil() throws {
        let keychain = FakeKeychain()
        XCTAssertNil(try item.read(from: keychain))
        XCTAssertEqual(keychain.calls.count, 3)
    }

    func testKeychainErrorsStopTheLookup() {
        let keychain = FakeKeychain()
        // errSecInteractionNotAllowed: a WhenUnlocked item while locked.
        keychain.copyFailures["app:no-auth"] = -25308
        keychain.seed(item.query(requireAuthentication: nil), Data("legacy".utf8))
        XCTAssertThrowsError(try item.read(from: keychain)) {
            XCTAssertEqual($0 as? KeychainStatusError, KeychainStatusError(-25308))
        }
        XCTAssertEqual(keychain.calls, [.copy("app:no-auth")])
    }

    func testNonUTF8ValueReadsAsNil() throws {
        let keychain = FakeKeychain()
        keychain.seed(item.writeTarget, Data([0xFF, 0xFE]))
        XCTAssertNil(try item.read(from: keychain))
    }

    func testFirstWriteAddsWhenUnlockedAndClearsOlderItems() throws {
        let keychain = FakeKeychain()
        keychain.seed(item.query(requireAuthentication: nil), Data("legacy".utf8))
        try item.write("new", to: keychain)
        XCTAssertEqual(keychain.calls, [
            .add("app:no-auth", "new", .whenUnlocked),
            .delete("app"),
            .delete("app:auth"),
        ])
        XCTAssertEqual(keychain.services, ["app:no-auth"])
        XCTAssertEqual(keychain.stored(item.writeTarget)?.accessibility, .whenUnlocked)
    }

    func testLaterWritesUpdateInPlace() throws {
        let keychain = FakeKeychain()
        keychain.seed(item.writeTarget, Data("old".utf8))
        try item.write("new", to: keychain)
        XCTAssertEqual(keychain.calls, [.add("app:no-auth", "new", .whenUnlocked), .update("app:no-auth", "new")])
        XCTAssertEqual(try item.read(from: keychain), "new")
    }

    func testDeleteRemovesEveryVariant() {
        let keychain = FakeKeychain()
        for query in item.readOrder { keychain.seed(query, Data("x".utf8)) }
        item.delete(from: keychain)
        XCTAssertEqual(keychain.calls, [.delete("app"), .delete("app:auth"), .delete("app:no-auth")])
        XCTAssertEqual(keychain.services, [])
    }
}

final class CredentialsJSONTests: XCTestCase {
    func testEncodingMatchesJSONStringify() {
        XCTAssertEqual(CredentialsJSON.encode(TokenStorageFixtures.typical), TokenStorageFixtures.typicalJSON)
        XCTAssertEqual(CredentialsJSON.encode(TokenStorageFixtures.padded), TokenStorageFixtures.paddedJSON)
        XCTAssertEqual(CredentialsJSON.encode(TokenStorageFixtures.escaped), TokenStorageFixtures.escapedJSON)
    }

    func testDecodesWhatTokenStorageWrites() {
        XCTAssertEqual(CredentialsJSON.decode(TokenStorageFixtures.typicalJSON), TokenStorageFixtures.typical)
        XCTAssertEqual(CredentialsJSON.decode(TokenStorageFixtures.paddedJSON), TokenStorageFixtures.padded)
        XCTAssertEqual(CredentialsJSON.decode(TokenStorageFixtures.escapedJSON), TokenStorageFixtures.escaped)
        // JSON.parse accepts any key order, whitespace and extra fields.
        XCTAssertEqual(
            CredentialsJSON.decode(#"{ "secret": "s", "token": "t", "extra": 1 }"#),
            Credentials(token: "t", secret: "s")
        )
        XCTAssertNil(CredentialsJSON.decode("not json"))
        XCTAssertNil(CredentialsJSON.decode(#"{"token":"t"}"#))
    }

    func testEverySecretFormTheRNAppStoresDecodes() {
        XCTAssertEqual(TokenStorageFixtures.typical.secretData, TokenStorageFixtures.secretBytes)
        XCTAssertEqual(TokenStorageFixtures.padded.secretData?.count, 32)
        // New secrets are written the way createAccount writes them.
        let written = Credentials(token: "t", secret: TokenStorageFixtures.secretBytes)
        XCTAssertEqual(written.secret, TokenStorageFixtures.typical.secret)
    }
}

final class SecureStoreCredentialStoreTests: XCTestCase {
    let rnItem = SecureStoreCredentialStore.item.query(requireAuthentication: false)

    func testReadsTheRNAppsItem() throws {
        let keychain = FakeKeychain()
        keychain.seed(rnItem, Data(TokenStorageFixtures.typicalJSON.utf8))
        let store = SecureStoreCredentialStore(backend: keychain)
        XCTAssertEqual(try store.load(), TokenStorageFixtures.typical)
    }

    func testWritesBytesTheRNAppReads() throws {
        let keychain = FakeKeychain()
        try SecureStoreCredentialStore(backend: keychain).save(TokenStorageFixtures.typical)
        XCTAssertEqual(keychain.stored(rnItem)?.data, Data(TokenStorageFixtures.typicalJSON.utf8))
    }

    func testUnparseableItemLoadsAsNone() throws {
        let keychain = FakeKeychain()
        keychain.seed(rnItem, Data("{".utf8))
        XCTAssertNil(try SecureStoreCredentialStore(backend: keychain).load())
    }

    @MainActor
    func testRestoreFailureAndSignedOutLogoutKeepTheSharedItem() async throws {
        let keychain = FakeKeychain()
        // A secret that isn't 32 bytes can't open an account.
        keychain.seed(rnItem, Data(#"{"token":"t","secret":"c2hvcnQ"}"#.utf8))
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()),
            clientID: "ios/test",
            credentialStore: SecureStoreCredentialStore(backend: keychain),
            storeDirectory: nil,
            transport: FakeHTTP(),
            connector: FakeConnector()
        )
        await controller.restore()
        XCTAssertNil(controller.session)
        XCTAssertNotNil(keychain.stored(rnItem), "a failed restore must not sign the RN build out")

        await controller.signOut()
        XCTAssertEqual(keychain.stored(rnItem)?.data, Data(#"{"token":"t","secret":"c2hvcnQ"}"#.utf8))
    }
}
