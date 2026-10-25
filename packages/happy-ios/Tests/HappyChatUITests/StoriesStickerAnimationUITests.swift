import XCTest

/// An animated (`tgs`) sticker over the harness's computer
/// (`-screen stories -storiesCompose`): it plays in the picker, plays where
/// it is placed on the canvas, goes out with the story, and plays again in
/// the viewer. Moving frames are read from the screen itself: two pictures
/// of the same place a moment apart differ only while it plays.
@MainActor
final class StoriesStickerAnimationUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() {
        continueAfterFailure = false
        app.launchArguments = ["-screen", "stories", "-storiesCompose"]
        app.launch()
    }

    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }
    private var probe: String { (element("stories-probe").value as? String) ?? "" }
    private func pause(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }

    private func field(_ name: String) -> String? {
        probe.split(separator: " ").first { $0.hasPrefix("\(name)=") }.map { String($0.dropFirst(name.count + 1)) }
    }

    private func wait(_ name: String, _ value: String, timeout: TimeInterval = 6, _ message: String = "") {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline, field(name) != value { pause(0.1) }
        XCTAssertEqual(field(name), value, "\(message) — probe: \(probe)")
    }

    /// The row starts closed into the title, as Telegram's does: its
    /// avatars there open it.
    private func openRow() {
        guard field("header") != "open" else { return }
        let collapsed = element("stories-collapsed")
        XCTAssertTrue(collapsed.waitForExistence(timeout: 6))
        collapsed.tap()
        wait("header", "open", "tapping the avatars didn't open the row")
        pause(0.6)
    }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Whether the middle of `element` (where a sticker lands) shows
    /// something different a moment later; the edges, with a viewer's
    /// running progress, are left out.
    private func moves(_ element: XCUIElement) -> Bool {
        func middle() -> Data? {
            let shot = XCUIScreen.main.screenshot().image
            guard let image = shot.cgImage else { return nil }
            let scale = CGFloat(image.width) / shot.size.width
            let frame = element.frame
            let box = CGRect(x: frame.midX - frame.width * 0.2, y: frame.midY - frame.height * 0.15, width: frame.width * 0.4, height: frame.height * 0.3)
            let pixels = CGRect(x: box.minX * scale, y: box.minY * scale, width: box.width * scale, height: box.height * scale).integral
            return image.cropping(to: pixels).flatMap { UIImage(cgImage: $0).pngData() }
        }
        let first = middle()
        pause(0.35)
        let second = middle()
        return first != nil && second != nil && first != second
    }

    func testAnimatedSticker() {
        // `-storiesCompose` opens the editor on the harness's picture, as a
        // conversation's draft does.
        wait("editor", "1", timeout: 8, "the editor never opened")
        let canvas = element("story-editor-canvas")
        XCTAssertTrue(canvas.waitForExistence(timeout: 3))
        pause(0.8)
        XCTAssertFalse(moves(canvas), "the canvas moves before there is anything animated on it")

        // In the picker, by its pack's name.
        element("story-tool-sticker").tap()
        let search = element("sticker-search")
        XCTAssertTrue(search.waitForExistence(timeout: 6), "no picker")
        search.tap()
        app.typeText("Motion")
        let spin = element("sticker:motion/spin")
        XCTAssertTrue(spin.waitForExistence(timeout: 6), "the animated sticker isn't in the picker")
        pause(1.2)
        capture("picker-animated")
        XCTAssertTrue(moves(spin), "the sticker holds still in the picker")

        // On the canvas.
        spin.tap()
        wait("overlays", "sticker", "the sticker wasn't placed")
        pause(1.2)
        capture("canvas-animated")
        XCTAssertTrue(moves(canvas), "the sticker holds still on the canvas")

        // Out with the story, and in the viewer.
        element("story-editor-post").tap()
        wait("editor", "0", timeout: 8, "the editor didn't close on post")
        wait("saved", "posted:1:1", "the story wasn't posted with its sticker")
        pause(1)
        openRow()
        element("story-circle:self").coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.35)).tap()
        wait("viewer", "1", timeout: 8, "the viewer never opened")
        pause(0.8)
        // My Story opens on the harness's own still frames: nothing moves there.
        XCTAssertFalse(moves(app.windows.firstMatch), "a still frame moves in the viewer")
        for _ in 0..<2 {
            app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
            pause(0.8)
        }
        wait("position", "2", "the viewer never reached the new story")
        pause(1)
        capture("viewer-animated")
        XCTAssertTrue(moves(app.windows.firstMatch), "the sticker holds still in the viewer")
    }
}
