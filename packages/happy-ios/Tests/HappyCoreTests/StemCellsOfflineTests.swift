@testable import HappyCore
import HappyWire
import XCTest

/// What a computer last showed is kept, merged, read back, and forgotten.
final class StemCellsOfflineTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("stem-offline-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
    }

    func testChangesMergeAndAFreshReaderSeesThem() async {
        let file = StemCellsOfflineFile(directory: directory)
        let mode = AgentWire.Mode(providerId: "claude", modelId: "anthropic/sonnet-5", effort: "low", serviceTier: nil, permissionMode: "auto")
        await file.update { $0.config = #"{"config":{}}"# }
        await file.update { $0.dockMode = mode }
        await file.update {
            $0.sidebar = StemCellsOfflineSnapshot.Sidebar(
                artifactId: "a", version: 3, html: "<nav/>", spaces: [], agentIcons: [:], bots: [], tasks: [],
                surfaces: [AgentWire.Surface(id: "s", type: "todo", name: "Groceries")],
                capabilities: nil, prioritizing: true
            )
        }
        await file.flush()
        let kept = await StemCellsOfflineFile(directory: directory).read()
        XCTAssertEqual(kept?.config, #"{"config":{}}"#)
        XCTAssertEqual(kept?.dockMode, mode)
        XCTAssertEqual(kept?.sidebar?.version, 3)
        XCTAssertEqual(kept?.sidebar?.surfaces?.first?.name, "Groceries")
        XCTAssertEqual(kept?.sidebar?.prioritizing, true)
    }

    func testACopyOfAnotherFormatIsNotRead() async throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = StemCellsOfflineFile(directory: directory)
        try Data(#"{"format":0}"#.utf8).write(to: file.snapshotURL)
        let kept = await file.read()
        XCTAssertNil(kept)
    }

    func testPicturesAreKeptByPathAndHash() {
        let file = StemCellsOfflineFile(directory: directory)
        file.keepPicture(Data([1, 2, 3]), path: "/v0/bots/b1/avatar", thumbhash: "KZcG/N+=")
        XCTAssertEqual(file.picture("/v0/bots/b1/avatar", thumbhash: "KZcG/N+="), Data([1, 2, 3]))
        // A new picture has a new hash: the old bytes are not it, and
        // keeping the new one drops the old.
        XCTAssertNil(file.picture("/v0/bots/b1/avatar", thumbhash: "other"))
        file.keepPicture(Data([4]), path: "/v0/bots/b1/avatar", thumbhash: "other")
        XCTAssertNil(file.picture("/v0/bots/b1/avatar", thumbhash: "KZcG/N+="))
        XCTAssertEqual(file.picture("/v0/bots/b1/avatar", thumbhash: "other"), Data([4]))
        let folder = file.pictureURL("/v0/bots/b1/avatar", thumbhash: "other").deletingLastPathComponent()
        XCTAssertEqual(try? FileManager.default.contentsOfDirectory(atPath: folder.path).count, 1)
        XCTAssertEqual(file.pictureURL("/v0/b", thumbhash: "x/").lastPathComponent.count, 32)
    }

    func testARemovedFolderStaysGoneWhateverWasOnItsWay() async {
        let file = StemCellsOfflineFile(directory: directory)
        await file.update { $0.config = "a" }
        await file.flush()
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.path))
        StemCellsOfflineFile.Gate.close(directory)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        // Late writes from the file that was open on it.
        await file.update { $0.config = "b" }
        await file.flush()
        file.keepPicture(Data([1]), path: "/p", thumbhash: nil)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        // A computer paired again opens the folder afresh.
        let again = StemCellsOfflineFile(directory: directory)
        await again.update { $0.config = "c" }
        await again.flush()
        let kept = await StemCellsOfflineFile(directory: directory).read()
        XCTAssertEqual(kept?.config, "c")
    }
}
