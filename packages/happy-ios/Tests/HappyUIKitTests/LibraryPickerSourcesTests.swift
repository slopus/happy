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
        XCTAssertEqual(pick.name, "swatch.png", "its name goes with it, as Android's does")
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

    /// The system picker's copy is named after the photo (`suggestedName`),
    /// not the temporary file it is read from.
    func testTheSystemPickersCopyIsNamedAfterThePhoto() {
        let file = URL(fileURLWithPath: "/tmp/version=1&uuid=9F2A.heic")
        XCTAssertEqual(LibrarySystemPicker.copyName(suggested: "IMG_0042", file: file), "IMG_0042.heic")
        XCTAssertEqual(LibrarySystemPicker.copyName(suggested: "matrix-red-square.HEIC", file: file), "matrix-red-square.HEIC")
        XCTAssertEqual(LibrarySystemPicker.copyName(suggested: "a/b", file: file), "a_b.heic")
        XCTAssertEqual(LibrarySystemPicker.copyName(suggested: nil, file: file), "version=1&uuid=9F2A.heic")
        XCTAssertEqual(LibrarySystemPicker.copyName(suggested: "  ", file: file), "version=1&uuid=9F2A.heic")
        XCTAssertEqual(LibrarySystemPicker.copyName(suggested: "IMG_0042", file: URL(fileURLWithPath: "/tmp/x")), "IMG_0042")
    }
}
#endif
