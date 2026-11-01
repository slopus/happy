import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

/// Blocks only the background producer after its old value has been read.
/// Tests release it from main while delivering a real settings-feed update.
private final class RegistryIOGate: @unchecked Sendable {
    private let condition = NSCondition()
    private var enteredValue = false
    private var released = false
    private var timedOutValue = false
    var entered: Bool { condition.withLock { enteredValue } }
    var timedOut: Bool { condition.withLock { timedOutValue } }

    func block() {
        dispatchPrecondition(condition: .notOnQueue(.main))
        condition.lock()
        enteredValue = true
        condition.broadcast()
        let deadline = Date().addingTimeInterval(10)
        while !released {
            if !condition.wait(until: deadline) {
                timedOutValue = true
                break
            }
        }
        condition.unlock()
    }

    func release() {
        condition.withLock {
            released = true
            condition.broadcast()
        }
    }
}

private enum RegistryTestError: Error { case writeFailed }

@MainActor
final class AccountRegistryPersistenceTests: XCTestCase {
    private let first = TokenStorageFixtures.typical
    private let second = Credentials(token: "secondary", secret: Data(repeating: 7, count: 32))

    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func controller(directory: URL, keychain: AccountsKeychain = AccountsKeychain()) -> AccountController {
        AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: SecureStoreCredentialStore(backend: keychain), storeDirectory: directory,
            accountCredentialStore: KeychainAccountCredentialStore(backend: keychain),
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: FakeHTTP(), connector: FakeConnector()
        )
    }

    private func twoAccounts(directory: URL) async throws -> AccountController {
        let account = controller(directory: directory)
        try await account.signIn(first)
        try await account.signIn(second)
        try await setProfile("Before", timestamp: 1, account: account)
        await account.flushProfilePersistence()
        return account
    }

    private func setProfile(_ name: String, timestamp: Int64, account: AccountController) async throws {
        let store = try XCTUnwrap(account.session?.store)
        try await Task.detached { _ = try store.applyProfile(AccountProfile(id: "profile", timestamp: timestamp, firstName: name)) }.value
        await eventually { await MainActor.run { account.accounts.first(where: \.isActive)?.name == name } }
    }

    private func saved(_ directory: URL) async throws -> AccountRegistry {
        try await Task.detached { try AccountRegistry.load(directory: directory) }.value
    }

    /// A switch already reading the inventory when the account it heads for
    /// is signed out: the switch is refused, and its older copy of the
    /// inventory never brings the account back, here or on disk.
    func testSwitchUnderWayCannotRestoreAnAccountSignedOutMeanwhile() async throws {
        let directory = try directory()
        let account = try await twoAccounts(directory: directory)
        let gate = RegistryIOGate()
        defer {
            gate.release()
            XCTAssertFalse(gate.timedOut, "background gate timed out")
        }
        let original = account.readRegistryDisplays
        account.readRegistryDisplays = { entries, stores, directory in
            let old = try original(entries, stores, directory)
            if entries.count == 2 { gate.block() }
            return old
        }
        let firstID = try accountID(first), secondID = try accountID(second)
        let switching = Task { try await account.switchAccount(to: firstID) }
        await eventually { gate.entered }
        let removal = try account.beginSignOut(accountID: firstID)
        XCTAssertEqual(account.accounts.map(\.id), [secondID], "the account is gone at once")
        gate.release()
        do {
            try await switching.value
            XCTFail("a switch to a signed-out account must fail")
        } catch {
            XCTAssertEqual(error as? AccountSwitchError, .unknownAccount)
        }
        try await removal.value
        await account.flushProfilePersistence()
        XCTAssertEqual(account.accounts.map(\.id), [secondID])
        XCTAssertEqual(account.session?.keys.anonID, secondID)
        let registry = try await saved(directory)
        XCTAssertEqual(registry.entries.map(\.id), [secondID])
        XCTAssertEqual(registry.activeID, secondID)
        await account.session?.stop()
    }

    func testProfileArrivingDuringCriticalSaveCannotRestoreRemovedAccount() async throws {
        let directory = try directory()
        let account = try await twoAccounts(directory: directory)
        let gate = RegistryIOGate()
        defer {
            gate.release()
            XCTAssertFalse(gate.timedOut, "background gate timed out")
        }
        account.registryWriter = AccountRegistryWriter { value, directory in
            // Pause the removal's write of the one-entry inventory.
            if value.entries.count == 1, !gate.entered { gate.block() }
            try value.save(directory: directory)
        }
        let firstID = try accountID(first), secondID = try accountID(second)
        let removal = Task { try await account.signOut(accountID: firstID) }
        await eventually { gate.entered }
        XCTAssertEqual(account.accounts.map(\.id), [secondID], "membership is published before its write lands")
        try await setProfile("During save", timestamp: 2, account: account)
        gate.release()
        try await removal.value
        await account.flushProfilePersistence()
        let registry = try await saved(directory)
        XCTAssertEqual(account.accounts.map(\.id), [secondID])
        XCTAssertEqual(registry.entries.map(\.id), [secondID])
        XCTAssertEqual(registry.activeID, secondID)
        XCTAssertEqual(registry.entries.first?.display?.name, "During save")
        XCTAssertEqual(account.accounts.first?.name, "During save")
        await account.session?.stop()
    }

    /// The inventory's write failing doesn't undo a sign-out: it is gone
    /// here and its Keychain item deleted, the failure is reported, and the
    /// next launch, the removal still written down, never lists it though
    /// the inventory on disk still does.
    func testCriticalWriteFailureStillSignsOutAndTheNextLaunchKeepsItGone() async throws {
        let directory = try directory(), keychain = AccountsKeychain()
        let account = controller(directory: directory, keychain: keychain)
        try await account.signIn(first)
        try await account.signIn(second)
        await account.flushProfilePersistence()
        let active = try XCTUnwrap(account.session)
        account.registryWriter = AccountRegistryWriter { value, directory in
            dispatchPrecondition(condition: .notOnQueue(.main))
            if value.entries.count == 1 { throw RegistryTestError.writeFailed }
            try value.save(directory: directory)
        }
        do {
            try await account.signOut(accountID: accountID(first))
            XCTFail("critical save must fail")
        } catch RegistryTestError.writeFailed { }
        XCTAssertTrue(account.session === active)
        XCTAssertEqual(account.accounts.map(\.id), [try accountID(second)])
        XCTAssertNil(try KeychainAccountCredentialStore(backend: keychain).shared())
        let onDisk = try await saved(directory)
        XCTAssertEqual(onDisk.entries.count, 2, "the inventory on disk is the old one")
        await account.session?.stop()

        let relaunched = controller(directory: directory, keychain: keychain)
        await relaunched.restore()
        XCTAssertEqual(relaunched.accounts.map(\.id), [try accountID(second)], "the account came back")
        await relaunched.flushProfilePersistence()
        let rewritten = try await saved(directory)
        XCTAssertEqual(rewritten.entries.map(\.id), [try accountID(second)])
        await relaunched.session?.stop()
    }

    func testCriticalFailureWithConcurrentProfileKeepsTheNewInventoryAndDisplay() async throws {
        let directory = try directory()
        let account = try await twoAccounts(directory: directory)
        let gate = RegistryIOGate()
        defer {
            gate.release()
            XCTAssertFalse(gate.timedOut, "background gate timed out")
        }
        account.registryWriter = AccountRegistryWriter { value, directory in
            if value.entries.count == 1, !gate.entered {
                gate.block()
                throw RegistryTestError.writeFailed
            }
            try value.save(directory: directory)
        }
        let oldSession = try XCTUnwrap(account.session)
        let firstID = try accountID(first), secondID = try accountID(second)
        let removal = Task { try await account.signOut(accountID: firstID) }
        await eventually { gate.entered }
        try await setProfile("Newest despite failure", timestamp: 2, account: account)
        gate.release()
        do {
            try await removal.value
            XCTFail("critical save must fail")
        } catch RegistryTestError.writeFailed { }
        await account.flushProfilePersistence()
        XCTAssertTrue(account.session === oldSession)
        XCTAssertEqual(account.accounts.map(\.id), [secondID])
        XCTAssertEqual(account.accounts.first(where: \.isActive)?.name, "Newest despite failure")
        // The profile's own write, after the failed one, saves what is here.
        let registry = try await saved(directory)
        XCTAssertEqual(registry.entries.map(\.id), [secondID])
        XCTAssertEqual(registry.activeID, secondID)
        XCTAssertEqual(registry.entries.first { $0.id == secondID }?.display?.name, "Newest despite failure")
        await account.session?.stop()
    }

    func testProfileDuringSwitchSessionCreationIsPublishedAndPersisted() async throws {
        let directory = try directory()
        let account = try await twoAccounts(directory: directory)
        let gate = RegistryIOGate()
        defer {
            gate.release()
            XCTAssertFalse(gate.timedOut, "background gate timed out")
        }
        let firstID = try accountID(first), secondID = try accountID(second)
        let prepare = account.prepareSessionDirectory
        account.prepareSessionDirectory = { directory, id in
            if id == firstID { gate.block() }
            try prepare(directory, id)
        }
        let switching = Task { try await account.switchAccount(to: firstID) }
        await eventually { gate.entered }
        try await setProfile("Changed while switching", timestamp: 2, account: account)
        gate.release()
        try await switching.value
        await account.flushProfilePersistence()
        XCTAssertEqual(account.accounts.first { $0.id == secondID }?.name, "Changed while switching")
        XCTAssertEqual(account.session?.keys.anonID, firstID)
        let registry = try await saved(directory)
        XCTAssertEqual(registry.activeID, firstID)
        XCTAssertEqual(registry.entries.first { $0.id == secondID }?.display?.name, "Changed while switching")
        await account.session?.stop()
    }

    func testTwoProfilesDuringRoutineWriteKeepTheLastDisplayOnDisk() async throws {
        let directory = try directory()
        let account = try await twoAccounts(directory: directory)
        let gate = RegistryIOGate()
        defer {
            gate.release()
            XCTAssertFalse(gate.timedOut, "background gate timed out")
        }
        account.registryWriter = AccountRegistryWriter { value, directory in
            if !gate.entered { gate.block() }
            try value.save(directory: directory)
        }
        try await setProfile("First queued display", timestamp: 2, account: account)
        await eventually { gate.entered }
        try await setProfile("Last display", timestamp: 3, account: account)
        gate.release()
        await account.flushProfilePersistence()
        let registry = try await saved(directory)
        XCTAssertEqual(registry.activeID, try accountID(second))
        XCTAssertEqual(registry.entries.first { $0.id == (try? accountID(second)) }?.display?.name, "Last display")
        XCTAssertEqual(account.accounts.first(where: \.isActive)?.name, "Last display")
        await account.session?.stop()
    }

    func testRoutineProfileWriteFailureKeepsNewCachedPresentation() async throws {
        let directory = try directory()
        let account = try await twoAccounts(directory: directory)
        account.registryWriter = AccountRegistryWriter { _, _ in
            dispatchPrecondition(condition: .notOnQueue(.main))
            throw RegistryTestError.writeFailed
        }
        try await setProfile("Cached despite failure", timestamp: 2, account: account)
        await account.flushProfilePersistence()
        XCTAssertEqual(account.accounts.first(where: \.isActive)?.name, "Cached despite failure")
        let registry = try await saved(directory)
        XCTAssertEqual(registry.entries.first { $0.id == (try? accountID(second)) }?.display?.name, "Before")
        await account.session?.stop()
    }

    func testWriterRejectsLateOldSnapshotIncludingOldActiveAccount() async throws {
        let directory = try directory()
        let writer = AccountRegistryWriter { value, directory in
            dispatchPrecondition(condition: .notOnQueue(.main))
            try value.save(directory: directory)
        }
        var old = AccountRegistry()
        let firstID = try accountID(first), secondID = try accountID(second)
        old.entries = [AccountRegistryEntry(id: firstID, serverURL: ServerConfig.defaultServerURL, location: .shared, addedOrder: 0)]
        old.activeID = firstID
        var new = AccountRegistry()
        new.entries = [AccountRegistryEntry(id: secondID, serverURL: ServerConfig.defaultServerURL, location: .own, addedOrder: 1,
            display: AccountDisplay(profile: AccountProfile(id: "profile", timestamp: 2, firstName: "Newest")))]
        new.activeID = secondID
        let written = try await writer.save(new, directory: directory, revision: 2)
        let stale = try await writer.save(old, directory: directory, revision: 1)
        XCTAssertTrue(written)
        XCTAssertFalse(stale)
        let registry = try await saved(directory)
        XCTAssertEqual(registry, new)
    }

    func testFailedNewRevisionStillRejectsOldQueuedSnapshot() async throws {
        let directory = try directory()
        let writer = AccountRegistryWriter { _, _ in
            dispatchPrecondition(condition: .notOnQueue(.main))
            throw RegistryTestError.writeFailed
        }
        do {
            try await writer.save(AccountRegistry(), directory: directory, revision: 2)
            XCTFail("write must fail")
        } catch RegistryTestError.writeFailed { }
        let stale = try await writer.save(AccountRegistry(), directory: directory, revision: 1)
        XCTAssertFalse(stale)
    }
}