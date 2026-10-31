import XCTest

/// The account switcher's native menu with one account of each kind (an
/// account made for a computer, a legacy one and an agent connection), none
/// with a picture: every entry is one row style, each wearing its own
/// placeholder. With `HAPPY_PREVIEW_DIR` set, it writes the screens.
final class AccountMenuUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false; _ = skipsQuiescence }

    private func keep(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
        }
    }

    func testEveryKindOfAccountIsOneRowStyle() {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", "home", "-renderer", "UITableView", "-sessionCount", "12", "-accountMix"]
        app.launch()
        let switcher = app.buttons["account-switcher"]
        XCTAssertTrue(switcher.waitForExistence(timeout: 20))
        let style = ProcessInfo.processInfo.environment["HAPPY_STYLE"] ?? "light"
        sleep(2)
        keep("home-accounts-\(style)")
        switcher.tap()
        XCTAssertTrue(app.buttons["Add"].waitForExistence(timeout: 5))
        sleep(1)
        keep("account-menu-mix-\(style)")
    }
}
