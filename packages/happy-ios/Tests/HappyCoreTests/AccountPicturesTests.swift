import Foundation
import XCTest
@testable import HappyCore
import HappyCrypto
import HappyStore

private final class Picture: Sendable {
    let name: String
    let decodedOnMain: Bool
    init(_ name: String, decodedOnMain: Bool) {
        self.name = name
        self.decodedOnMain = decodedOnMain
    }
}

/// Counts fetches, from any thread, and can hold them until opened.
private final class Fetches: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    private var held = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var entered: [CheckedContinuation<Void, Never>] = []

    var made: Int { lock.withLock { count } }

    func hold() { lock.withLock { held = true } }

    func open() {
        let waiting = lock.withLock {
            held = false
            defer { self.waiting = [] }
            return self.waiting
        }
        for continuation in waiting { continuation.resume() }
    }

    /// Returns once a fetch has started.
    func untilEntered() async {
        await withCheckedContinuation { continuation in
            let now: Bool = lock.withLock {
                if count > 0 { return true }
                entered.append(continuation)
                return false
            }
            if now { continuation.resume() }
        }
    }

    /// Fetches answer `body` (nil: fail), once opened.
    func fetch(_ body: String?) -> AccountPictures.Fetch {
        { [self] _, limit in
            let (wait, entered): (Bool, [CheckedContinuation<Void, Never>]) = lock.withLock {
                count += 1
                defer { self.entered = [] }
                return (held, self.entered)
            }
            for continuation in entered { continuation.resume() }
            if wait {
                await withCheckedContinuation { continuation in
                    let now: Bool = lock.withLock {
                        guard held else { return true }
                        waiting.append(continuation)
                        return false
                    }
                    if now { continuation.resume() }
                }
            }
            guard let body else { return nil }
            XCTAssertEqual(limit, AccountPictures.maxBytes)
            return Data(body.utf8)
        }
    }
}

private let decode: AccountPictures.Decode<Data> = { data in
    (Picture(String(decoding: data, as: UTF8.self), decodedOnMain: Thread.isMainThread), data.count)
}

private let makePlaceholder: AccountPictures.Decode<String> = { hash in
    (Picture("placeholder " + hash, decodedOnMain: Thread.isMainThread), 1)
}

/// One account's profile pictures and thumbhash placeholders.
@MainActor
final class AccountPicturesTests: XCTestCase {
    private let url = URL(string: "https://example.com/avatar.png")!

    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func name(_ picture: AccountPictures.Picture?) -> String? {
        (picture as? Picture)?.name
    }

    func testTheSameURLInAnotherAccountIsAnotherPicture() async throws {
        let root = try directory()
        let fetches = Fetches()
        let first = AccountPictures(owner: "a", directory: root.appendingPathComponent("a"), fetch: fetches.fetch("account A"))
        let second = AccountPictures(owner: "b", directory: root.appendingPathComponent("b"), fetch: fetches.fetch("account B"))
        let a = await first.picture(url, decode: decode)
        XCTAssertEqual(name(a), "account A")
        XCTAssertNil(second.cached(url), "nothing of the first account's")
        let b = await second.picture(url, decode: decode)
        XCTAssertEqual(name(b), "account B")
        XCTAssertEqual(fetches.made, 2, "the second account fetches its own")
        XCTAssertEqual(name(first.cached(url)), "account A")
        XCTAssertEqual(name(second.cached(url)), "account B")
    }

    func testTheSameThumbhashInAnotherAccountIsAnotherPlaceholder() async {
        let first = AccountPictures(owner: "a", directory: nil, fetch: Fetches().fetch(nil))
        let second = AccountPictures(owner: "b", directory: nil, fetch: Fetches().fetch(nil))
        let a = await first.placeholder("1QcSHQRnh493V4dIh4eXh1h4kJUI", make: makePlaceholder)
        XCTAssertNil(second.cachedPlaceholder("1QcSHQRnh493V4dIh4eXh1h4kJUI"))
        let b = await second.placeholder("1QcSHQRnh493V4dIh4eXh1h4kJUI", make: makePlaceholder)
        XCTAssertNotNil(a)
        XCTAssertNotNil(b)
        XCTAssertFalse(a === b, "each account makes its own")
        XCTAssertTrue(first.cachedPlaceholder("1QcSHQRnh493V4dIh4eXh1h4kJUI") === a)
    }

    func testDecodingIsOffTheMainThread() async throws {
        let pictures = AccountPictures(owner: "a", directory: try directory(), fetch: Fetches().fetch("picture"))
        let decoded = await pictures.picture(url, decode: decode)
        let picture = try XCTUnwrap(decoded as? Picture)
        XCTAssertFalse(picture.decodedOnMain)
        let made = await pictures.placeholder("hash", make: makePlaceholder)
        let placeholder = try XCTUnwrap(made as? Picture)
        XCTAssertFalse(placeholder.decodedOnMain)
    }

    func testAPictureSeenOnceShowsOffline() async throws {
        let directory = try directory().appendingPathComponent("pictures")
        let online = AccountPictures(owner: "a", directory: directory, fetch: Fetches().fetch("picture"))
        let fetched = await online.picture(url, decode: decode)
        XCTAssertEqual(name(fetched), "picture")
        let file = directory.appendingPathComponent(PictureFiles.name(url.absoluteString))
        XCTAssertEqual(try Data(contentsOf: file), Data("picture".utf8))

        // The next launch, offline: read back, decoded off main, no fetch.
        let offline = Fetches()
        let relaunched = AccountPictures(owner: "a", directory: directory, fetch: offline.fetch(nil))
        let read = await relaunched.picture(url, decode: decode)
        let picture = try XCTUnwrap(read as? Picture)
        XCTAssertEqual(picture.name, "picture")
        XCTAssertFalse(picture.decodedOnMain)
        XCTAssertEqual(offline.made, 0)
    }

    func testAFileThatDoesNotDecodeIsFetchedAgain() async throws {
        let directory = try directory().appendingPathComponent("pictures")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        try Data("broken".utf8).write(to: directory.appendingPathComponent(PictureFiles.name(url.absoluteString)))
        let fetches = Fetches()
        let pictures = AccountPictures(owner: "a", directory: directory, fetch: fetches.fetch("fresh"))
        let picture = await pictures.picture(url) { data in
            String(decoding: data, as: UTF8.self) == "broken" ? nil : decode(data)
        }
        XCTAssertEqual(name(picture), "fresh")
        XCTAssertEqual(fetches.made, 1)
    }

    func testAFileIsNamedByTheURLsHashAlone() {
        let name = PictureFiles.name(url.absoluteString)
        XCTAssertEqual(name.count, 64)
        XCTAssertEqual(name, Hashing.sha256(Data(url.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined())
        XCTAssertFalse(name.contains("example"))
    }

    func testOneFetchPerPictureAtATime() async {
        let fetches = Fetches()
        fetches.hold()
        let pictures = AccountPictures(owner: "a", directory: nil, fetch: fetches.fetch("picture"))
        let url = self.url
        async let first = pictures.picture(url, decode: decode)
        async let second = pictures.picture(url, decode: decode)
        await fetches.untilEntered()
        fetches.open()
        let results = await [first, second]
        XCTAssertEqual(results.map(name), ["picture", "picture"])
        XCTAssertEqual(fetches.made, 1)
    }

    func testAFailedFetchIsNotKept() async {
        let fetches = Fetches()
        let pictures = AccountPictures(owner: "a", directory: nil, fetch: fetches.fetch(nil))
        let first = await pictures.picture(url, decode: decode)
        let second = await pictures.picture(url, decode: decode)
        XCTAssertNil(first)
        XCTAssertNil(second)
        XCTAssertEqual(fetches.made, 2, "the next screen tries again")
        XCTAssertEqual(pictures.keptCount, 0)
    }

    func testOnlyHTTPPicturesAreFetched() async throws {
        let fetches = Fetches()
        let pictures = AccountPictures(owner: "a", directory: try directory(), fetch: fetches.fetch("picture"))
        let secret = try directory().appendingPathComponent("store.sqlite")
        try Data("private".utf8).write(to: secret)
        for url in [secret, URL(string: "data:image/png;base64,AAAA")!, URL(string: "ftp://example.com/a.png")!] {
            let picture = await pictures.picture(url, decode: decode)
            XCTAssertNil(picture, "\(url)")
        }
        XCTAssertEqual(fetches.made, 0)
        let web = await pictures.picture(URL(string: "HTTP://example.com/a.png")!, decode: decode)
        XCTAssertNotNil(web)
    }

    func testKeptPicturesAreBoundedByCountAndBytes() async {
        let pictures = AccountPictures(owner: "a", directory: nil, fetch: Fetches().fetch("12345"), maxCount: 3, maxCost: 12)
        for index in 0..<5 {
            _ = await pictures.picture(URL(string: "https://example.com/\(index).png")!, decode: decode)
        }
        // Five bytes each: two fit in twelve.
        XCTAssertEqual(pictures.keptCount, 2)
        XCTAssertEqual(pictures.keptCost, 10)
        XCTAssertNil(pictures.cached(URL(string: "https://example.com/0.png")!))
        XCTAssertNotNil(pictures.cached(URL(string: "https://example.com/4.png")!))
    }

    func testFilesAreBounded() async throws {
        let directory = try directory().appendingPathComponent("pictures")
        let pictures = AccountPictures(owner: "a", directory: directory, fetch: Fetches().fetch("picture"), maxFiles: 3)
        for index in 0..<6 {
            _ = await pictures.picture(URL(string: "https://example.com/\(index).png")!, decode: decode)
        }
        let files = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertEqual(files.count, 3)
    }

    func testRemoveAllLetsALoadOnItsWayShowButNotStay() async {
        let fetches = Fetches()
        fetches.hold()
        let pictures = AccountPictures(owner: "a", directory: nil, fetch: fetches.fetch("picture"))
        let url = self.url
        let loading = Task { await pictures.picture(url, decode: decode) }
        await fetches.untilEntered()
        pictures.removeAll()
        fetches.open()
        let shown = await loading.value
        XCTAssertEqual(name(shown), "picture")
        XCTAssertNil(pictures.cached(url), "from before the memory warning")
    }

    // MARK: Closing

    func testClosingWhileAFetchIsOnItsWayNeverRecreatesTheAccountDirectory() async throws {
        let account = try directory().appendingPathComponent("accounts/a", isDirectory: true)
        try FileManager.default.createDirectory(at: account, withIntermediateDirectories: true)
        let fetches = Fetches()
        fetches.hold()
        let pictures = AccountPictures(owner: "a", directory: account.appendingPathComponent("pictures"), fetch: fetches.fetch("picture"))
        let url = self.url
        let loading = Task { await pictures.picture(url, decode: decode) }
        await fetches.untilEntered()

        await pictures.close()
        // Sign-out removes the account's directory once close returns.
        try FileManager.default.removeItem(at: account)
        fetches.open()
        let shown = await loading.value

        XCTAssertNil(shown, "nothing of a signed-out account is shown")
        XCTAssertFalse(FileManager.default.fileExists(atPath: account.path))
        XCTAssertTrue(pictures.isClosed)
    }

    func testAClosedCacheKeepsAndShowsNothing() async throws {
        let directory = try directory().appendingPathComponent("pictures")
        let fetches = Fetches()
        let pictures = AccountPictures(owner: "a", directory: directory, fetch: fetches.fetch("picture"))
        _ = await pictures.picture(url, decode: decode)
        _ = await pictures.placeholder("hash", make: makePlaceholder)
        await pictures.close()
        XCTAssertNil(pictures.cached(url))
        XCTAssertNil(pictures.cachedPlaceholder("hash"))
        let picture = await pictures.picture(url, decode: decode)
        let placeholder = await pictures.placeholder("hash", make: makePlaceholder)
        XCTAssertNil(picture)
        XCTAssertNil(placeholder)
        XCTAssertEqual(fetches.made, 1)
    }

    // MARK: Per account, from the controller

    func testEverySignedInAccountHasItsOwnAndSigningOutClosesIt() async throws {
        let root = try directory()
        let keychain = AccountsKeychain()
        keychain.items.seed(SecureStoreCredentialStore.item.writeTarget, Data(TokenStorageFixtures.typicalJSON.utf8))
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: SecureStoreCredentialStore(backend: keychain), storeDirectory: root,
            accountCredentialStore: KeychainAccountCredentialStore(backend: keychain),
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: FakeHTTP(), connector: FakeConnector()
        )
        let fetches = Fetches()
        account.pictureFetch = fetches.fetch("picture")
        await account.restore()
        account.beginAddingAccount()
        let second = Credentials(token: "second", secret: Data(repeating: 7, count: 32))
        try await account.signIn(second)
        let firstID = try accountID(TokenStorageFixtures.typical)
        let secondID = try accountID(second)

        XCTAssertNil(account.pictures(for: "not-signed-in"))
        let first = try XCTUnwrap(account.pictures(for: firstID), "an account that isn't active has its own")
        let active = try XCTUnwrap(account.pictures(for: secondID))
        XCTAssertTrue(account.pictures(for: firstID) === first)
        XCTAssertFalse(first === active)
        XCTAssertEqual(first.owner, firstID)

        _ = await first.picture(url, decode: decode)
        let accountDirectory = AccountSession.accountDirectory(directory: root, id: firstID)
        let file = accountDirectory.appendingPathComponent("pictures").appendingPathComponent(PictureFiles.name(url.absoluteString))
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path), "in the account's own directory")
        XCTAssertNil(active.cached(url))

        // A fetch on its way when the account signs out.
        fetches.hold()
        let other = URL(string: "https://example.com/other.png")!
        let loading = Task { await first.picture(other, decode: decode) }
        await fetches.untilEntered()
        try await account.signOut(accountID: firstID)
        fetches.open()
        let shown = await loading.value

        XCTAssertNil(shown)
        XCTAssertTrue(first.isClosed)
        XCTAssertNil(account.pictures(for: firstID))
        XCTAssertFalse(FileManager.default.fileExists(atPath: accountDirectory.path), "not made again by the late fetch")
        XCTAssertFalse(active.isClosed)
        await account.session?.stop()
    }
}
