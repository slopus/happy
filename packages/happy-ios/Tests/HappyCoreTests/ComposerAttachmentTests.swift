import Foundation
@testable import HappyCore
import XCTest

/// useImagePicker.ts's limits and names.
final class ComposerAttachmentRulesTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_760_000_000.5)

    func testLimits() {
        XCTAssertEqual(ComposerAttachmentRules.maxImages, 20)
        XCTAssertEqual(ComposerAttachmentRules.maxFileSize, 10_485_720)
        XCTAssertEqual(ComposerAttachmentRules.jpegQuality, 0.92)
        XCTAssertEqual(ComposerAttachmentRules.remaining(selected: 0), 20)
        XCTAssertEqual(ComposerAttachmentRules.remaining(selected: 19), 1)
        XCTAssertEqual(ComposerAttachmentRules.remaining(selected: 20), 0)
        XCTAssertEqual(ComposerAttachmentRules.remaining(selected: 25), 0)
    }

    func testOnlyTheLongEdgeShrinks() {
        XCTAssertEqual(ComposerAttachmentRules.longEdge(width: 4032, height: 3024), 3072)
        XCTAssertEqual(ComposerAttachmentRules.longEdge(width: 3024, height: 4032), 3072)
        XCTAssertEqual(ComposerAttachmentRules.longEdge(width: 1170, height: 2532), 2532)
        XCTAssertEqual(ComposerAttachmentRules.longEdge(width: 3072, height: 10), 3072)
        XCTAssertEqual(ComposerAttachmentRules.longEdge(width: 0, height: 0), 0)
    }

    func testJpegNames() {
        XCTAssertEqual(ComposerAttachmentRules.jpegName("IMG_1234.HEIC", now: now), "IMG_1234.jpg")
        XCTAssertEqual(ComposerAttachmentRules.jpegName("IMG_1234", now: now), "IMG_1234.jpg")
        XCTAssertEqual(ComposerAttachmentRules.jpegName("my.photo.png", now: now), "my.photo.jpg")
        XCTAssertEqual(ComposerAttachmentRules.jpegName(".hidden", now: now), ".hidden.jpg")
        XCTAssertEqual(ComposerAttachmentRules.jpegName("  shot.png ", now: now), "shot.jpg")
        XCTAssertEqual(ComposerAttachmentRules.jpegName(nil, now: now), "image_1760000000500.jpg")
        XCTAssertEqual(ComposerAttachmentRules.jpegName("   ", now: now), "image_1760000000500.jpg")
        XCTAssertEqual(
            ComposerAttachmentRules.jpegName(ComposerAttachmentRules.pastedName(now: now), now: now),
            "pasted_1760000000500.jpg"
        )
    }

    func testPreviewIds() {
        var generator = SystemRandomNumberGenerator()
        let id = ComposerAttachmentRules.previewId(now: now, using: &generator)
        let parts = id.split(separator: "_")
        XCTAssertEqual(parts.count, 2)
        XCTAssertEqual(parts.first, "1760000000500")
        XCTAssertEqual(parts.last?.count, 11)
        XCTAssertTrue(parts.last!.allSatisfy { $0.isNumber || ("a"..."z").contains($0) })
        XCTAssertNotEqual(ComposerAttachmentRules.previewId(), ComposerAttachmentRules.previewId())
    }
}

final class ComposerAttachmentStagingTests: XCTestCase {
    private var files: URL!

    override func setUpWithError() throws {
        files = FileManager.default.temporaryDirectory.appendingPathComponent("staging-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: files, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: files)
    }

    private func write(_ url: URL) throws {
        try Data([1, 2, 3]).write(to: url)
    }

    func testFilesLiveInTheirOwnFolderAndGoWithIt() throws {
        var staging: ComposerAttachmentStaging? = ComposerAttachmentStaging(filesDirectory: files)
        let file = try staging!.newFile(extension: "jpg")
        XCTAssertEqual(file.pathExtension, "jpg")
        XCTAssertEqual(file.deletingLastPathComponent().deletingLastPathComponent().lastPathComponent, "composer")
        try write(file)
        let folder = staging!.directory
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        staging = nil
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path))
    }

    func testRemoveOnlyTouchesItsOwnFiles() throws {
        let staging = ComposerAttachmentStaging(filesDirectory: files)
        let mine = try staging.newFile(extension: "jpg")
        try write(mine)
        let outbox = files.appendingPathComponent("outbox-copy")
        try write(outbox)
        staging.remove(outbox)
        XCTAssertTrue(FileManager.default.fileExists(atPath: outbox.path))
        staging.remove(mine)
        XCTAssertFalse(FileManager.default.fileExists(atPath: mine.path))
    }

    func testAnEarlierLaunchesFoldersAreSweptButLiveOnesStay() throws {
        let orphan = files.appendingPathComponent("composer/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: orphan, withIntermediateDirectories: true)
        try write(orphan.appendingPathComponent("left.jpg"))
        let outbox = files.appendingPathComponent("outbox-copy")
        try write(outbox)

        let first = ComposerAttachmentStaging(filesDirectory: files)
        let held = try first.newFile(extension: "jpg")
        try write(held)
        XCTAssertFalse(FileManager.default.fileExists(atPath: orphan.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: outbox.path), "outside the composer folder")

        let second = ComposerAttachmentStaging(filesDirectory: files)
        XCTAssertTrue(FileManager.default.fileExists(atPath: held.path), "another composer's selection")
        XCTAssertNotEqual(first.directory, second.directory)
    }
}
