import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// A computer's vault routes as API.md has them: a version on every
/// change, `If-Match` checked, names unique per folder ignoring case,
/// uploads resumable from `received`. Every write is recorded, and each
/// change can be sent as the event the computer would emit.
actor FakeVaultServer: VaultRoutes {
    private(set) var entries: [String: VaultEntry] = [:]
    private(set) var uploads: [String: (upload: VaultUpload, bytes: Data)] = [:]
    private(set) var writes: [String] = []
    private(set) var listings = 0
    private(set) var settings: VaultSettings
    private(set) var versions: [String: [VaultVersion]] = [:]
    /// Appends that fail with a lost connection, once each, before any arrives.
    var dropAppends = 0
    private var counter = 0
    private var ids = 0
    let surfaceId: String

    init(surfaceId: String) {
        self.surfaceId = surfaceId
        settings = VaultSettings(surfaceId: surfaceId, retention: .standard, updatedAt: 1, version: "v000000")
    }

    /// Unreachable: every read fails as a lost connection does.
    var away = false

    func dropping(_ count: Int) { dropAppends = count }
    func setAway(_ away: Bool) { self.away = away }

    private func version() -> String { counter += 1; return String(format: "v%06d", counter) }

    @discardableResult
    func seed(_ id: String, _ name: String, kind: VaultEntry.Kind = .file, parent: String? = nil, size: Int = 10) -> VaultEntry {
        let entry = VaultEntry(id: id, surfaceId: surfaceId, parentId: parent, name: name, kind: kind, latestVersion: kind == .folder ? nil : 1,
                               size: kind == .folder ? nil : size, createdAt: 1, updatedAt: 1, version: version())
        entries[id] = entry
        return entry
    }

    /// A change made elsewhere and the `vault.entry.updated` it emits.
    func elsewhere(_ id: String, _ change: (inout VaultEntry) -> Void) -> JSONValue {
        let before = entries[id]!
        var entry = before
        change(&entry)
        entry.version = version()
        entries[id] = entry
        var changes: [String: JSONValue] = [:]
        if before.name != entry.name { changes["name"] = .string(entry.name) }
        if before.parentId != entry.parentId { changes["parentId"] = entry.parentId.map(JSONValue.string) ?? .null }
        if before.deletedAt != entry.deletedAt { changes["deletedAt"] = entry.deletedAt.map { .number($0) } ?? .null }
        if before.latestVersion != entry.latestVersion { changes["latestVersion"] = entry.latestVersion.map { .number(Double($0)) } ?? .null }
        changes["updatedAt"] = .number(entry.updatedAt)
        return .object(["type": .string("vault.entry.updated"), "payload": .object([
            "surfaceId": .string(surfaceId), "entryId": .string(id), "previousVersion": .string(before.version),
            "version": .string(entry.version), "changes": .object(changes),
        ])])
    }

    func created(_ id: String, _ name: String, parent: String? = nil) -> JSONValue {
        let entry = seed(id, name, parent: parent)
        return .object(["type": .string("vault.entry.created"), "payload": .object(["entry": entry.json])])
    }

    private func live(_ entry: VaultEntry) -> Bool {
        var current: VaultEntry? = entry
        while let item = current {
            if item.deletedAt != nil { return false }
            current = item.parentId.flatMap { entries[$0] }
        }
        return true
    }

    private func check(_ id: String, _ ifMatch: String) throws -> VaultEntry {
        guard let entry = entries[id] else { throw AgentClientError.status(404, code: "not_found", message: nil) }
        guard entry.version == ifMatch else { throw AgentClientError.status(409, code: "conflict", message: "Stale version") }
        return entry
    }

    private func taken(_ name: String, in parent: String?, except id: String? = nil) -> Bool {
        entries.values.contains { $0.parentId == parent && $0.id != id && live($0) && $0.name.lowercased() == name.lowercased() }
    }

    func vaultEntries(_ surfaceId: String, parentId: String?, pageCursor: String?) async throws -> VaultPage<VaultEntry> {
        if away { throw URLError(.notConnectedToInternet) }
        listings += 1
        let all = entries.values.filter { $0.parentId == parentId && $0.deletedAt == nil }.sorted { $0.id < $1.id }
        // Two pages, so a listing follows its cursor.
        let start = pageCursor.flatMap(Int.init) ?? 0
        let page = Array(all.dropFirst(start).prefix(2))
        return VaultPage(items: page, next: start + 2 < all.count ? String(start + 2) : nil)
    }

    func vaultEntry(_ surfaceId: String, _ entryId: String) async throws -> VaultLocation {
        guard let entry = entries[entryId] else { throw AgentClientError.status(404, code: "not_found", message: nil) }
        return VaultLocation(entry: entry, path: "/" + entry.name, ancestors: [], inTrash: !live(entry))
    }

    func vaultTrash(_ surfaceId: String, pageCursor: String?) async throws -> VaultPage<VaultTrashItem> {
        let items = entries.values.filter { $0.deletedAt != nil }.sorted { ($0.deletedAt ?? 0) > ($1.deletedAt ?? 0) }.map { VaultTrashItem(entry: $0, path: "/" + $0.name) }
        return VaultPage(items: items, next: nil)
    }

    func vaultSearch(_ surfaceId: String, query: String) async throws -> (results: [VaultSearchResult], truncated: Bool) {
        (entries.values.filter { live($0) && $0.name.lowercased().contains(query.lowercased()) }.map { VaultSearchResult(entry: $0, path: "/" + $0.name, match: .name) }, false)
    }

    func vaultVersions(_ surfaceId: String, _ entryId: String, pageCursor: String?) async throws -> VaultPage<VaultVersion> {
        VaultPage(items: (versions[entryId] ?? []).reversed(), next: nil)
    }

    func vaultVersion(_ surfaceId: String, _ entryId: String, number: Int?) async throws -> VaultVersion {
        guard let version = versions[entryId]?.first(where: { $0.number == number }) ?? (number == nil ? versions[entryId]?.last : nil) else {
            throw AgentClientError.status(404, code: "not_found", message: nil)
        }
        return version
    }

    func vaultActivity(_ surfaceId: String, _ entryId: String, pageCursor: String?) async throws -> VaultPage<VaultActivity> { VaultPage(items: [], next: nil) }

    func createVaultEntry(_ surfaceId: String, id: String, parentId: String?, name: String, kind: VaultEntry.Kind, uploadId: String?, mutationId: String) async throws -> VaultEntry {
        writes.append("create \(name)")
        if let held = entries[id] { return held }
        guard !taken(name, in: parentId) else { throw AgentClientError.status(409, code: "name_taken", message: "Name taken") }
        var size: Int?
        if let uploadId {
            guard let staged = uploads.removeValue(forKey: uploadId) else { throw AgentClientError.status(404, code: "not_found", message: nil) }
            guard staged.upload.complete else { throw AgentClientError.status(409, code: "conflict", message: nil) }
            size = staged.bytes.count
        }
        let entry = VaultEntry(id: id, surfaceId: surfaceId, parentId: parentId, name: name, kind: kind, latestVersion: kind == .folder ? nil : 1, size: size,
                               createdAt: 2, updatedAt: 2, version: version())
        entries[id] = entry
        if kind != .folder { versions[id] = [VaultVersion(entryId: id, surfaceId: surfaceId, number: 1, size: size ?? 0, createdAt: 2)] }
        return entry
    }

    func updateVaultEntry(_ surfaceId: String, _ entryId: String, name: String?, parent: VaultParent?, ifMatch: String, mutationId: String) async throws -> VaultEntry {
        writes.append("update \(entryId)")
        var entry = try check(entryId, ifMatch)
        let target = parent.map(\.id) ?? entry.parentId
        if let folder = parent?.id, entries[folder] == nil { throw AgentClientError.status(404, code: "not_found", message: nil) }
        guard !taken(name ?? entry.name, in: target, except: entryId) else { throw AgentClientError.status(409, code: "name_taken", message: "Name taken") }
        if let name { entry.name = name }
        entry.parentId = target
        entry.version = version()
        entries[entryId] = entry
        return entry
    }

    func deleteVaultEntry(_ surfaceId: String, _ entryId: String, ifMatch: String, mutationId: String) async throws -> VaultEntry {
        writes.append("delete \(entryId)")
        var entry = try check(entryId, ifMatch)
        guard entry.deletedAt == nil else { return entry }
        entry.deletedAt = 9
        entry.version = version()
        entries[entryId] = entry
        return entry
    }

    func restoreVaultEntry(_ surfaceId: String, _ entryId: String, parent: VaultParent?, name: String?, ifMatch: String, mutationId: String) async throws -> VaultEntry {
        writes.append("restore \(entryId)")
        var entry = try check(entryId, ifMatch)
        entry.deletedAt = nil
        if let parent { entry.parentId = parent.id }
        if let name { entry.name = name }
        entry.version = version()
        entries[entryId] = entry
        return entry
    }

    func createVaultVersion(_ surfaceId: String, _ entryId: String, uploadId: String?, fromVersion: Int?, ifMatch: String, mutationId: String) async throws -> (entry: VaultEntry, version: VaultVersion?) {
        writes.append("version \(entryId)")
        var entry = try check(entryId, ifMatch)
        var size = entry.size ?? 0
        if let uploadId {
            guard let staged = uploads.removeValue(forKey: uploadId) else { throw AgentClientError.status(404, code: "not_found", message: nil) }
            size = staged.bytes.count
        }
        let number = (entry.latestVersion ?? 0) + 1
        let made = VaultVersion(entryId: entryId, surfaceId: surfaceId, number: number, size: size, restoredFrom: fromVersion, createdAt: 3)
        versions[entryId, default: []].append(made)
        entry.latestVersion = number
        entry.size = size
        entry.version = version()
        entries[entryId] = entry
        return (entry, made)
    }

    func pinVaultVersion(_ surfaceId: String, _ entryId: String, number: Int, pinned: Bool, mutationId: String) async throws -> VaultVersion {
        guard let index = versions[entryId]?.firstIndex(where: { $0.number == number }) else { throw AgentClientError.status(404, code: "not_found", message: nil) }
        versions[entryId]![index].pinned = pinned
        return versions[entryId]![index]
    }

    func vaultSettings(_ surfaceId: String) async throws -> VaultSettings { settings }

    func updateVaultSettings(_ surfaceId: String, retention: VaultRetention, mutationId: String) async throws -> VaultSettings {
        if retention.keepAllDays > 36_500 { throw AgentClientError.status(400, code: "invalid_request", message: "keepAllDays") }
        settings.retention = retention
        settings.version = version()
        return settings
    }

    func createVaultUpload(size: Int) async throws -> VaultUpload {
        ids += 1
        let upload = VaultUpload(id: "u\(ids)", size: size, received: 0, status: size == 0 ? "complete" : "receiving")
        uploads[upload.id] = (upload, Data())
        return upload
    }

    func vaultUpload(_ uploadId: String) async throws -> VaultUpload {
        guard let staged = uploads[uploadId] else { throw AgentClientError.status(404, code: "not_found", message: nil) }
        return staged.upload
    }

    func appendVaultUpload(_ uploadId: String, bytes: Data, start: Int, total: Int, sent: @escaping @Sendable (Int) -> Void) async throws -> VaultUpload {
        guard var staged = uploads[uploadId] else { throw AgentClientError.status(404, code: "not_found", message: nil) }
        guard start == staged.upload.received else { throw AgentClientError.status(409, code: "conflict", message: nil) }
        if dropAppends > 0 {
            dropAppends -= 1
            // Half arrived before the connection broke.
            staged.bytes.append(bytes.prefix(bytes.count / 2))
            staged.upload.received = staged.bytes.count
            uploads[uploadId] = staged
            throw URLError(.networkConnectionLost)
        }
        staged.bytes.append(bytes)
        staged.upload.received = staged.bytes.count
        staged.upload.status = staged.upload.received == staged.upload.size ? "complete" : "receiving"
        uploads[uploadId] = staged
        sent(bytes.count)
        return staged.upload
    }

    func discardVaultUpload(_ uploadId: String) async throws { uploads[uploadId] = nil }

    func teamUsers(_ ids: [String]) async throws -> [TeamUser] { ids.map { TeamUser(id: $0, name: "Person \($0)") } }
}

actor MemoryVaultKeep: VaultKeep {
    private(set) var values: [String: JSONValue] = [:]
    func read(_ key: String) async -> JSONValue? { values[key] }
    func write(_ key: String, _ value: JSONValue) async { values[key] = value }
}

final class VaultLibraryTests: XCTestCase {
    private let surfaceId = "s0000000000000000000000v"

    private final class Events: @unchecked Sendable {
        let stream: AsyncStream<Store.ConversationEvent>
        let continuation: AsyncStream<Store.ConversationEvent>.Continuation
        init() { (stream, continuation) = AsyncStream.makeStream(of: Store.ConversationEvent.self) }
        func send(_ event: JSONValue) { continuation.yield(.event(event)) }
    }

    private func library(_ server: FakeVaultServer, keep: MemoryVaultKeep = MemoryVaultKeep(), events: Events = Events()) -> VaultLibrary {
        VaultLibrary(routes: server, keep: keep, events: { events.stream }, now: { 5 })
    }

    private final class Watcher: @unchecked Sendable {
        private let lock = NSLock()
        private var latest = VaultFolderState()
        private(set) var count = 0
        var state: VaultFolderState { lock.withLock { latest } }
        func set(_ state: VaultFolderState) { lock.withLock { latest = state; count += 1 } }
        var names: [String] { state.entries.map(\.name).sorted() }
    }

    private func watch(_ library: VaultLibrary, folder: String? = nil) async -> Watcher {
        let watcher = Watcher()
        let stream = await library.states(surfaceId, folder: folder)
        Task { for await state in stream { watcher.set(state) } }
        return watcher
    }

    private func eventually(_ seconds: Double = 3, _ condition: @escaping () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !(await condition()) {
            guard ContinuousClock.now < deadline else { return XCTFail("timed out", file: file, line: line) }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    func testAFolderIsReadAcrossItsPagesThenKeptForTheNextLaunch() async throws {
        let server = FakeVaultServer(surfaceId: surfaceId)
        for (id, name) in [("e1", "a.txt"), ("e2", "b.txt"), ("e3", "c.txt"), ("e4", "Docs")] { await server.seed(id, name, kind: name == "Docs" ? .folder : .file) }
        await server.seed("e5", "inner.txt", parent: "e4")
        let keep = MemoryVaultKeep()
        let first = library(server, keep: keep)
        let watcher = await watch(first)
        try await eventually { watcher.state.status == .ready && !watcher.state.kept && watcher.names == ["Docs", "a.txt", "b.txt", "c.txt"] }
        try await eventually { await keep.values[VaultLibrary.resource(self.surfaceId, folder: nil)] != nil }

        // The next launch shows the kept folder while the computer can't be reached.
        await server.setAway(true)
        let next = await watch(library(server, keep: keep))
        try await eventually { next.state.status == .ready && next.state.kept && next.names == ["Docs", "a.txt", "b.txt", "c.txt"] }
    }

    func testEventsAlongTheVersionChainChangeOnlyWhatTheyName() async throws {
        let server = FakeVaultServer(surfaceId: surfaceId)
        await server.seed("e1", "a.txt")
        await server.seed("f1", "Docs", kind: .folder)
        let events = Events()
        let library = library(server, events: events)
        let root = await watch(library)
        let docs = await watch(library, folder: "f1")
        try await eventually { root.names == ["Docs", "a.txt"] && !docs.state.kept }
        let listings = await server.listings

        events.send(await server.elsewhere("e1") { $0.name = "renamed.txt" })
        try await eventually { root.names == ["Docs", "renamed.txt"] }
        events.send(await server.elsewhere("e1") { $0.parentId = "f1" })
        try await eventually { root.names == ["Docs"] && docs.names == ["renamed.txt"] }
        events.send(await server.created("e2", "new.md", parent: "f1"))
        try await eventually { docs.names == ["new.md", "renamed.txt"] }
        let read = await server.listings
        XCTAssertEqual(read, listings, "events in the chain need no read")

        // A gap in the chain reads the entry, not the folder.
        _ = await server.elsewhere("e2") { $0.name = "skipped.md" }
        events.send(await server.elsewhere("e2") { $0.name = "final.md" })
        try await eventually { docs.names == ["final.md", "renamed.txt"] }

        // Trashing a folder hides it and marks what is inside it.
        events.send(await server.elsewhere("f1") { $0.deletedAt = 9 })
        try await eventually { root.names.isEmpty && docs.state.inTrash }
        events.send(.object(["type": .string("vault.entry.removed"), "payload": .object(["surfaceId": .string(surfaceId), "entryId": .string("f1")])]))
        try await eventually { docs.names.isEmpty }
    }

    func testAnEntryRestoredIntoAnOpenFolderIsReadAndShown() async throws {
        let server = FakeVaultServer(surfaceId: surfaceId)
        await server.seed("e1", "gone.txt")
        _ = await server.elsewhere("e1") { $0.deletedAt = 9 }
        let events = Events()
        let library = library(server, events: events)
        let root = await watch(library)
        try await eventually { root.state.status == .ready && !root.state.kept }
        XCTAssertEqual(root.names, [])
        events.send(await server.elsewhere("e1") { $0.deletedAt = nil })
        try await eventually { root.names == ["gone.txt"] }
    }

    func testChangesReachTheComputerAndARefusalIsUndone() async throws {
        let server = FakeVaultServer(surfaceId: surfaceId)
        await server.seed("e1", "a.txt")
        await server.seed("e2", "b.txt")
        let library = library(server)
        let root = await watch(library)
        try await eventually { root.names == ["a.txt", "b.txt"] && !root.state.kept }

        try await library.rename(surfaceId, "e1", to: "c.txt")
        try await eventually { root.names == ["b.txt", "c.txt"] }
        let renamed = await server.entries["e1"]?.name
        XCTAssertEqual(renamed, "c.txt")

        do {
            try await library.rename(surfaceId, "e1", to: "B.TXT")
            XCTFail("a taken name is refused")
        } catch AgentClientError.status(409, "name_taken", _) {}
        try await eventually { root.names == ["b.txt", "c.txt"] && root.state.waiting.isEmpty }

        try await library.delete(surfaceId, "e2")
        try await eventually { root.names == ["c.txt"] }
        let made = try await library.createFolder(surfaceId, parentId: nil, name: "Reports")
        try await eventually { root.names == ["Reports", "c.txt"] }
        try await library.move(surfaceId, "e1", to: .folder(made.id))
        try await eventually { root.names == ["Reports"] }
        let moved = await server.entries["e1"]?.parentId
        XCTAssertEqual(moved, made.id)
    }

    func testAStaleVersionIsReadAndTheChangeAppliedAgain() async throws {
        let server = FakeVaultServer(surfaceId: surfaceId)
        await server.seed("e1", "a.txt")
        let library = library(server)
        let root = await watch(library)
        try await eventually { root.names == ["a.txt"] && !root.state.kept }
        // Someone else changes it, and no event reaches this phone.
        _ = await server.elsewhere("e1") { $0.updatedAt = 4 }
        try await library.rename(surfaceId, "e1", to: "mine.txt")
        let name = await server.entries["e1"]?.name
        XCTAssertEqual(name, "mine.txt")
    }

    func testAnUploadResumesFromWhatTheComputerHasAndMakesTheFile() async throws {
        let server = FakeVaultServer(surfaceId: surfaceId)
        await server.dropping(1)
        let library = library(server)
        let root = await watch(library)
        try await eventually { root.state.status == .ready && !root.state.kept }
        let bytes = Data((0..<(VaultLibrary.chunk + 1000)).map { UInt8($0 % 251) })
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("vault-upload-\(UUID().uuidString)")
        try bytes.write(to: file)
        await library.upload(surfaceId, parentId: nil, file: file, name: "big.bin")
        XCTAssertEqual(root.state.uploads.first?.name, "big.bin")
        try await eventually(10) { root.names == ["big.bin"] && root.state.uploads.isEmpty }
        let size = await server.entries.values.first { $0.name == "big.bin" }?.size
        XCTAssertEqual(size, bytes.count)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path), "the library removes the file once the entry is made")
    }

    func testAnUploadOverAFileMakesANewVersionOfIt() async throws {
        let server = FakeVaultServer(surfaceId: surfaceId)
        await server.seed("e1", "notes.txt")
        let library = library(server)
        let root = await watch(library)
        try await eventually { root.names == ["notes.txt"] && !root.state.kept }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("vault-upload-\(UUID().uuidString)")
        try Data("new words".utf8).write(to: file)
        await library.upload(surfaceId, parentId: nil, file: file, name: "notes.txt", replacing: "e1")
        try await eventually { root.state.uploads.isEmpty && root.state.entries.first?.latestVersion == 2 }
        XCTAssertEqual(root.names, ["notes.txt"])
        let writes = await server.writes
        XCTAssertEqual(writes, ["version e1"])
    }

    func testTheTrashListsItsItemsAndARestoreBringsOneBack() async throws {
        let server = FakeVaultServer(surfaceId: surfaceId)
        await server.seed("e1", "a.txt")
        let library = library(server)
        let root = await watch(library)
        try await eventually { root.names == ["a.txt"] && !root.state.kept }
        try await library.delete(surfaceId, "e1")
        let trash = await library.trashStates(surfaceId)
        var iterator = trash.makeAsyncIterator()
        var state = await iterator.next()
        while state?.items.map(\.entry.name) != ["a.txt"] { state = await iterator.next() }
        let item = try XCTUnwrap(state?.items.first)
        try await library.restore(surfaceId, item)
        try await eventually { root.names == ["a.txt"] }
    }

    func testSettingsChangeAtOnceAndARefusedPolicyIsUndone() async throws {
        let server = FakeVaultServer(surfaceId: surfaceId)
        let library = library(server)
        let stream = await library.settingsStates(surfaceId)
        var iterator = stream.makeAsyncIterator()
        var state = await iterator.next()
        while state??.retention == nil { state = await iterator.next() }
        XCTAssertEqual(state??.retention.preset, .timeMachine)
        try await library.setRetention(surfaceId, VaultRetention.standard.applying(.lastTen))
        let kept = await server.settings.retention
        XCTAssertEqual(kept, VaultRetention(maxVersions: 10, keepAllDays: 0, thinning: [], trashDays: 30))
        var refused = kept
        refused.keepAllDays = 99_999
        do { try await library.setRetention(surfaceId, refused); XCTFail("refused") } catch {}
        let after = await server.settings.retention
        XCTAssertEqual(after.preset, .lastTen)
    }
}

final class VaultRulesTests: XCTestCase {
    private func entry(_ id: String, _ name: String, kind: VaultEntry.Kind = .file, size: Int = 0, updatedAt: Double = 0) -> VaultEntry {
        VaultEntry(id: id, surfaceId: "s", parentId: nil, name: name, kind: kind, size: size, updatedAt: updatedAt)
    }

    func testFoldersComeFirstInEverySort() {
        let entries = [entry("1", "b10.txt", size: 5, updatedAt: 3), entry("2", "B2.txt", size: 9, updatedAt: 1), entry("3", "Zeta", kind: .folder), entry("4", "alpha", kind: .folder, updatedAt: 9)]
        XCTAssertEqual(VaultSort(key: .name).sorted(entries).map(\.name), ["alpha", "Zeta", "B2.txt", "b10.txt"])
        XCTAssertEqual(VaultSort(key: .name, ascending: false).sorted(entries).map(\.name), ["Zeta", "alpha", "b10.txt", "B2.txt"])
        XCTAssertEqual(VaultSort(key: .updatedAt).sorted(entries).map(\.name), ["alpha", "Zeta", "b10.txt", "B2.txt"])
        XCTAssertEqual(VaultSort(key: .size).sorted(entries).map(\.name), ["alpha", "Zeta", "B2.txt", "b10.txt"])
    }

    func testAStoredPolicyShowsAsThePresetItMatches() {
        XCTAssertEqual(VaultRetention.standard.preset, .timeMachine)
        XCTAssertEqual(VaultRetention(keepAllDays: 0, thinning: [], trashDays: nil).preset, .keepEverything)
        XCTAssertEqual(VaultRetention(maxVersions: 10, keepAllDays: 0, thinning: [], trashDays: 7).preset, .lastTen)
        XCTAssertEqual(VaultRetention(maxVersions: 11, keepAllDays: 0, thinning: []).preset, .custom)
        let chosen = VaultRetention(maxVersions: 3, keepAllDays: 2, thinning: [], trashDays: 90).applying(.keepEverything)
        XCTAssertEqual(chosen, VaultRetention(keepAllDays: 0, thinning: [], trashDays: 90))
    }

    func testAPolicyIsSentWholeWithItsNulls() throws {
        let json = String(decoding: try JSONEncoder.sorted.encode(VaultRetention(keepAllDays: 0, thinning: [], trashDays: nil)), as: UTF8.self)
        XCTAssertEqual(json, #"{"keepAllDays":0,"maxAgeDays":null,"maxVersions":null,"thinning":[],"trashDays":null}"#)
    }

    func testACustomPolicyIsBroughtInsideTheLimits() {
        let edited = VaultRetention(maxVersions: 0, maxAgeDays: 0, keepAllDays: -3, thinning: [.init(afterDays: 30, everyDays: 0), .init(afterDays: 7, everyDays: 1), .init(afterDays: 30, everyDays: 9)], trashDays: 9_999)
        XCTAssertEqual(edited.normalized(), VaultRetention(maxVersions: 1, maxAgeDays: 1, keepAllDays: 0, thinning: [.init(afterDays: 7, everyDays: 1), .init(afterDays: 30, everyDays: 1)], trashDays: 3_650))
    }

    func testAFreeNameNumbersBeforeTheExtension() {
        XCTAssertEqual(VaultReducer.free("Report.pdf", among: ["report.PDF", "Report 2.pdf"]), "Report 3.pdf")
        XCTAssertEqual(VaultReducer.free("Notes", among: ["Other"]), "Notes")
        XCTAssertEqual(VaultReducer.free("Notes", among: ["notes"]), "Notes 2")
    }

    func testAnEntryDecodesFromTheContractsExample() throws {
        let json = #"{"id":"e4k8m2q9w1e5r7y3u6i0o2p4","surfaceId":"s4k8m2q9w1e5r7y3u6i0o2p4","parentId":"f7k2m9q4w1e5t8y3u6i0o2p5","name":"summary.pdf","kind":"file","latestVersion":3,"size":48213,"sha256":"2c26","mediaType":"application/pdf","artifact":null,"createdAt":1755300000000,"createdBy":{"userId":"u1","agentId":null},"updatedAt":1755400000000,"updatedBy":{"userId":null,"agentId":"a9"},"deletedAt":null,"version":"01991f3a-5c1e-7000-8000-2f9a1b3c4d5e"}"#
        let entry = try JSONDecoder().decode(VaultEntry.self, from: Data(json.utf8))
        XCTAssertEqual(entry.kind, .file)
        XCTAssertEqual(entry.latestVersion, 3)
        XCTAssertEqual(entry.updatedBy, VaultActor(userId: nil, agentId: "a9"))
        let activity = try JSONDecoder().decode(VaultActivity.self, from: Data(#"{"id":"x","entryId":"e","kind":"moved","fromParentId":null,"toParentId":"f","fromName":"draft.pdf","toName":"summary.pdf","at":1,"actor":{"userId":"u","agentId":null},"source":"api"}"#.utf8))
        XCTAssertEqual(activity.kind, .moved(fromParentId: nil, toParentId: "f", fromName: "draft.pdf", toName: "summary.pdf"))
        let unknown = try JSONDecoder().decode(VaultActivity.self, from: Data(#"{"id":"x","entryId":"e","kind":"tagged","at":1,"actor":{"userId":null,"agentId":null},"source":"tool"}"#.utf8))
        XCTAssertEqual(unknown.kind, .other("tagged"))
    }
}

private extension JSONEncoder {
    static var sorted: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}
