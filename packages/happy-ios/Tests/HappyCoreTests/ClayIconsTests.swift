@testable import HappyCore
import XCTest

final class ClayIconsTests: XCTestCase {
    private var bundled: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/HappyUI/Resources/ClayIcons")
    }

    /// Every slug Happy Agent may assign has its picture in HappyUI, so a
    /// row given one never draws an empty lane.
    func testEverySlugHasItsPicture() {
        for slug in ClayIcons.slugs {
            XCTAssertTrue(FileManager.default.fileExists(atPath: bundled.appendingPathComponent("clay-\(slug).png").path), slug)
        }
    }

    /// The voice and audio icons the daemon offers since `space-icons-voice`.
    func testVoiceIconsAreInTheLibrary() {
        for slug in ["waveform", "microphone", "headphones"] {
            XCTAssertTrue(ClayIcons.contains(slug), slug)
        }
    }
}
