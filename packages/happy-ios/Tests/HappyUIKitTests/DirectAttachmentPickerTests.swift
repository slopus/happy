#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

@MainActor
final class DirectAttachmentPickerTests: XCTestCase {
    func testDocumentAndVideoRemainAvailableAfterPickerCopiesAreDiscarded() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let picker = ComposerImagePicker(staging: ComposerAttachmentStaging(filesDirectory: root), maxFileBytes: DirectAttachmentRules.maxFileBytes)
        for (name, mime, bytes) in [("report.pdf", "application/pdf", Data([0, 1, 255])), ("clip.mov", "video/quicktime", Data([5, 4, 3, 2]))] {
            let source = root.appendingPathComponent(name)
            try bytes.write(to: source)
            await picker.add(file: source, name: name, mimeType: mime)
            try FileManager.default.removeItem(at: source)
            let admitted = try XCTUnwrap(picker.images.last)
            XCTAssertEqual(admitted.attachment.name, name)
            XCTAssertEqual(admitted.attachment.mimeType, mime)
            XCTAssertEqual(try Data(contentsOf: admitted.attachment.fileURL), bytes)
            let thumbnail = AttachmentThumbnailView(attachment: .init(id: admitted.id,
                fileURL: admitted.attachment.fileURL, name: name, mimeType: mime))
            thumbnail.frame = CGRect(x: 0, y: 0, width: AgentInputCardLayout.Metrics.attachmentSize,
                height: AgentInputCardLayout.Metrics.attachmentSize)
            thumbnail.layoutIfNeeded()
            let image = try XCTUnwrap(thumbnail.subviews.compactMap { $0 as? UIImageView }.first)
            XCTAssertNotNil(image.image, "A non-image file needs a visible icon, not a blank photo thumbnail")
            XCTAssertEqual(image.frame, thumbnail.bounds)
            XCTAssertEqual(thumbnail.accessibilityLabel, name)
        }
        XCTAssertEqual(picker.images.count, 2)
        picker.removeSent([picker.images[0].id])
        XCTAssertEqual(picker.images.first?.attachment.name, "clip.mov")
    }

    func testDirectPickerAdmitsFiftyMiBAndRejectsTheNextByte() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let picker = ComposerImagePicker(staging: ComposerAttachmentStaging(filesDirectory: root), maxFileBytes: DirectAttachmentRules.maxFileBytes)
        for size in [DirectAttachmentRules.maxFileBytes, DirectAttachmentRules.maxFileBytes + 1] {
            let source = root.appendingPathComponent("file-\(size).bin")
            FileManager.default.createFile(atPath: source.path, contents: nil)
            let handle = try FileHandle(forWritingTo: source)
            try handle.truncate(atOffset: UInt64(size))
            try handle.close()
            await picker.add(file: source, name: source.lastPathComponent, mimeType: "application/octet-stream")
        }
        XCTAssertEqual(picker.images.count, 1)
        XCTAssertEqual(picker.images.first?.attachment.size, DirectAttachmentRules.maxFileBytes)
    }
}
#endif