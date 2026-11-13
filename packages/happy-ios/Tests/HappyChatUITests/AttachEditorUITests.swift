import XCTest

@MainActor
final class AttachEditorUITests: XCTestCase {
    private var app: XCUIApplication!

    private func any(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }
    private func tap(_ id: String) {
        XCTAssertTrue(any(id).waitForExistence(timeout: 10), id)
        any(id).tap()
    }
    private func keep(_ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    func testViewerSelectionCaptionAndEditorAppearance() {
        continueAfterFailure = false
        _ = skipsQuiescence
        app = XCUIApplication()
        app.launchArguments = ["-screen", "split", "-agent", "-open", "ipad-agent", "-attachLibrary", "authorized", "-attachCamera", "fake"]
        app.launch()
        let plus = app.buttons.matching(NSPredicate(format: "label IN %@", ["Add photo", "Add a picture"])).firstMatch
        XCTAssertTrue(plus.waitForExistence(timeout: 30))
        plus.tap()
        tap("attach-photo:2")
        XCTAssertTrue(any("attach-preview-crop").waitForExistence(timeout: 10))
        usleep(400_000)
        keep("viewer-rest")
        any("attach-preview-page:2").tap()
        usleep(250_000)
        XCTAssertTrue(any("attach-preview-crop").isHittable)
        XCTAssertTrue(any("attach-preview-back").isHittable)
        keep("viewer-tap-selected")
        let caption = app.textViews["attach-preview-caption"]
        caption.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        usleep(400_000)
        // Tap the software keyboard: typeText attaches a simulated hardware
        // keyboard on this runtime, which takes the software keyboard down.
        app.keys["A"].tap()
        app.keys["space"].tap()
        app.keys["p"].tap()
        app.keys["h"].tap()
        app.keys["o"].tap()
        app.keys["t"].tap()
        app.keys["o"].tap()
        usleep(450_000)
        keep("viewer-keyboard")
        XCTAssertFalse(any("attach-preview-crop").isHittable)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()
        usleep(450_000)
        tap("attach-preview-crop")
        XCTAssertTrue(any("photo-crop-window").waitForExistence(timeout: 10))
        keep("crop")
        tap("photo-crop-done")
        tap("attach-preview-draw")
        XCTAssertTrue(any("photo-draw-board").waitForExistence(timeout: 10))
        usleep(400_000)
        keep("draw")
        tap("photo-draw-tool:neon")
        let board = any("photo-draw-board")
        board.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.3)).press(forDuration: 0.05, thenDragTo: board.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5)))
        keep("draw-neon")
        tap("photo-draw-done")
        tap("attach-preview-back")
        tap("attach-count")
        XCTAssertFalse(any("attach-preview").exists)
        XCTAssertTrue(any("composer-attachment").waitForExistence(timeout: 10))
        usleep(500_000)
        keep("staged-clean")
    }
}