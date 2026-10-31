import Foundation
@testable import HappyLayout
import XCTest

/// What the live shader draws each placeholder with: one entry per picture,
/// in the pictures' order, made by the package's own code.
final class AvatarShaderTests: XCTestCase {
    /// The first picture's entry as node gives it from @craftedstudios/shaders
    /// 1.0.1 `resolve({ seed: '0b7ttho', effect: 'linear', size: 1024 })`.
    func testTheFirstEntryIsThePackages() {
        let first = AvatarShader.parameters(0)
        XCTAssertEqual(first.effect, .linear)
        XCTAssertEqual(first.colors.count, 4)
        XCTAssertEqual(first.colors[0].x, 0.881884, accuracy: 1e-6)
        XCTAssertEqual(first.colors[1].z, 0.971817, accuracy: 1e-6)
        XCTAssertEqual(first.colors[3].y, 0.777775, accuracy: 1e-6)
        XCTAssertEqual(first.layout.x, 0.132549, accuracy: 1e-6)
        XCTAssertEqual(first.layout.z, 0.246399, accuracy: 1e-6)
        XCTAssertEqual(first.layout.w, 1.06, accuracy: 1e-6)
        XCTAssertEqual(first.phase, 17.1, accuracy: 1e-5)
        // renderer.js angleOf: phase × the golden angle, mod 2π.
        XCTAssertEqual(Double(first.angle), (17.1 * 2.39996).truncatingRemainder(dividingBy: 2 * .pi), accuracy: 1e-5)
        let fortieth = AvatarShader.parameters(39)
        XCTAssertEqual(fortieth.colors[3].z, 0)
        XCTAssertEqual(fortieth.phase, 43.6, accuracy: 1e-5)
    }

    /// One entry per picture, with the effect the notice says it was made
    /// with: the wall's five chapters of 40.
    func testEveryPictureHasItsEffect() throws {
        let notice = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("../../Sources/HappyUI/Resources/AvatarPlaceholders/AVATAR-PLACEHOLDERS-NOTICE.md")
            .standardizedFileURL
        let text = try String(contentsOf: notice, encoding: .utf8)
        let effects = text.split(separator: "\n").compactMap { line -> String? in
            guard line.hasPrefix("| `avatar-placeholder-") else { return nil }
            return line.split(separator: "|").last.map { $0.trimmingCharacters(in: .whitespaces) }
        }
        XCTAssertEqual(effects.count, AvatarPlaceholder.count)
        XCTAssertEqual(AvatarShader.table.count, AvatarPlaceholder.count)
        for (index, effect) in effects.enumerated() {
            XCTAssertEqual("\(AvatarShader.parameters(index).effect)", effect, "placeholder \(index + 1)")
        }
        XCTAssertEqual(Set(AvatarShader.table.map(\.effect)), Set(AvatarShader.Effect.allCases))
    }

    /// Everything in range: colours in 0...1, the zoom 0.85...1.2, the
    /// offset a fifth each way, the phase under 100 seconds.
    func testEveryEntryIsInRange() {
        for (index, entry) in AvatarShader.table.enumerated() {
            XCTAssertEqual(entry.colors.count, 4, "\(index)")
            for color in entry.colors {
                for channel in [color.x, color.y, color.z] { XCTAssert((0...1).contains(channel), "\(index)") }
            }
            XCTAssert((0.85...1.2).contains(entry.layout.w), "\(index)")
            XCTAssert(abs(entry.layout.x) <= 0.2 && abs(entry.layout.y) <= 0.2, "\(index)")
            XCTAssert((0...(2 * Float.pi)).contains(entry.layout.z), "\(index)")
            XCTAssert((0..<100).contains(entry.phase), "\(index)")
        }
    }

    /// A seed's live placeholder is its still picture's, and its clock
    /// starts at that picture's frame.
    func testASeedMovesFromItsPicturesFrame() {
        for seed in ["", "abc", "person:ada@example.com", "agent:studio.local"] {
            let parameters = AvatarShader.parameters(seed: seed)
            XCTAssertEqual(parameters, AvatarShader.parameters(AvatarPlaceholder.index(seed: seed)))
            XCTAssertEqual(AvatarShader.time(parameters, elapsed: 0), parameters.phase)
            XCTAssertEqual(AvatarShader.time(parameters, elapsed: 2.5), parameters.phase + 2.5, accuracy: 1e-5)
        }
    }

    func testTheGrainGrowsWithTheAvatar() {
        XCTAssertEqual(AvatarShader.grainCell(pixels: 144), 1)
        XCTAssertEqual(AvatarShader.grainCell(pixels: 1080), 2)
    }
}
