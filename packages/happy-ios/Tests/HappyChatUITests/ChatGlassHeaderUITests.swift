import XCTest

/// A conversation's header as Telegram's on iOS 26 (`-screen chatHeader`):
/// back, the name and its status on one capsule, compose and More at the
/// right, each on the system's glass, in light and dark, at the top and
/// with the transcript under it; More opens its native menu from its
/// button and a tap on the name opens the detail. With
/// `HAPPY_PREVIEW_DIR` set (`TEST_RUNNER_HAPPY_PREVIEW_DIR` through
/// xcodebuild), it writes what it saw there.
@MainActor
final class ChatGlassHeaderUITests: XCTestCase {
    func testTheHeaderSitsOnGlassBesideTheBarsButtons() throws {
        continueAfterFailure = false
        _ = skipsQuiescence
        XCUIDevice.shared.orientation = .portrait
        for dark in [false, true] {
            for top in [true, false] {
                let name = "\(dark ? "dark" : "light")-\(top ? "top" : "scrolled")"
                let app = XCUIApplication()
                app.launchArguments = ["-screen", "chatHeader"] + (dark ? ["-dark"] : []) + (top ? ["-top"] : [])
                app.launch()
                defer { app.terminate() }
                let title = app.descendants(matching: .any)["chat-title"]
                XCTAssertTrue(title.waitForExistence(timeout: 15), "no title in \(name)")
                let bar = app.navigationBars.firstMatch
                let more = app.buttons["chat-more"]
                let compose = app.buttons["compose"]
                let back = bar.buttons.element(boundBy: 0)
                XCTAssertTrue(more.waitForExistence(timeout: 5))
                XCTAssertTrue(compose.exists)
                XCTAssertTrue(back.exists)
                // Messages are in and placed.
                Thread.sleep(forTimeInterval: 2)
                keep("chat-header-\(name)")
                // The capsule shares Back's line; the name is the upper of its two lines.
                XCTAssertEqual(title.frame.midY, back.frame.midY - 8, accuracy: 1, "the name is off the bar's line in \(name)")
                for button in [back, compose, more] {
                    XCTAssertFalse(title.frame.intersects(button.frame), "the name runs under \(button.identifier) in \(name)")
                }
                XCTAssertLessThan(back.frame.maxX, title.frame.minX)
                XCTAssertLessThan(title.frame.maxX, compose.frame.minX)

                guard top else { continue }
                more.tap()
                let item = app.descendants(matching: .any)["Permission mode"].firstMatch
                XCTAssertTrue(item.waitForExistence(timeout: 5), "More opened no menu in \(name)")
                // Past the morph out of its button.
                Thread.sleep(forTimeInterval: 1.5)
                keep("chat-header-menu-\(name)")
                // Away from the menu, under the header: it closes.
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.6)).tap()
                Thread.sleep(forTimeInterval: 0.8)
                XCTAssertFalse(item.exists)

                // The name opens the conversation's detail.
                title.tap()
                let gone = NSPredicate(format: "exists == false")
                expectation(for: gone, evaluatedWith: title)
                waitForExpectations(timeout: 5)
                keep("chat-header-detail-\(name)")
            }
        }
    }

    private func keep(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let image = XCTAttachment(screenshot: shot)
        image.name = name
        image.lifetime = .keepAlways
        add(image)
        if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
        }
    }
}
