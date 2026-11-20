import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// Where a team server's refresh token is kept: this device and this app
/// only, readable after the first unlock, never synced, migrated or shared.
final class ServerTokenKeychainTests: XCTestCase {
    private let method = OAuthMethod(id: "jwt", name: "Acme SSO", authorizationUrl: "https://sso.acme.example/authorize",
                                     tokenUrl: "https://sso.acme.example/token", clientId: "happy")

    private func server(_ refreshToken: String) throws -> AgentConnectionCredentials {
        .server(try AgentOrigin("https://happy.acme.example"),
                signIn: ServerSignInRecord(method: method, grant: OAuthGrant(refreshToken: refreshToken, clientId: "happy"), userId: "u1"))
    }

    private func item(_ id: String) -> KeychainItemQuery {
        KeychainItemQuery(service: KeychainAgentConnectionCredentialStore.service, account: Data(id.utf8), generic: Data(id.utf8))
    }

    func testTheRefreshTokenIsDeviceOnlyAndRewrittenSoWhenOlder() throws {
        let keychain = AccountsKeychain()
        let store = KeychainAgentConnectionCredentialStore(backend: keychain)
        try store.save(try server("r1"), id: "acme")
        XCTAssertEqual(keychain.items.stored(item("acme"))?.accessibility, .afterFirstUnlockThisDeviceOnly)
        XCTAssertEqual(try store.all()["acme"]?.signIn?.grant.refreshToken, "r1")

        // An item an earlier build wrote with looser protection: a rotated
        // token rewrites it device-only too.
        keychain.items.seed(item("older"), try JSONEncoder().encode(try server("r0")), accessibility: .whenUnlocked)
        try store.save(try server("r2"), id: "older")
        XCTAssertEqual(keychain.items.stored(item("older"))?.accessibility, .afterFirstUnlockThisDeviceOnly)
        XCTAssertTrue(keychain.items.calls.contains { if case .updateProtection(_, _, .afterFirstUnlockThisDeviceOnly) = $0 { true } else { false } })

        // A paired computer's device token is kept the same way, so Siri
        // and a car reach it while the phone is locked.
        let paired = AgentConnectionCredentials(address: "tcAddress", port: 24781, deviceID: "d", deviceToken: CanonicalBase64URL.encode(Data(repeating: 7, count: 32)))
        try store.save(paired, id: "mac")
        XCTAssertEqual(keychain.items.stored(item("mac"))?.accessibility, .afterFirstUnlockThisDeviceOnly)
    }

    /// A pairing an earlier build wrote readable only while unlocked is
    /// written again at the next launch, once, value unchanged.
    func testAnOlderPairingIsRewrittenReadableAfterFirstUnlockAtLaunch() async throws {
        let keychain = AccountsKeychain()
        let store = KeychainAgentConnectionCredentialStore(backend: keychain)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let paired = AgentConnectionCredentials(address: "tcAddress", port: 24781, deviceID: "d", deviceToken: CanonicalBase64URL.encode(Data(repeating: 7, count: 32)))
        let bytes = try JSONEncoder().encode(paired)
        // As an earlier build left it: the item, and a registry naming it.
        _ = try keychain.add(item("mac"), data: bytes, accessibility: .whenUnlocked)
        let old = #"{"accounts":[{"id":"mac","name":"Mac","addedAt":0,"revoked":false,"status":"paused"}],"activeID":"mac"}"#
        try Data(old.utf8).write(to: directory.appendingPathComponent(AgentConnectionStorage.fileName))

        let storage = AgentConnectionStorage(credentials: store, directory: directory)
        let loaded = try await storage.load()
        XCTAssertEqual(loaded.credentials["mac"], paired)
        XCTAssertEqual(keychain.items.stored(item("mac"))?.accessibility, .afterFirstUnlockThisDeviceOnly)
        XCTAssertEqual(try keychain.items.stored(item("mac")).map { try JSONDecoder().decode(AgentConnectionCredentials.self, from: $0.data) }, paired)

        // Done once: the next launch writes nothing.
        keychain.items.resetCalls()
        _ = try await AgentConnectionStorage(credentials: store, directory: directory).load()
        XCTAssertFalse(keychain.items.calls.contains { if case .updateProtection = $0 { true } else { false } })
    }

    #if canImport(Security)
    /// The attributes SecItemAdd and SecItemUpdate get: no iCloud Keychain,
    /// no shared access group (the app's default one), no access control.
    func testTheRealKeychainGetsDeviceOnlyUnsyncedAppPrivateItems() {
        let added = SecurityKeychainBackend.adding(item("acme"), data: Data("x".utf8), accessibility: .afterFirstUnlockThisDeviceOnly)
        XCTAssertEqual(added[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        XCTAssertEqual(added[kSecAttrSynchronizable as String] as? Bool, false)
        XCTAssertNil(added[kSecAttrAccessGroup as String])
        XCTAssertNil(added[kSecAttrAccessControl as String])
        XCTAssertEqual(added[kSecClass as String] as? String, kSecClassGenericPassword as String)
        XCTAssertEqual(added[kSecAttrService as String] as? String, "happy-ios:direct-device")

        let updated = SecurityKeychainBackend.updating(Data("y".utf8), accessibility: .afterFirstUnlockThisDeviceOnly)
        XCTAssertEqual(updated[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        XCTAssertNil(updated[kSecAttrAccessGroup as String])
        XCTAssertNil(updated[kSecAttrSynchronizable as String])
        XCTAssertNil(SecurityKeychainBackend.attributes(item("acme"))[kSecAttrAccessGroup as String], "queries name no access group")
    }
    #endif

    /// No app target declares a Keychain access group, so the default
    /// group is the app's own (team ID + bundle ID), shared with nothing.
    func testNoTargetSharesAKeychainAccessGroup() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let files = try ["App", "AppClip"].flatMap { folder in
            try FileManager.default.contentsOfDirectory(at: root.appendingPathComponent(folder), includingPropertiesForKeys: nil)
                .filter { $0.pathExtension == "entitlements" }
        } + [root.appendingPathComponent("project.yml")]
        XCTAssertGreaterThan(files.count, 2)
        for file in files {
            let text = try String(contentsOf: file, encoding: .utf8)
            XCTAssertFalse(text.contains("keychain-access-groups"), file.lastPathComponent)
        }
    }
}
