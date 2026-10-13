import Foundation
import XCTest
@testable import HappyCore
import HappyCrypto
import HappyStore

/// The composer's `@` file lists belong to their account: a session id in
/// one account says nothing about another's.
@MainActor
final class ComposerFileIndexAccountTests: XCTestCase {
    private static func files(_ stdout: String) -> SessionRipgrepResponse {
        SessionRipgrepResponse(success: true, exitCode: 0, stdout: stdout, stderr: nil, error: nil)
    }

    /// Counts fetches; one can be held until the test lets it go.
    private actor Fetcher {
        private(set) var count = 0
        private var gate: CheckedContinuation<Void, Never>?
        private var holding = false
        private var waiting: CheckedContinuation<Void, Never>?

        func hold() { holding = true }

        func fetch(_ response: SessionRipgrepResponse) async -> SessionRipgrepResponse {
            count += 1
            if holding {
                holding = false
                waiting?.resume()
                waiting = nil
                await withCheckedContinuation { gate = $0 }
            }
            return response
        }

        /// Returns once a held fetch is waiting.
        func waitForHeldFetch() async {
            guard gate == nil else { return }
            await withCheckedContinuation { waiting = $0 }
        }

        func release() {
            gate?.resume()
            gate = nil
        }
    }

    func testTheSameSessionIdInTwoIndexesNeverCrosses() async {
        let first = ComposerFileIndex()
        let second = ComposerFileIndex()
        let firstFetches = Fetcher()
        let secondFetches = Fetcher()
        let a = await first.search("", sessionId: "s1") { _ in await firstFetches.fetch(Self.files("a/one.ts\n")) }
        let b = await second.search("", sessionId: "s1") { _ in await secondFetches.fetch(Self.files("b/two.ts\n")) }
        XCTAssertEqual(a.map(\.fullPath), ["a/one.ts", "a/"])
        XCTAssertEqual(b.map(\.fullPath), ["b/two.ts", "b/"], "fetched for itself, not served the other's")
        // Each keeps its own, fresh, without fetching again.
        let againA = await first.search("", sessionId: "s1") { _ in await firstFetches.fetch(Self.files("x.ts\n")) }
        let againB = await second.search("o", sessionId: "s1") { _ in await secondFetches.fetch(Self.files("x.ts\n")) }
        XCTAssertEqual(againA.map(\.fullPath), ["a/one.ts", "a/"])
        XCTAssertEqual(againB.map(\.fullPath), ["b/two.ts"])
        let counts = (await firstFetches.count, await secondFetches.count)
        XCTAssertEqual(counts.0, 1)
        XCTAssertEqual(counts.1, 1)
        // Clearing one leaves the other.
        await first.clear()
        let kept = await second.search("", sessionId: "s1") { _ in await secondFetches.fetch(Self.files("x.ts\n")) }
        XCTAssertEqual(kept.map(\.fullPath), ["b/two.ts", "b/"])
    }

    func testEachAccountHasItsOwnIndexAndASearchLeftRunningStaysWithItsAccount() async throws {
        let keychain = AccountsKeychain()
        keychain.items.seed(SecureStoreCredentialStore.item.writeTarget, Data(TokenStorageFixtures.typicalJSON.utf8))
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: SecureStoreCredentialStore(backend: keychain), storeDirectory: nil,
            accountCredentialStore: KeychainAccountCredentialStore(backend: keychain),
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            localSettingsFactory: nil,
            transport: FakeHTTP(), connector: FakeConnector()
        )
        await controller.restore()
        controller.beginAddingAccount()
        try await controller.signIn(Credentials(token: "second", secret: Data(repeating: 7, count: 32)))
        let previous = try XCTUnwrap(controller.session)
        let previousIndex = previous.composerFileIndex

        // A search the previous account's composer started, still fetching
        // when the account switches.
        let previousFetches = Fetcher()
        await previousFetches.hold()
        let running = Task {
            await previousIndex.search("", sessionId: "s1") { _ in await previousFetches.fetch(Self.files("previous.ts\n")) }
        }
        await previousFetches.waitForHeldFetch()

        try await controller.switchAccount(to: accountID(TokenStorageFixtures.typical))
        let current = try XCTUnwrap(controller.session)
        XCTAssertFalse(current === previous)
        XCTAssertFalse(current.composerFileIndex === previousIndex)

        let currentFetches = Fetcher()
        let mine = await current.composerFileIndex.search("", sessionId: "s1") { _ in
            await currentFetches.fetch(Self.files("current.ts\n"))
        }
        XCTAssertEqual(mine.map(\.fullPath), ["current.ts"], "not waiting on, nor served, the other account's fetch")

        await previousFetches.release()
        let finished = await running.value
        XCTAssertEqual(finished.map(\.fullPath), ["previous.ts"], "the old search ends in its own account")
        let after = await current.composerFileIndex.search("", sessionId: "s1") { _ in
            await currentFetches.fetch(Self.files("x.ts\n"))
        }
        XCTAssertEqual(after.map(\.fullPath), ["current.ts"])
        let count = await currentFetches.count
        XCTAssertEqual(count, 1)
        await controller.session?.stop()
    }
}
