import Foundation
import XCTest
@testable import HappyCore

/// MiniPBCoder map records and CodedOutputData string values, reproduced
/// independently from the native reader. The CRC algorithm is also pinned
/// against the standard zlib vector below.
enum MMKVFixtures {
    static func varint(_ value: UInt32) -> [UInt8] {
        var remaining = value
        var bytes: [UInt8] = []
        repeat {
            let byte = UInt8(remaining & 127)
            remaining >>= 7
            bytes.append(byte | (remaining == 0 ? 0 : 128))
        } while remaining != 0
        return bytes
    }

    static func field(_ value: [UInt8]) -> [UInt8] {
        varint(UInt32(value.count)) + value
    }

    static func region(_ records: [(String, String?)]) -> [UInt8] {
        // MMKV_IO.cpp writes a random four-byte varint holder. 0x200000
        // is the lower bound from AESCrypt::randomItemSizeHolder(4).
        var bytes = varint(0x20_0000)
        for (key, value) in records {
            bytes += field(Array(key.utf8))
            bytes += field(value.map { field(Array($0.utf8)) } ?? [])
        }
        return bytes
    }

    static func put(_ value: UInt32, at offset: Int, in bytes: inout [UInt8]) {
        for index in 0..<4 { bytes[offset + index] = UInt8(truncatingIfNeeded: value >> (index * 8)) }
    }

    static func file(_ region: [UInt8], headerSize: UInt32? = nil, version: UInt32 = 3) -> (Data, Data) {
        var data = [UInt8](repeating: 0, count: 4)
        put(headerSize ?? UInt32(region.count), at: 0, in: &data)
        data += region
        data += [UInt8](repeating: 0, count: 64) // MMKV's unused mmap capacity.
        var meta = [UInt8](repeating: 0, count: 112)
        put(MMKVStringDecoder.crc32(region), at: 0, in: &meta)
        put(version, at: 4, in: &meta)
        put(UInt32(region.count), at: 28, in: &meta)
        return (Data(data), Data(meta))
    }

    static func write(_ fixture: (Data, Data), directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try fixture.0.write(to: directory.appendingPathComponent("server-config"))
        try fixture.1.write(to: directory.appendingPathComponent("server-config.crc"))
    }
}

final class MMKVServerDecoderTests: XCTestCase {
    private let key = "custom-server-url"

    func testCRC32MatchesZlibKnownVector() {
        XCTAssertEqual(MMKVStringDecoder.crc32(Array("123456789".utf8)), 0xcbf4_3926)
        XCTAssertEqual(MMKVStringDecoder.crc32([]), 0)
    }

    func testLatestRecordWinsAndStringHasAnInnerLengthPrefix() throws {
        let value = "https://selfhost.test/" + String(repeating: "a", count: 150)
        let fixture = MMKVFixtures.file(MMKVFixtures.region([(key, "https://old.test"), ("other", "ignored"), (key, value)]))
        XCTAssertEqual(try MMKVStringDecoder.string(forKey: key, data: fixture.0, metadata: fixture.1), value)
    }

    func testDeletionWinsAndAnEmptyStringIsDistinctFromAMissingKey() throws {
        let deleted = MMKVFixtures.file(MMKVFixtures.region([(key, "https://old.test"), (key, nil)]))
        XCTAssertNil(try MMKVStringDecoder.string(forKey: key, data: deleted.0, metadata: deleted.1))
        let empty = MMKVFixtures.file(MMKVFixtures.region([(key, "")]))
        XCTAssertEqual(try MMKVStringDecoder.string(forKey: key, data: empty.0, metadata: empty.1), "")
    }

    func testMetaActualSizeOverridesAStaleHeaderAndIgnoresUncommittedTail() throws {
        let committed = MMKVFixtures.region([(key, "https://committed.test")])
        let tail = Array(MMKVFixtures.region([(key, "https://uncommitted.test")]).dropFirst(4))
        var fixture = MMKVFixtures.file(committed, headerSize: UInt32(committed.count + tail.count))
        fixture.0.replaceSubrange(4 + committed.count..<4 + committed.count + tail.count, with: tail)
        XCTAssertEqual(try MMKVStringDecoder.string(forKey: key, data: fixture.0, metadata: fixture.1), "https://committed.test")
    }

    func testOlderAndIncompleteMetadataUseHeaderSizeWithVerifiedCRC() throws {
        let fixture = MMKVFixtures.file(MMKVFixtures.region([(key, "https://legacy.test")]), version: 2)
        XCTAssertEqual(try MMKVStringDecoder.string(forKey: key, data: fixture.0, metadata: fixture.1), "https://legacy.test")
        // The actual-size field isn't present, but the header and checksum agree.
        XCTAssertEqual(try MMKVStringDecoder.string(forKey: key, data: fixture.0, metadata: Data(fixture.1.prefix(8))), "https://legacy.test")
    }

    func testTornCRCAndMissingChecksumAreRejected() {
        var fixture = MMKVFixtures.file(MMKVFixtures.region([(key, "https://safe.test")]))
        fixture.0[fixture.0.startIndex + 8] ^= 1
        XCTAssertThrowsError(try MMKVStringDecoder.string(forKey: key, data: fixture.0, metadata: fixture.1)) {
            XCTAssertEqual($0 as? MMKVStringDecoder.DecodeError, .checksumMismatch)
        }
        XCTAssertThrowsError(try MMKVStringDecoder.string(forKey: key, data: fixture.0, metadata: nil)) {
            XCTAssertEqual($0 as? MMKVStringDecoder.DecodeError, .missingChecksum)
        }
    }

    func testOutOfBoundsSizeMalformedRecordAndInvalidUTF8AreRejected() {
        let tooLarge = MMKVFixtures.file([], headerSize: 1_000, version: 2)
        XCTAssertThrowsError(try MMKVStringDecoder.string(forKey: key, data: tooLarge.0, metadata: tooLarge.1))
        let brokenRecord = MMKVFixtures.file([0, 127, 1])
        XCTAssertThrowsError(try MMKVStringDecoder.string(forKey: key, data: brokenRecord.0, metadata: brokenRecord.1))
        let invalidString = MMKVFixtures.file([0] + MMKVFixtures.field(Array(key.utf8)) + MMKVFixtures.field([1, 255]))
        XCTAssertThrowsError(try MMKVStringDecoder.string(forKey: key, data: invalidString.0, metadata: invalidString.1))
        let noHolder = MMKVFixtures.file([128])
        XCTAssertThrowsError(try MMKVStringDecoder.string(forKey: key, data: noHolder.0, metadata: noHolder.1))
    }

    func testFutureMetadataAndExpiryFlagsAreRejected() {
        var fixture = MMKVFixtures.file(MMKVFixtures.region([(key, "https://safe.test")]), version: 6)
        XCTAssertThrowsError(try MMKVStringDecoder.string(forKey: key, data: fixture.0, metadata: fixture.1))
        fixture = MMKVFixtures.file(MMKVFixtures.region([(key, "https://safe.test")]), version: 4)
        fixture.1[104] = 1
        XCTAssertThrowsError(try MMKVStringDecoder.string(forKey: key, data: fixture.0, metadata: fixture.1))
    }
}

@MainActor
final class RNAccountServerImportTests: XCTestCase {
    private let shared = TokenStorageFixtures.typical
    private let item = SecureStoreCredentialStore.item.writeTarget

    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func controller(_ keychain: AccountsKeychain, directory: URL, rn: URL,
                            http: FakeHTTP, connector: FakeConnector) throws -> AccountController {
        let config = ServerConfig(storage: InMemoryKeyValueStore())
        try config.setCustomServerURL("https://wrong-global.test")
        return AccountController(serverConfig: config, clientID: "ios/test",
            credentialStore: SecureStoreCredentialStore(backend: keychain), storeDirectory: directory,
            accountCredentialStore: KeychainAccountCredentialStore(backend: keychain),
            rnServerImport: {
                dispatchPrecondition(condition: .notOnQueue(.main))
                return RNServerConfigImporter.read(directory: rn)
            }, transport: http, connector: connector)
    }

    func testImportedCustomServerIsUsedWithoutWritingRNFilesOrItem() async throws {
        let base = try directory(), rn = base.appendingPathComponent("mmkv")
        let fixture = MMKVFixtures.file(MMKVFixtures.region([("custom-server-url", "https://selfhost.test/")]))
        try MMKVFixtures.write(fixture, directory: rn)
        let keychain = AccountsKeychain(), http = FakeHTTP(), connector = FakeConnector()
        keychain.items.seed(item, Data(TokenStorageFixtures.typicalJSON.utf8))
        let account = try controller(keychain, directory: base, rn: rn, http: http, connector: connector)
        await account.restore()
        XCTAssertEqual(account.session?.api.serverURL.absoluteString, "https://selfhost.test")
        XCTAssertNil(account.pendingServerConfirmation)
        await eventually { !http.requests.isEmpty && connector.latest != nil }
        XCTAssertTrue(http.requests.allSatisfy { $0.url.host == "selfhost.test" })
        XCTAssertTrue(connector.urls.allSatisfy { $0.host == "selfhost.test" })
        XCTAssertEqual(try Data(contentsOf: rn.appendingPathComponent("server-config")), fixture.0)
        XCTAssertEqual(try Data(contentsOf: rn.appendingPathComponent("server-config.crc")), fixture.1)
        XCTAssertEqual(keychain.items.stored(item)?.data, Data(TokenStorageFixtures.typicalJSON.utf8))
        await account.session?.stop()
        // Missing/corrupt registry must also import the RN server, not a new global setting.
        try Data("broken".utf8).write(to: base.appendingPathComponent("accounts.json"))
        let restored = try controller(keychain, directory: base, rn: rn, http: http, connector: connector)
        await restored.restore()
        XCTAssertEqual(restored.session?.api.serverURL.absoluteString, "https://selfhost.test")
        await restored.session?.stop()
    }

    func testAbsentDeletedAndEmptyRNSettingsUseDefaultRatherThanGlobalCandidate() async throws {
        for records: [(String, String?)]? in [nil, [], [("custom-server-url", "")], [("custom-server-url", "https://old.test"), ("custom-server-url", nil)]] {
            let base = try directory(), rn = base.appendingPathComponent("mmkv")
            if let records { try MMKVFixtures.write(MMKVFixtures.file(MMKVFixtures.region(records)), directory: rn) }
            let keychain = AccountsKeychain(), http = FakeHTTP(), connector = FakeConnector()
            keychain.items.seed(item, Data(TokenStorageFixtures.typicalJSON.utf8))
            let account = try controller(keychain, directory: base, rn: rn, http: http, connector: connector)
            await account.restore()
            XCTAssertEqual(account.session?.api.serverURL, ServerConfig.defaultServerURL)
            await account.session?.stop()
        }
    }

    func testUndecodableOrInvalidRNServerMakesZeroRequestsUntilExplicitConfirmation() async throws {
        let fixtures = [
            (Data("torn".utf8), Data()),
            MMKVFixtures.file(MMKVFixtures.region([("custom-server-url", "ftp://invalid.test")])),
        ]
        for fixture in fixtures {
            let base = try directory(), rn = base.appendingPathComponent("mmkv")
            try MMKVFixtures.write(fixture, directory: rn)
            let keychain = AccountsKeychain(), http = FakeHTTP(), connector = FakeConnector()
            keychain.items.seed(item, Data(TokenStorageFixtures.typicalJSON.utf8))
            let account = try controller(keychain, directory: base, rn: rn, http: http, connector: connector)
            await account.restore()
            let pending = try XCTUnwrap(account.pendingServerConfirmation)
            XCTAssertFalse(pending.serverConfirmed)
            XCTAssertNil(account.session)
            try await account.switchAccount(to: pending.id)
            XCTAssertTrue(http.requests.isEmpty)
            XCTAssertTrue(connector.urls.isEmpty)
            do {
                try await account.confirmServer(URL(string: "ftp://invalid.test")!, for: pending.id)
                XCTFail("invalid server")
            } catch {}
            XCTAssertTrue(http.requests.isEmpty)
            XCTAssertTrue(connector.urls.isEmpty)
            // Restoring an unconfirmed registry entry still cannot open a session.
            let restored = try controller(keychain, directory: base, rn: rn, http: http, connector: connector)
            await restored.restore()
            XCTAssertNotNil(restored.pendingServerConfirmation)
            XCTAssertTrue(http.requests.isEmpty)
            XCTAssertTrue(connector.urls.isEmpty)
            try await restored.confirmServer(URL(string: "https://confirmed.test/")!, for: pending.id)
            XCTAssertNil(restored.pendingServerConfirmation)
            XCTAssertEqual(restored.session?.api.serverURL.absoluteString, "https://confirmed.test")
            XCTAssertTrue(try XCTUnwrap(AccountRegistry.load(directory: base).entries.first).serverConfirmed)
            await eventually { !http.requests.isEmpty && connector.latest != nil }
            XCTAssertTrue(http.requests.allSatisfy { $0.url.host == "confirmed.test" })
            XCTAssertTrue(connector.urls.allSatisfy { $0.host == "confirmed.test" })
            XCTAssertEqual(keychain.items.stored(item)?.data, Data(TokenStorageFixtures.typicalJSON.utf8))
            await restored.session?.stop()
        }
    }

    func testRNDecoderFailureDoesNotAffectAlreadyConfirmedNativeAccount() async throws {
        let base = try directory(), rn = base.appendingPathComponent("mmkv")
        let keychain = AccountsKeychain(), http = FakeHTTP(), connector = FakeConnector()
        let account = try controller(keychain, directory: base, rn: rn, http: http, connector: connector)
        try await account.signIn(shared)
        await account.session?.stop()
        try MMKVFixtures.write((Data("broken".utf8), Data()), directory: rn)
        let restored = try controller(keychain, directory: base, rn: rn, http: http, connector: connector)
        await restored.restore()
        XCTAssertEqual(restored.session?.api.serverURL.absoluteString, "https://wrong-global.test")
        XCTAssertNil(restored.pendingServerConfirmation)
        await restored.session?.stop()
    }
}
