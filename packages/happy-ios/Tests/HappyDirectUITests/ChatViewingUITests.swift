import ObjectiveC
import UIKit
import XCTest

/// The transcript and the working line never idle for XCUITest's wait
/// around every action; as StemCellsUITests does, the private wait goes.
private let skipsQuiescence: Bool = {
    guard let process = NSClassFromString("XCUIApplicationProcess") else { return false }
    var replaced = false
    let one: @convention(block) (AnyObject, Bool) -> Void = { _, _ in }
    let two: @convention(block) (AnyObject, Bool, Bool) -> Void = { _, _, _ in }
    for (name, block) in [
        ("waitForQuiescenceIncludingAnimationsIdle:", one as Any),
        ("waitForQuiescenceIncludingAnimationsIdle:isPreEvent:", two as Any),
    ] {
        guard let method = class_getInstanceMethod(process, NSSelectorFromString(name)) else { continue }
        method_setImplementation(method, imp_implementationWithBlock(block))
        replaced = true
    }
    return replaced
}()

/// Reading a Stem Cell conversation against a real throwaway Happy Agent:
/// nothing of the transcript under the composer, the way back to the
/// newest message, and its pictures opened whole, one after another. The
/// driver (`.context/drive.sh`) pairs and records; the agent makes the
/// conversation these read the first time.
@MainActor
final class ChatViewingUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() {
        continueAfterFailure = false
        print("ChatViewingUITests skips quiescence: \(skipsQuiescence)")
        app.launchEnvironment["STEM_DIRECT"] = "1"
        app.launch()
    }

    /// The computer's Theme in its settings, gone round to `name`
    /// ("Light", "Dark", "Adaptive"), then back to the conversation.
    private func theme(_ name: String) {
        app.tapBack()
        pause(1)
        let mark = element("stem-settings-mark")
        XCTAssertTrue(mark.waitForExistence(timeout: 5))
        mark.tap()
        let row = element("stem-settings:theme")
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        for _ in 0..<3 where !row.label.contains(name) {
            row.tap()
            pause(0.8)
        }
        XCTAssertTrue(row.label.contains(name), "the theme never reached \(name)")
        app.buttons["stem-glass-back"].firstMatch.tap()
        pause(1)
        let happy = element("stem-row:space:Happy")
        XCTAssertTrue(happy.waitForExistence(timeout: 5))
        happy.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        pause(2)
    }

    private func pause(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }

    private var composer: XCUIElement { app.textViews["stem-composer"] }
    private var working: XCUIElement { element("stem-working") }
    private var jump: XCUIElement { app.buttons["stem-jump-latest"] }
    private var pictures: XCUIElementQuery {
        app.descendants(matching: .any).matching(identifier: "stem-media").matching(NSPredicate(format: "label ENDSWITH %@", ".png"))
    }

    /// Pairs if this simulator has no computer yet, then opens Happy's
    /// conversation, asking the agent for four pictures and a long answer
    /// the first time.
    private func openConversation() {
        let any = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:")).firstMatch
        if !any.waitForExistence(timeout: 8) {
            print("STEM_PAIR_READY")
            let match = app.buttons["Emoji match"]
            XCTAssertTrue(match.waitForExistence(timeout: 120), "pairing never showed its emoji")
            pause(1.5)
            match.tap()
            XCTAssertTrue(any.waitForExistence(timeout: 90))
        }
        pause(1)
        let happy = element("stem-row:space:Happy")
        XCTAssertTrue(happy.waitForExistence(timeout: 10))
        happy.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        pause(3)
        if pictures.count < 4 {
            composer.tap()
            composer.typeText(
                "In a temporary folder make four 600x400 PNG pictures, each one solid colour (red, green, blue, orange) with its number 1 to 4 drawn large in white "
                    + "(python, sips or ImageMagick, whatever you have). Present all four inline with one present_files call, in order 1 to 4. "
                    + "Then write the numbers 1 to 80, one per line, and nothing else."
            )
            pause(0.5)
            app.buttons["Send"].tap()
            if app.buttons["Continue"].waitForExistence(timeout: 2) { app.buttons["Continue"].tap() }
            let deadline = Date().addingTimeInterval(420)
            pause(5)
            while Date() < deadline, pictures.count < 4 || working.exists { pause(2) }
            XCTAssertGreaterThanOrEqual(pictures.count, 4, "the agent never presented four pictures")
        }
        if composer.hasFocus { app.swipeDown(velocity: .slow) }
        pause(1.5)
    }

    /// Scrolls the transcript up by `screens` screens, in held drags that
    /// don't fling.
    private func scrollUp(_ screens: Int) {
        for _ in 0..<(screens * 2) {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).press(
                forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7)),
                withVelocity: .slow, thenHoldForDuration: 0.3
            )
            pause(0.4)
        }
    }

    /// The transcript stops at the composer: under it and beside it the
    /// conversation's ground, one flat colour, never a message, light and
    /// dark, read mid-transcript where messages go on past the composer.
    func testNothingUnderTheComposer() {
        openConversation()
        let card = element("stem-input")
        XCTAssertTrue(card.exists)
        for name in ["Light", "Dark"] {
            theme(name)
            scrollUp(1)
            pause(1.5)
            let shot = XCUIScreen.main.screenshot()
            capture("ground-\(name)")
            let frame = card.frame
            // Under the card, clear of the home indicator in the middle,
            // and the gap beside it.
            let under = CGRect(x: 2, y: frame.maxY + 2, width: 90, height: app.frame.height - frame.maxY - 4)
            let beside = CGRect(x: 1, y: frame.minY + 4, width: max(1, frame.minX - 2), height: frame.height - 8)
            for (place, area) in [("under", under), ("beside", beside)] {
                let ink = Self.ink(in: shot.image, area: area)
                XCTAssertEqual(ink, 0, "\(name): \(ink) pixels of something show \(place) the composer")
            }
        }
        theme("Adaptive")
    }

    /// The pixels in `area` (in points) that stand out from the ground
    /// read at its top left corner as text does: far more than the card's
    /// soft shadow ever darkens it.
    private static func ink(in image: UIImage, area: CGRect) -> Int {
        guard let cg = image.cgImage, let data = cg.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else { return -1 }
        let scale = CGFloat(cg.width) / image.size.width
        let pixels = CGRect(x: area.minX * scale, y: area.minY * scale, width: area.width * scale, height: area.height * scale).integral
            .intersection(CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        let step = cg.bitsPerPixel / 8
        func color(_ x: Int, _ y: Int) -> [Int] { (0..<3).map { Int(bytes[y * cg.bytesPerRow + x * step + $0]) } }
        let ground = color(Int(pixels.minX), Int(pixels.minY))
        var count = 0
        for y in Int(pixels.minY)..<Int(pixels.maxY) {
            for x in Int(pixels.minX)..<Int(pixels.maxX) {
                let here = color(x, y)
                if (0..<3).contains(where: { abs(here[$0] - ground[$0]) > 48 }) { count += 1 }
            }
        }
        return count
    }

    /// Scrolled up a screen and more, desktop's way back shows at the
    /// foot, above the composer; a tap goes to the newest message and the
    /// button goes. While the agent works it shimmers.
    func testJumpToLatest() {
        openConversation()
        XCTAssertFalse(jump.exists, "the way back showed at the newest message")
        scrollUp(2)
        XCTAssertTrue(jump.waitForExistence(timeout: 3), "no way back after scrolling up")
        let card = element("stem-input")
        XCTAssertLessThan(jump.frame.maxY, card.frame.minY, "the way back is not above the composer")
        XCTAssertEqual(jump.frame.midX, app.frame.midX, accuracy: 1, "the way back is not centred")
        XCTAssertEqual(jump.value as? String, "idle")
        pause(1)
        capture("jump-shown")
        jump.tap()
        pause(1.5)
        XCTAssertFalse(jump.exists, "the way back stayed at the newest message")
        capture("jump-tapped")

        // Working: scrolled away, it shimmers.
        composer.tap()
        composer.typeText("Run `sleep 20` with your shell tool, one call, then just say done.")
        app.buttons["Send"].tap()
        XCTAssertTrue(working.waitForExistence(timeout: 15), "the agent never started")
        app.swipeDown(velocity: .slow)
        pause(1)
        scrollUp(2)
        XCTAssertTrue(jump.waitForExistence(timeout: 3))
        XCTAssertEqual(jump.value as? String, "working", "the way back doesn't shimmer while the agent works")
        pause(2.5)
        capture("jump-working")
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline, working.exists { pause(1) }
        pause(1)
        XCTAssertEqual(jump.value as? String, "idle", "the way back still shimmers after the turn")
        jump.tap()
        pause(1.5)
        XCTAssertFalse(jump.exists)
    }

    /// A picture opened whole; a swipe to the side shows the next and the
    /// one before, in the conversation's order; a drag down that's let go
    /// short comes back, and one far enough closes it.
    func testPictureViewer() {
        openConversation()
        let count = pictures.count
        XCTAssertGreaterThanOrEqual(count, 4)
        // The second newest, so there is one after it and ones before.
        let picture = pictures.element(boundBy: count - 2)
        for _ in 0..<12 where picture.frame.midY < app.frame.height * 0.2 || picture.frame.midY > app.frame.height * 0.6 {
            let up = picture.frame.midY < app.frame.height * 0.2
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: up ? 0.3 : 0.6)).press(
                forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: up ? 0.55 : 0.35)),
                withVelocity: .slow, thenHoldForDuration: 0.3
            )
            pause(0.6)
        }
        let loaded = NSPredicate(format: "value == %@", "loaded")
        expectation(for: loaded, evaluatedWith: picture)
        waitForExpectations(timeout: 60)
        picture.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let viewer = app.images["stem-picture-viewer"]
        XCTAssertTrue(viewer.waitForExistence(timeout: 5))
        pause(1.5)
        let first = viewer.value as? String ?? ""
        let parts = first.components(separatedBy: " of ")
        XCTAssertEqual(parts.count, 2, "the viewer doesn't say where it is: \(first)")
        let total = Int(parts.last ?? "") ?? 0
        let index = Int(parts.first ?? "") ?? 0
        XCTAssertEqual(total, count, "the viewer pages through \(total) pictures, the conversation has \(count)")
        XCTAssertEqual(index, count - 1)
        capture("viewer-open")

        app.swipeLeft()
        pause(1.2)
        XCTAssertEqual(viewer.value as? String, "\(count) of \(count)", "a swipe left didn't show the next")
        capture("viewer-next")
        app.swipeLeft()
        pause(1.2)
        XCTAssertEqual(viewer.value as? String, "\(count) of \(count)", "the last went past the end")
        app.swipeRight()
        pause(1)
        app.swipeRight()
        pause(1.2)
        XCTAssertEqual(viewer.value as? String, "\(count - 2) of \(count)", "a swipe right didn't show the one before")
        capture("viewer-previous")

        // Dragged down and held: the picture follows the finger and the
        // ground fades; let go there, it closes.
        let middle = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
        middle.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.52)), withVelocity: .slow, thenHoldForDuration: 1.5)
        pause(1)
        XCTAssertTrue(viewer.exists, "a short drag down closed it")
        middle.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)), withVelocity: .slow, thenHoldForDuration: 1)
        pause(1.5)
        XCTAssertFalse(viewer.exists, "a drag down didn't close it")
        XCTAssertTrue(composer.exists)
        capture("viewer-closed")
    }
}
