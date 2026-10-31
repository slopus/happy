import Foundation
@testable import HappyLayout
import XCTest

/// Which bundled picture an ID wears, and that every one of them ships.
final class AvatarPlaceholderTests: XCTestCase {
    /// Pinned, so a change to the hash (which would hand everyone a new
    /// picture) fails here rather than going out unnoticed. The values are
    /// the same FNV-1a and MurmurHash3 finaliser computed in node.
    func testThePickIsPinned() {
        XCTAssertEqual(AvatarPlaceholder.hash(""), 2_872_998_923)
        XCTAssertEqual(AvatarPlaceholder.hash("abc"), 482_950_588)
        XCTAssertEqual(AvatarPlaceholder.index(seed: ""), 123)
        XCTAssertEqual(AvatarPlaceholder.index(seed: "abc"), 188)
        XCTAssertEqual(AvatarPlaceholder.index(seed: "account-1"), 180)
        XCTAssertEqual(AvatarPlaceholder.index(seed: "account-2"), 16)
        XCTAssertEqual(AvatarPlaceholder.index(seed: "😀x"), 38, "UTF-8 bytes")
        XCTAssertEqual(AvatarPlaceholder.name(seed: "person:ada@example.com"), "avatar-placeholder-016")
    }

    func testTheSameSeedAlwaysPicksTheSamePicture() {
        for seed in ["", "a", "account-1", UUID().uuidString] {
            XCTAssertEqual(AvatarPlaceholder.index(seed: seed), AvatarPlaceholder.index(seed: String(seed)))
            XCTAssertEqual(AvatarPlaceholder.name(seed: seed), AvatarPlaceholder.name(seed: seed))
        }
    }

    /// 20,000 IDs that differ only at their end land on every picture, none
    /// far from its share of 100.
    func testPicksSpreadOverEveryPicture() {
        var counts = [Int](repeating: 0, count: AvatarPlaceholder.count)
        for index in 0..<20_000 { counts[AvatarPlaceholder.index(seed: "seed-\(index)")] += 1 }
        XCTAssertEqual(counts.filter { $0 == 0 }.count, 0, "pictures no seed picks")
        XCTAssertGreaterThanOrEqual(counts.min() ?? 0, 60)
        XCTAssertLessThanOrEqual(counts.max() ?? 0, 150)
        // Neighbouring IDs don't share a picture more than chance would.
        let neighbours = (0..<1000).filter { AvatarPlaceholder.index(seed: "seed-\($0)") == AvatarPlaceholder.index(seed: "seed-\($0 + 1)") }
        XCTAssertLessThan(neighbours.count, 20)
    }

    func testNames() {
        XCTAssertEqual(AvatarPlaceholder.count, 200)
        XCTAssertEqual(AvatarPlaceholder.names.count, 200)
        XCTAssertEqual(Set(AvatarPlaceholder.names).count, 200)
        XCTAssertEqual(AvatarPlaceholder.names.first, "avatar-placeholder-001")
        XCTAssertEqual(AvatarPlaceholder.names.last, "avatar-placeholder-200")
    }

    /// Every picture a seed can pick ships in HappyUI's resources as a
    /// WebP, nothing else is there, and the shaders' MIT notice goes with
    /// them.
    func testEveryPictureIsBundled() throws {
        let folder = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("../../Sources/HappyUI/Resources/AvatarPlaceholders")
            .standardizedFileURL
        var total = 0
        for name in AvatarPlaceholder.names {
            let url = folder.appendingPathComponent("\(name).webp")
            let data = try XCTUnwrap(FileManager.default.contents(atPath: url.path), "missing \(url.path)")
            XCTAssertEqual(data.prefix(4), Data("RIFF".utf8), name)
            XCTAssertEqual(data.dropFirst(8).prefix(4), Data("WEBP".utf8), name)
            total += data.count
        }
        let pictures = try FileManager.default.contentsOfDirectory(atPath: folder.path).filter { $0.hasSuffix(".webp") }
        XCTAssertEqual(Set(pictures), Set(AvatarPlaceholder.names.map { "\($0).webp" }))
        XCTAssertLessThan(total, 3_000_000, "the pictures take \(total) bytes")
        let license = try String(contentsOf: folder.appendingPathComponent("LICENSE-craftedstudios-shaders.txt"), encoding: .utf8)
        XCTAssertTrue(license.contains("MIT License"))
        XCTAssertTrue(license.contains("Copyright (c) 2026 Crafted Studios"))
    }
}
