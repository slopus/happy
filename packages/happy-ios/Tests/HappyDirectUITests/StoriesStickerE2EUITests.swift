import ObjectiveC
import XCTest

/// An animated (`tgs`) sticker against a real computer: the generated test
/// pack (`scripts/generate-test-sticker-packs.py`) in its sticker folder,
/// found by search, playing in the picker and on the canvas, posted, and
/// playing again in My Story's viewer. Moving frames are read from the
/// screen: two pictures of the canvas's middle a moment apart differ only
/// while it plays.
@MainActor
final class StoriesStickerE2EUITests: XCTestCase {
    private let app = XCUIApplication()

    private static let skipsQuiescence: Bool = {
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

    override func setUp() {
        continueAfterFailure = false
        print("StoriesStickerE2EUITests skips quiescence: \(Self.skipsQuiescence)")
        // Direct connection is an experiment, off on a fresh install.
        app.launchEnvironment["STEM_DIRECT"] = "1"
        app.launch()
    }

    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }
    private func pause(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Whether the middle of `element` shows something different a moment later.
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
        let anyRow = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "stem-row:")).firstMatch
        XCTAssertTrue(anyRow.waitForExistence(timeout: 30), "not paired: run a StemCellsUITests test first")
        let mine = element("story-circle:self")
        XCTAssertTrue(mine.waitForExistence(timeout: 10), "no stories row")
        pause(1)
        mine.coordinate(withNormalizedOffset: CGVector(dx: 47.0 / 60, dy: 46.0 / 77)).tap()
        let fromConversations = app.buttons["From conversations"]
        XCTAssertTrue(fromConversations.waitForExistence(timeout: 5), "the + offered no sources")
        fromConversations.tap()
        let conversations = app.cells.matching(NSPredicate(format: "identifier BEGINSWITH %@", "story-conversation:"))
        XCTAssertTrue(conversations.firstMatch.waitForExistence(timeout: 6), "no conversations")
        let firstMedia = element("story-media:0")
        var found = false
        for index in 0..<min(conversations.count, 10) {
            conversations.element(boundBy: index).tap()
            if firstMedia.waitForExistence(timeout: 4), app.cells.matching(NSPredicate(format: "identifier BEGINSWITH 'story-media:' AND (label ENDSWITH[c] '.png' OR label ENDSWITH[c] '.jpg' OR label ENDSWITH[c] '.jpeg')")).count > 0 { found = true; break }
            app.navigationBars.buttons.element(boundBy: 0).tap()
            pause(0.6)
        }
        XCTAssertTrue(found, "no conversation has media")
        // A picture, not a recording: one that plays moves on its own.
        let canvas = element("story-editor-canvas")
        let pictures = app.cells.matching(NSPredicate(format: "identifier BEGINSWITH 'story-media:' AND (label ENDSWITH[c] '.png' OR label ENDSWITH[c] '.jpg' OR label ENDSWITH[c] '.jpeg' OR label ENDSWITH[c] '.heic' OR label ENDSWITH[c] '.webp')"))
        XCTAssertTrue(pictures.firstMatch.waitForExistence(timeout: 4), "the conversation has no picture")
        pictures.firstMatch.tap()
        XCTAssertTrue(canvas.waitForExistence(timeout: 10), "the editor never opened")
        pause(2)
        XCTAssertFalse(moves(canvas), "the canvas moves before anything animated is on it")

        element("story-tool-sticker").tap()
        let search = element("sticker-search")
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("Motion")
        let spin = element("sticker:happy-test-motion/spin")
        XCTAssertTrue(spin.waitForExistence(timeout: 10), "search didn't find the animated test pack")
        pause(2)
        capture("picker")
        XCTAssertTrue(moves(spin), "the sticker holds still in the picker")
        spin.tap()
        pause(2)
        capture("canvas")
        XCTAssertTrue(moves(canvas), "the sticker holds still on the canvas")

        element("story-editor-post").tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: canvas)
        waitForExpectations(timeout: 90)
        pause(2.5)
        mine.tap()
        XCTAssertTrue(element("story-views").waitForExistence(timeout: 8), "My Story didn't open")
        // The newest story is the last of My Story's: tap through to it.
        // Each story settled before it is looked at: a page turning moves too.
        let page = element("story-viewer-page")
        pause(1.2)
        var playing = false
        for _ in 0..<12 {
            if moves(app.windows.firstMatch), moves(app.windows.firstMatch) { playing = true; break }
            let shown = page.value as? String
            app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
            pause(1.2)
            guard page.exists, page.value as? String != shown else { break }
        }
        capture("viewer")
        XCTAssertTrue(playing, "the sticker holds still in the viewer")
        print("STORIES_STICKER_POSTED")
    }
}
