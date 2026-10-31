import XCTest

/// A conversation's header as Telegram's on iOS 26 (`-screen chatHeader`):
/// a glass circle for Back, the name and its status on one capsule, and a
/// glass circle for Compose, nothing else, in light and dark, at the top and
/// with the transcript under it. A short name sits on the screen's middle
/// on a capsule of Telegram's minimum width, a medium one on a wider one;
/// a long one moves aside only as far as Compose makes it. A tap on the
/// name opens the detail, where the permission mode the header's More menu
/// once had is a row of its own. With `HAPPY_PREVIEW_DIR` set
/// (`TEST_RUNNER_HAPPY_PREVIEW_DIR` through xcodebuild), it writes what it
/// saw there.
@MainActor
final class ChatGlassHeaderUITests: XCTestCase {
    private static let names = [
        ("short", "hey"),
        ("medium", "Pineapple poem for the team"),
        ("long", "Liquid Glass chat header for the iPhone"),
    ]

    func testTheHeaderSitsOnGlassBesideTheBarsButtons() throws {
        continueAfterFailure = false
        _ = skipsQuiescence
        XCUIDevice.shared.orientation = .portrait
        for dark in [false, true] {
            for (kind, title) in Self.names {
                for top in kind == "long" ? [true, false] : [false] {
                    try check(dark: dark, kind: kind, title: title, top: top)
                }
            }
        }
    }

    private func check(dark: Bool, kind: String, title name: String, top: Bool) throws {
        let label = "\(kind)-\(dark ? "dark" : "light")-\(top ? "top" : "scrolled")"
        let app = XCUIApplication()
        app.launchArguments = ["-screen", "chatHeader", "-title", name] + (dark ? ["-dark"] : []) + (top ? ["-top"] : [])
        app.launch()
        defer { app.terminate() }
        let title = app.descendants(matching: .any)["chat-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 15), "no title in \(label)")
        let bar = app.navigationBars.firstMatch
        let compose = app.buttons["compose"]
        let back = bar.buttons.element(boundBy: 0)
        XCTAssertTrue(compose.waitForExistence(timeout: 5))
        XCTAssertTrue(back.exists)
        // Back, the name, and Compose: no More, no debug button.
        let others = bar.buttons.allElementsBoundByIndex.filter { ![back.identifier, "compose", "chat-title"].contains($0.identifier) && $0.frame != back.frame }
        XCTAssertEqual(others.map(\.identifier), [], "more than Back, the name and Compose in \(label)")
        XCTAssertFalse(app.buttons["chat-more"].exists)
        // Messages are in and placed.
        Thread.sleep(forTimeInterval: 2)
        keep("chat-header-\(label)")
        // The capsule shares Back's line; the name is the upper of its two lines.
        XCTAssertEqual(title.frame.midY, back.frame.midY - 8, accuracy: 1, "the name is off the bar's line in \(label)")
        for button in [back, compose] {
            XCTAssertFalse(title.frame.intersects(button.frame), "the name runs under \(button.identifier) in \(label)")
        }
        // Compose is one circle, as Back is.
        XCTAssertEqual(compose.frame.width, compose.frame.height, accuracy: 4, "Compose isn't a circle in \(label)")
        // The capsule's ends are 12 past the name; the buttons' glass is
        // past their frames.
        XCTAssertLessThan(back.frame.maxX, title.frame.minX - 12)
        XCTAssertLessThan(title.frame.maxX + 12, compose.frame.minX)
        let capsule = app.descendants(matching: .any)["chat-capsule"]
        XCTAssertTrue(capsule.exists, "no capsule in \(label)")
        if kind != "long" {
            XCTAssertEqual(title.frame.midX, app.frame.midX, accuracy: 1, "a \(kind) name is off the screen's middle in \(label)")
            XCTAssertEqual(capsule.frame.midX, app.frame.midX, accuracy: 1, "a \(kind) capsule is off the screen's middle in \(label)")
        }
        if kind == "short" {
            // Telegram's minimum: 150 inside and 14 at each end.
            XCTAssertEqual(capsule.frame.width, 178, accuracy: 1, "a short name's capsule isn't the minimum in \(label)")
        } else if kind == "medium" {
            XCTAssertGreaterThan(capsule.frame.width, 179, "a medium name's capsule didn't grow in \(label)")
            XCTAssertEqual(capsule.frame.width, title.frame.width + 28, accuracy: 1, "a medium capsule isn't its name and 14 each side in \(label)")
        } else {
            // Back and Compose are circles alike: a long name fills the room
            // between them, as far from each, never past the middle's right.
            XCTAssertLessThanOrEqual(title.frame.midX, app.frame.midX + 1, "a long name moved right in \(label)")
            XCTAssertEqual(title.frame.minX - back.frame.maxX, compose.frame.minX - title.frame.maxX, accuracy: 6, "a long name doesn't fill the room in \(label)")
        }

        guard top else { return }
        // The name opens the conversation's detail, the permission mode on it.
        title.tap()
        let permission = app.buttons["profile-permission-mode"]
        XCTAssertTrue(permission.waitForExistence(timeout: 5), "no permission mode on the detail in \(label)")
        XCTAssertFalse(title.exists)
        Thread.sleep(forTimeInterval: 1)
        keep("chat-detail-\(label)")
        let before = permission.value as? String
        permission.tap()
        let write = app.buttons["permission\tworkspace_write"]
        XCTAssertTrue(write.waitForExistence(timeout: 5), "the row opened no menu in \(label)")
        XCTAssertTrue(app.buttons["permission\tauto"].isSelected, "the current mode isn't ticked in \(label)")
        Thread.sleep(forTimeInterval: 1)
        keep("chat-detail-menu-\(label)")
        write.tap()
        let picked = NSPredicate(format: "value != %@", before ?? "")
        expectation(for: picked, evaluatedWith: permission)
        waitForExpectations(timeout: 5)
        permission.tap()
        XCTAssertTrue(app.buttons["permission\tworkspace_write"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["permission\tworkspace_write"].isSelected, "the pick isn't ticked on reopening in \(label)")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)).tap()
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
