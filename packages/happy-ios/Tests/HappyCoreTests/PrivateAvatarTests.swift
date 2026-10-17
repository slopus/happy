import Foundation
import HappyCrypto
import HappyStore
import HappyWire
import XCTest
@testable import HappyCore

private final class AvatarBytes: Sendable {
    let data: Data
    init(_ data: Data) { self.data = data }
}

final class PrivateAvatarTests: XCTestCase {
    private func session(avatar: AvatarDescriptor? = nil, rig: Bool = true) -> SessionRecord {
        SessionRecord(id: "session", seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
            projectId: "project", metadataVersion: 1, metadataCipher: "cipher",
            metadata: .object(["client": .object(["id": .string(rig ? "rig" : "claude")]), "bot": .object(["id": .string("bot")])]),
            agentStateVersion: 0, agentStateCipher: nil, agentState: nil, dataKeyCipher: "wrapped", decryptable: true,
            avatar: avatar, avatarVersion: avatar?.version)
    }

    private func project(_ avatar: AvatarDescriptor?) -> ProjectRecord {
        ProjectRecord(id: "project", externalId: "external", createdAt: 1, updatedAt: 1,
            metadataVersion: 1, metadataCipher: "cipher", metadata: .object(["name": .string("Project")]),
            dataKeyCipher: "project-key", avatar: avatar)
    }

    func testSessionAndBotArtWinsAndOnlyRigInheritsProjectArt() throws {
        let art = AvatarDescriptor(ref: "session-ref", preview: "preview", version: 1)
        let projectArt = AvatarDescriptor(ref: "project-ref", preview: "preview", version: 1)
        XCTAssertEqual(AvatarImageSource.resolve(session(avatar: art), project: project(projectArt))?.scope, .session)
        XCTAssertEqual(AvatarImageSource.resolve(session(), project: project(projectArt))?.descriptor, projectArt)
        XCTAssertNil(AvatarImageSource.resolve(session(rig: false), project: project(projectArt)))
        let snapshot = HomeSnapshot(machines: .init(synced: true, machines: []), sessions: [session(avatar: art)], projects: [project(projectArt)])
        let state = ChatSessionState(snapshot, sessionId: "session")
        XCTAssertEqual(state.avatarImage?.dataKeyCipher, "wrapped", "derive artwork before stripping render-only records")
        XCTAssertNil(state.record?.dataKeyCipher)
        var changed = snapshot
        changed.sessions[0].avatarVersion = 100 // unrendered bookkeeping
        XCTAssertEqual(ChatSessionState(changed, sessionId: "session"), state)
        changed.sessions[0].avatar = nil
        XCTAssertEqual(ChatSessionState(changed, sessionId: "session").avatarImage?.scope, .project)
    }

    func testProjectCardUsesProjectArtworkAndAvatarDeltaReconfiguresOnlyItsRow() throws {
        let sessionArt = AvatarDescriptor(ref: "session-ref", preview: "preview", version: 1)
        let projectArt = AvatarDescriptor(ref: "project-ref", preview: "preview", version: 1)
        var chat = session(avatar: sessionArt)
        chat.metadata = .object(["client": .object(["id": .string("rig")]),
            "project": .object(["id": .string("project"), "name": .string("Project")])])
        let snapshot = HomeSnapshot(machines: .init(synced: true, machines: []), sessions: [chat], projects: [project(projectArt)])
        let cards = ProjectHomeData(snapshot).rows(expanded: []).compactMap { item -> ProjectHomeEntry? in
            if case .project(let entry) = item { return entry }
            return nil
        }
        XCTAssertEqual(cards.first?.avatar?.image?.descriptor, projectArt)
        XCTAssertNil(cards.first?.avatar?.harness)
        XCTAssertEqual(SessionList(snapshot).items.compactMap { item -> SessionRow? in
            if case .session(let row) = item { return row }; return nil
        }.first?.avatar.image?.descriptor, sessionArt)

        var many = ApplyPerfFixtures.snapshot(50)
        let before = try XCTUnwrap(ApplyPerfFixtures.derive(many, after: nil)).state
        many.sessions[20].avatar = sessionArt
        let imageUpdate = try XCTUnwrap(ApplyPerfFixtures.derive(many, after: before))
        XCTAssertEqual(imageUpdate.output.changeset, RowChangeset(reconfigures: [20]))
        many.sessions[20].avatarVersion = 99
        XCTAssertNil(ApplyPerfFixtures.derive(many, after: imageUpdate.state), "unrendered revision bookkeeping does not reach main")
    }

    func testDescriptorSurvivesWireAndDiskAndDeletionRejectsStaleFetchAndSocket() async throws {
        let store = try LocalStore.inMemory()
        let descriptor = AvatarDescriptor(ref: "ref", preview: "encrypted", version: 4)
        let row = session(avatar: descriptor)
        try store.upsertSessions([row])
        XCTAssertEqual(try store.session(id: row.id)?.avatar, descriptor)
        let patch = try JSONDecoder().decode(UpdateSessionUpdate.self, from: Data(#"{"id":"session","avatar":null,"avatarVersion":5}"#.utf8))
        XCTAssertNotNil(patch.avatar as Any?)
        _ = try store.applySessionUpdate(id: row.id, metadata: nil, agentState: nil, projectId: nil,
            avatar: patch.avatar, avatarVersion: patch.avatarVersion, avatarUpdateSeq: 50)
        _ = try store.applySessionUpdate(id: row.id, metadata: nil, agentState: nil, projectId: nil,
            avatar: .some(descriptor), avatarVersion: 4, avatarUpdateSeq: 51)
        try store.upsertSessions([row])
        let result = try XCTUnwrap(store.session(id: row.id))
        XCTAssertNil(result.avatar)
        XCTAssertEqual(result.avatarVersion, 5)
        XCTAssertEqual(result.avatarUpdateSeq, 50)
        _ = try store.applySessionUpdate(id: row.id, metadata: nil, agentState: nil, projectId: nil)
        XCTAssertEqual(try store.session(id: row.id), result, "omitted avatar is not deletion")
        _ = try store.applySessionUpdate(id: row.id, metadata: nil, agentState: nil, projectId: nil,
            avatar: .some(nil), avatarUpdateSeq: 52)
        try store.upsertSessions([row])
        XCTAssertNil(try store.session(id: row.id)?.avatar)
        XCTAssertEqual(try store.session(id: row.id)?.avatarVersion, 5, "versionless deletion retains the known revision")
    }

    func testUnversionedSocketOrderAndNoop() async throws {
        let store = try LocalStore.inMemory()
        try store.upsertSessions([session()])
        let descriptor = AvatarDescriptor(ref: "ref", preview: "encrypted", version: 1)
        _ = try store.applySessionUpdate(id: "session", metadata: nil, agentState: nil, projectId: nil,
            avatar: .some(descriptor), avatarUpdateSeq: 20)
        _ = try store.applySessionUpdate(id: "session", metadata: nil, agentState: nil, projectId: nil,
            avatar: .some(nil), avatarVersion: 2, avatarUpdateSeq: 21)
        _ = try store.applySessionUpdate(id: "session", metadata: nil, agentState: nil, projectId: nil,
            avatar: .some(descriptor), avatarUpdateSeq: 19)
        XCTAssertNil(try store.session(id: "session")?.avatar)
        XCTAssertEqual(try store.session(id: "session")?.avatarUpdateSeq, 21)
    }

    func testWireMappingAndServersWithoutAvatarRevisionRemainCompatible() async throws {
        let keys = try AccountKeys(secret: Data(repeating: 1, count: 32))
        let decoder = RecordDecoder(keyRing: KeyRing(keys: keys))
        let base = #"{"id":"session","seq":2,"createdAt":1,"updatedAt":1,"active":true,"activeAt":1,"metadata":"cipher","metadataVersion":1,"agentStateVersion":0}"#
        let old = try JSONDecoder().decode(APISession.self, from: Data(base.utf8))
        XCTAssertNil(old.avatar)
        XCTAssertNil(decoder.session(old).avatarVersion)
        var json = try XCTUnwrap(JSONValue.decode(Data(base.utf8)).objectValue)
        json["avatar"] = .object(["ref": .string("ref"), "preview": .string("cipher"), "version": .number(3)])
        let row = try JSONDecoder().decode(APISession.self, from: JSONValue.object(json).encoded())
        XCTAssertEqual(decoder.session(row).avatar?.ref, "ref")
        XCTAssertNil(decoder.session(row).avatarVersion, "an old GET descriptor is not an authoritative deletion revision")
        let store = try LocalStore.inMemory()
        try store.upsertSessions([decoder.session(row)])
        XCTAssertEqual(try store.session(id: "session")?.avatarVersion, 3, "retain the descriptor's highwater for old servers")
        // A live deletion without a revision must survive a listing that
        // started before it, while a later authoritative fetch may clear art.
        _ = try store.applySessionUpdate(id: "session", metadata: nil, agentState: nil, projectId: nil,
            avatar: .some(nil), avatarUpdateSeq: 20)
        try store.upsertSessions([decoder.session(row)])
        XCTAssertNil(try store.session(id: "session")?.avatar)
        XCTAssertEqual(try store.session(id: "session")?.avatarVersion, 3)
        let sequences = try store.avatarUpdateSequences()
        try store.upsertSessions([decoder.session(old, avatarUpdateSeq: sequences["session"])])
        XCTAssertNil(try store.session(id: "session")?.avatar, "an old server's authoritative null clears art after its live checkpoint")
        json["avatar"] = .object(["ref": .string(""), "preview": .string("bad"), "version": .number(-1)])
        let malformed = try JSONDecoder().decode(APISession.self, from: JSONValue.object(json).encoded())
        XCTAssertNil(malformed.avatar)
        XCTAssertEqual(malformed.id, "session")
        let newSession = try JSONDecoder().decode(NewSessionUpdate.self, from: JSONValue.object(json).encoded())
        XCTAssertNil(newSession.asSession?.avatar)
        XCTAssertEqual(newSession.asSession?.id, "session", "malformed art never drops the full new-session event")
        json["avatar"] = .null
        json["avatarVersion"] = .number(4)
        let removed = try JSONDecoder().decode(APISession.self, from: JSONValue.object(json).encoded())
        try store.upsertSessions([decoder.session(removed)])
        XCTAssertNil(try store.session(id: "session")?.avatar)
        XCTAssertEqual(try store.session(id: "session")?.avatarVersion, 4)
        let malformedPatch = try JSONDecoder().decode(UpdateSessionUpdate.self,
            from: Data(#"{"id":"session","avatar":{"ref":"bad"},"avatarVersion":"bad"}"#.utf8))
        XCTAssertNil(malformedPatch.avatar as Any?)
        XCTAssertNil(malformedPatch.avatarVersion)
    }

    func testLiveVersionlessDeletionDuringHTTPListingIsNotResurrected() async throws {
        let fixture = ServerFixture()
        let store = try LocalStore.inMemory()
        var row = fixture.session("session", updatedAt: 100)
        row.avatar = .init(ref: "ref", preview: "cipher", version: 5)
        let decoder = RecordDecoder(keyRing: KeyRing(keys: fixture.keys))
        try store.upsertSessions([decoder.session(row)])
        let http = FakeHTTP()
        var stale = row
        stale.avatar = .init(ref: "newer-descriptor-before-delete", preview: "cipher", version: 6)
        let staleListing = stale
        http.on("GET /v2/sessions") { _ in
            _ = try store.applySessionUpdate(id: "session", metadata: nil, agentState: nil, projectId: nil,
                avatar: .some(nil), avatarUpdateSeq: 60)
            return (200, try JSONEncoder().encode(SessionsPage(sessions: [staleListing], nextCursor: nil, hasNext: false)))
        }
        let engine = SyncEngine(api: testAPI(http), store: store, keys: fixture.keys)
        try await engine.pullSessions()
        XCTAssertNil(try store.session(id: "session")?.avatar)
        XCTAssertEqual(try store.session(id: "session")?.avatarVersion, 5)
        _ = try store.applySessionUpdate(id: "session", metadata: nil, agentState: nil, projectId: nil,
            avatar: .some(staleListing.avatar), avatarUpdateSeq: 59)
        XCTAssertNil(try store.session(id: "session")?.avatar,
            "an old socket descriptor cannot bypass a newer versionless deletion via its descriptor version")
        XCTAssertEqual(try store.session(id: "session")?.avatarUpdateSeq, 60)
        var fresh = row
        fresh.avatar = .init(ref: "new", preview: "cipher", version: 6)
        fresh.avatarVersion = 6
        try store.upsertSessions([decoder.session(fresh)])
        XCTAssertEqual(try store.session(id: "session")?.avatar?.ref, "new")
        let newer = AvatarDescriptor(ref: "newer-socket", preview: "cipher", version: 7)
        _ = try store.applySessionUpdate(id: "session", metadata: nil, agentState: nil, projectId: nil,
            avatar: .some(newer), avatarUpdateSeq: 61)
        XCTAssertEqual(try store.session(id: "session")?.avatar, newer)
        await engine.stop()
    }

    func testProjectArtworkFetchIncludesOlderRigMetadataLinksWithTopLevelPrecedence() async throws {
        let store = try LocalStore.inMemory()
        var old = session()
        old.id = "old"
        old.projectId = nil
        old.metadata = .object(["project": .object(["id": .string("  legacy-project  ")])])
        var current = old
        current.id = "current"
        current.projectId = " top-project "
        current.metadata = .object(["project": .object(["id": .string("ignored-project")])])
        var invalid = old
        invalid.id = "invalid"
        invalid.metadata = .object(["project": .object(["id": .number(123)])])
        try store.upsertSessions([old, current, invalid])
        XCTAssertEqual(try store.referencedProjectIds(), ["legacy-project", "top-project"])
        let http = FakeHTTP()
        http.on("GET /v1/projects") { request in
            XCTAssertEqual(request.query("ids"), "legacy-project,top-project")
            return (200, Data(#"{"projects":[]}"#.utf8))
        }
        let engine = SyncEngine(api: testAPI(http), store: store, keys: try AccountKeys(secret: Data(repeating: 1, count: 32)))
        try await engine.pullProjects()
        XCTAssertEqual(http.requests("GET /v1/projects").count, 1)
        await engine.stop()
    }

    func testAvatarGrantSendsCredentialsOnlyToServerAndChecksActiveRef() async throws {
        let http = FakeHTTP()
        let api = HappyAPI(serverURL: URL(string: "https://server.test")!, clientID: "ios/test", transport: http, token: "private-token")
        let source = AvatarImageSource(scope: .session, id: "session", descriptor: .init(ref: "ref", preview: "cipher", version: 1), dataKeyCipher: nil)
        let route = "POST /v1/sessions/session/avatar/request-download"
        for host in ["server.test", "storage.test"] {
            http.onRaw(route, #"{"ref":"ref","downloadUrl":"https://\#(host)/avatar.enc"}"#)
            http.on("GET /avatar.enc") { request in
                XCTAssertEqual(request.headers["Authorization"], host == "server.test" ? "Bearer private-token" : nil)
                XCTAssertEqual(request.headers["X-Happy-Client"], host == "server.test" ? "ios/test" : nil)
                return (200, Data([1, 2, 3]))
            }
            let bytes = try await api.downloadAvatar(source)
            XCTAssertEqual(bytes, Data([1, 2, 3]))
        }
        XCTAssertEqual(http.requests(route).first?.headers["Authorization"], "Bearer private-token")
        XCTAssertNil(http.requests(route).first?.body)
        for url in ["file:///tmp/private", "https://user:password@storage.test/avatar.enc", "ftp://storage.test/avatar.enc"] {
            http.onRaw(route, #"{"ref":"ref","downloadUrl":"\#(url)"}"#)
            do { _ = try await api.downloadAvatar(source); XCTFail("unsafe grant accepted") } catch {}
        }
        let before = http.requests("GET /avatar.enc").count
        http.onRaw(route, #"{"ref":"replacement","downloadUrl":"https://server.test/avatar.enc"}"#)
        do { _ = try await api.downloadAvatar(source); XCTFail("replaced grant accepted") } catch {}
        XCTAssertEqual(http.requests("GET /avatar.enc").count, before)
    }

    @MainActor
    func testEncryptedDiskCacheOfflineKeyRotationAndAccountIsolation() async throws {
        let keys = try AccountKeys(secret: Data(repeating: 7, count: 32))
        let dataKey = Data(repeating: 8, count: 32)
        let wrapped = try keys.wrapDataKey(dataKey).base64EncodedString()
        let preview = try RecordCipher(key: dataKey).encrypt(.object(["thumbhash": .string("HwgKPJxwd3dweHiHiHdwgAf3iA"), "mimeType": .string("image/png")]))
        let source = AvatarImageSource(scope: .session, id: "session", descriptor: .init(ref: "ref", preview: preview, version: 1), dataKeyCipher: wrapped)
        let plaintext = Data("actual-image-bytes".utf8)
        let encrypted = try BlobCipher.seal(plaintext, key: BlobCipher.sessionKey(dataKey: dataKey))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("private-avatar-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let http = FakeHTTP()
        http.onRaw("POST /v1/sessions/session/avatar/request-download", #"{"ref":"ref","downloadUrl":"https://server.test/avatar.enc"}"#)
        http.on("GET /avatar.enc") { _ in (200, encrypted) }
        let api = HappyAPI(serverURL: URL(string: "https://server.test")!, clientID: "test", transport: http, token: "token")
        let cache = AvatarPictures(owner: keys.anonID, directory: directory.appendingPathComponent("avatars"), api: api, keys: keys)
        let decode: AvatarPictures.Decode = { bytes in
            XCTAssertFalse(Thread.isMainThread, "decrypt/decode never blocks the UI")
            return (AvatarBytes(bytes), bytes.count)
        }
        async let a = cache.picture(source, decode: decode)
        async let b = cache.picture(source, decode: decode)
        let (first, second) = await (a, b)
        XCTAssertEqual((first as? AvatarBytes)?.data, plaintext)
        XCTAssertTrue(first === second)
        XCTAssertEqual(http.requests("GET /avatar.enc").count, 1)
        await cache.close()
        let files = try FileManager.default.contentsOfDirectory(at: directory.appendingPathComponent("avatars"), includingPropertiesForKeys: nil)
        XCTAssertEqual(files.count, 1)
        XCTAssertEqual(try Data(contentsOf: files[0]), encrypted, "never persist decrypted image bytes")
        let offlineHTTP = FakeHTTP()
        let offlineAPI = HappyAPI(serverURL: api.serverURL, clientID: "test", transport: offlineHTTP, token: "token")
        let offline = AvatarPictures(owner: keys.anonID, directory: directory.appendingPathComponent("avatars"), api: offlineAPI, keys: keys)
        let hit = await offline.picture(source, decode: decode)
        XCTAssertEqual((hit as? AvatarBytes)?.data, plaintext)
        XCTAssertTrue(offlineHTTP.requests.isEmpty)
        let foreign = AvatarPictures(owner: "other", directory: nil, api: offlineAPI,
            keys: try AccountKeys(secret: Data(repeating: 9, count: 32)))
        let wrong = await foreign.picture(source, decode: decode)
        XCTAssertNil(wrong)
        XCTAssertTrue(offlineHTTP.requests.isEmpty, "foreign key rejected before any authenticated download")
        let rotated = AvatarImageSource(scope: source.scope, id: source.id, descriptor: source.descriptor,
            dataKeyCipher: try keys.wrapDataKey(Data(repeating: 10, count: 32)).base64EncodedString())
        XCTAssertNotEqual(source.cacheKey, rotated.cacheKey)
        let stale = await offline.picture(rotated, decode: decode)
        XCTAssertNil(stale)
    }

    func testLegacyProjectUsesMasterBlobKeyAndSessionCannotUseIt() throws {
        let keys = try AccountKeys(secret: Data(repeating: 7, count: 32))
        let preview = try AccountCipher(secret: keys.secret).encrypt(.object(["thumbhash": .string("hash"), "mimeType": .string("image/jpeg")]))
        let api = HappyAPI(serverURL: URL(string: "https://server.test")!, clientID: "test", transport: FakeHTTP())
        let loader = AvatarPictureLoader(api: api, keys: keys)
        let descriptor = AvatarDescriptor(ref: "ref", preview: preview, version: 1)
        XCTAssertEqual(loader.key(for: .init(scope: .project, id: "p", descriptor: descriptor, dataKeyCipher: nil)),
            KeyTree.deriveKey(master: keys.secret, usage: "Happy Blobs", path: ["master"]))
        XCTAssertNil(loader.key(for: .init(scope: .session, id: "s", descriptor: descriptor, dataKeyCipher: nil)))
    }

    @MainActor
    func testFailedSessionImageUsesProjectOnlyForHappyAgent() async throws {
        let keys = try AccountKeys(secret: Data(repeating: 1, count: 32))
        let key = Data(repeating: 2, count: 32)
        let wrapped = try keys.wrapDataKey(key).base64EncodedString()
        let preview = try RecordCipher(key: key).encrypt(.object(["thumbhash": .string("hash"), "mimeType": .string("image/png")]))
        var chat = session(avatar: .init(ref: "session-ref", preview: preview, version: 1))
        chat.dataKeyCipher = wrapped
        var linked = project(.init(ref: "project-ref", preview: preview, version: 1))
        linked.dataKeyCipher = wrapped
        let http = FakeHTTP()
        // The session grant fails; project artwork remains available.
        http.onRaw("POST /v1/projects/project/avatar/request-download", #"{"ref":"project-ref","downloadUrl":"https://server.test/project.enc"}"#)
        let plaintext = Data("project-artwork".utf8)
        let encrypted = try BlobCipher.seal(plaintext, key: BlobCipher.sessionKey(dataKey: key))
        http.on("GET /project.enc") { _ in (200, encrypted) }
        let cache = AvatarPictures(owner: keys.anonID, directory: nil,
            api: HappyAPI(serverURL: URL(string: "https://server.test")!, clientID: "test", transport: http, token: "token"), keys: keys)
        let decode: AvatarPictures.Decode = { (AvatarBytes($0), $0.count) }
        let rigSource = try XCTUnwrap(AvatarImageSource.resolve(chat, project: linked))
        let fallback = await cache.picture(rigSource, decode: decode)
        XCTAssertEqual((fallback as? AvatarBytes)?.data, plaintext)
        XCTAssertEqual(http.requests("POST /v1/sessions/session/avatar/request-download").count, 1)
        XCTAssertEqual(http.requests("POST /v1/projects/project/avatar/request-download").count, 1)
        chat.metadata = .object(["client": .object(["id": .string("claude")])])
        let otherSource = try XCTUnwrap(AvatarImageSource.resolve(chat, project: linked))
        let other = await cache.picture(otherSource, decode: decode)
        XCTAssertNil(other)
        XCTAssertEqual(http.requests("POST /v1/projects/project/avatar/request-download").count, 1,
            "a non-Rig session cannot borrow private project artwork even when it is cached")
        await cache.close()
    }
}
