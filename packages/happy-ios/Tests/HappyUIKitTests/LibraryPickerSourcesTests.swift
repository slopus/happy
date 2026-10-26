#if canImport(UIKit)
@testable import HappyUI
import UIKit
import UniformTypeIdentifiers
import XCTest

/// What File and Paste hand back: a picture by its bytes, anything else
/// as a file the caller owns.
@MainActor
final class LibraryPickerSourcesTests: XCTestCase {
    private func copy(_ data: Data, named name: String) throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(name)
        try data.write(to: url)
        return url
    }

    private var png: Data {
        UIGraphicsImageRenderer(size: CGSize(width: 30, height: 20)).image { context in
            UIColor.orange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 30, height: 20))
        }.pngData()!
    }

    func testAPictureFromFilesIsAPicture() throws {
        let url = try copy(png, named: "swatch.png")
        let pick = try XCTUnwrap(LibraryPicker.document(url, videos: false))
        guard case .image(let data, let type) = pick.media else { return XCTFail("not a picture: \(pick.media)") }
        XCTAssertEqual(data, png)
        XCTAssertEqual(type, .png)
        XCTAssertGreaterThan(pick.pixelSize.width, 0)
        // Read, the copy goes.
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func testAnyOtherFileIsTheCallersFile() throws {
        let url = try copy(Data("%PDF-1.4".utf8), named: "notes.pdf")
        let pick = try XCTUnwrap(LibraryPicker.document(url, videos: false))
        guard case .file(let kept, let type) = pick.media else { return XCTFail("not a file: \(pick.media)") }
        XCTAssertEqual(kept.lastPathComponent, "notes.pdf")
        XCTAssertEqual(type, .pdf)
        XCTAssertTrue(FileManager.default.fileExists(atPath: kept.path))
        LibraryPicker.discard([pick])
        XCTAssertFalse(FileManager.default.fileExists(atPath: kept.path))
    }

    func testARecordingIsOnlyARecordingWhereRecordingsAreWanted() throws {
        let movie = try XCTUnwrap(LibraryPicker.document(try copy(Data(count: 16), named: "clip.mov"), videos: true))
        guard case .video = movie.media else { return XCTFail("not a recording: \(movie.media)") }
        let file = try XCTUnwrap(LibraryPicker.document(try copy(Data(count: 16), named: "clip.mov"), videos: false))
        guard case .file(_, let type) = file.media else { return XCTFail("not a file: \(file.media)") }
        XCTAssertTrue(type.conforms(to: .movie))
        LibraryPicker.discard([movie, file])
    }
}
#endif
