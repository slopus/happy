import XCTest

/// The call's bar stays above a sheet the app presents: VoiceOver finds its
/// buttons there, a tap on End reaches it, and the sheet takes back its
/// full height once the bar is gone. A drawn call (`HAPPY_CALL_FIXTURE`),
/// no provider.
final class CallBarOverSheetUITests: XCTestCase {
    @MainActor
    private func keep(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// The sheet's card: the topmost element inset from the screen's sides as a card is.
    @MainActor
    private func cardFrame(_ app: XCUIApplication) throws -> CGRect {
        var found = CGRect.null
        func walk(_ element: XCUIElementSnapshot) {
            let frame = element.frame
            if frame.minX > 4, frame.minX < 20, frame.width > 300, frame.minY > 1, frame.minY < found.minY || found.isNull { found = frame }
            element.children.forEach(walk)
        }
        walk(try app.snapshot())
        return found
    }

    @MainActor
    func testTheBarIsReachableAboveASheetAndEndsTheCall() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", "split", "-agent", "-callSheet"]
        app.launchEnvironment = ["HAPPY_CALL_FIXTURE": "listening", "HAPPY_CALL_DELAY": "0.3"]
        app.launch()
        XCTAssertTrue(app.buttons["End call"].waitForExistence(timeout: 10))
        keep("bar-over-home")
        // The sheet is up: UIKit no longer reads the bar's window, so the
        // sheet carries its echo, one element at the bar's place.
        let echo = app.descendants(matching: .any)["call-bar-echo"]
        XCTAssertTrue(echo.waitForExistence(timeout: 10))
        sleep(2)
        XCTAssertTrue(echo.label.hasPrefix("Voice call"), echo.label)
        let bar = echo.frame
        XCTAssertEqual(bar.minY, 0, accuracy: 1)
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "call-bar-echo").count, 1, "one bar for VoiceOver")
        keep("bar-over-sheet")
        let sheetTop = app.navigationBars.allElementsBoundByIndex.map { $0.frame.minY }.max() ?? 0
        let card = try cardFrame(app)
        XCTAssertGreaterThanOrEqual(card.minY, bar.maxY, "the sheet's card starts below the bar")
        XCTAssertGreaterThanOrEqual(sheetTop, bar.maxY, "the sheet's bar starts below the call's")
        print("[call-sheet] bar \(bar) card \(card) sheetNavTop \(sheetTop)")
        // A tap on End (in the row under the status bar, whose touches are
        // the system's) reaches the bar above the sheet.
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: bar.maxX - 22, dy: bar.maxY - 22)).tap()
        XCTAssertTrue(echo.waitForNonExistence(timeout: 5))
        sleep(1)
        keep("sheet-after-hang-up")
        let restored = app.navigationBars.allElementsBoundByIndex.map { $0.frame.minY }.max() ?? 0
        let grown = try cardFrame(app)
        print("[call-sheet] after card \(grown) sheetNavTop \(restored)")
        XCTAssertLessThan(restored, sheetTop, "the sheet grows back once the bar is gone")
        XCTAssertFalse(app.buttons["End call"].exists)
    }
}
