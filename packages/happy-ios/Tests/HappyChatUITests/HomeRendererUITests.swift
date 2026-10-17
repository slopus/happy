import XCTest

final class HomeRendererUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false; _ = skipsQuiescence }

    private func launch(_ renderer: String, grouping: String = "flat", count: Int = 0) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", "home", "-renderer", renderer, "-grouping", grouping, "-sessionCount", "\(count)"]
        app.launch()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 20))
        return app
    }

    private func row(_ title: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
    }

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }

    func testTableHomeOpensChat() {
        let app = launch("UITableView")
        let chat = row("Scroll indicator", in: app)
        XCTAssertTrue(chat.waitForExistence(timeout: 15))
        screenshot("Home-UITableView")
        chat.tap()
        XCTAssertTrue(app.buttons["Back"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["Settings"].exists)
    }

    func testUltraHomeOpensChat() {
        let app = launch("UltraList")
        let list = app.descendants(matching: .any)["home.ultralist"]
        XCTAssertTrue(list.waitForExistence(timeout: 15), "must use the real custom UltraList")
        let chat = row("Scroll indicator", in: app)
        XCTAssertTrue(chat.waitForExistence(timeout: 15))
        screenshot("Home-UltraList")
        chat.tap()
        XCTAssertTrue(app.buttons["Back"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["Settings"].exists)
    }

    func testRendererSwitchKeepsAccountAndHomeData() {
        let app = launch("UITableView")
        XCTAssertTrue(row("Scroll indicator", in: app).waitForExistence(timeout: 15))
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
        let appearance = row("Appearance,", in: app)
        XCTAssertTrue(appearance.waitForExistence(timeout: 10)); appearance.tap()
        let renderer = row("Home list renderer,", in: app)
        XCTAssertTrue(renderer.waitForExistence(timeout: 10)); renderer.tap()
        let choice = app.alerts.buttons["UltraList"]
        XCTAssertTrue(choice.waitForExistence(timeout: 10)); XCTAssertTrue(choice.isHittable)
        choice.tap()
        XCTAssertTrue(app.alerts.firstMatch.waitForNonExistence(timeout: 10))
        XCTAssertTrue(row("Home list renderer,", in: app).label.hasSuffix("UltraList"))
        app.navigationBars["Appearance"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
        app.navigationBars["Settings"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.descendants(matching: .any)["home.ultralist"].waitForExistence(timeout: 15))
        XCTAssertTrue(row("Scroll indicator", in: app).exists)
        screenshot("Home-after-live-switch")
        app.terminate()
        let restored = launch("stored")
        XCTAssertTrue(restored.descendants(matching: .any)["home.ultralist"].waitForExistence(timeout: 15))
        XCTAssertTrue(row("Scroll indicator", in: restored).exists)
    }

    func testUltraProjectGroupingAndFastScrollStayResponsive() {
        let grouped = launch("UltraList", grouping: "project")
        XCTAssertTrue(grouped.descendants(matching: .any)["home.ultralist"].waitForExistence(timeout: 15))
        XCTAssertTrue(row("happy", in: grouped).waitForExistence(timeout: 15))
        screenshot("Home-UltraList-projects")
        grouped.terminate()
        let app = launch("UltraList", count: 1000)
        let list = app.descendants(matching: .any)["home.ultralist"]
        XCTAssertTrue(list.waitForExistence(timeout: 15))
        for _ in 0..<4 { list.swipeUp(velocity: .fast) }
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 15))
    }

    func testGroupedHomeOpensChat() {
        let app = launch("UltraList", grouping: "project")
        let list = app.descendants(matching: .any)["home.ultralist"]
        XCTAssertTrue(list.waitForExistence(timeout: 15))
        let chat = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "Scroll indicator", "chat-nav")).firstMatch
        for _ in 0..<5 {
            if chat.exists && chat.isHittable { break }
            list.swipeUp()
        }
        XCTAssertTrue(chat.exists); XCTAssertTrue(chat.isHittable)
        screenshot("Home-UltraList-grouped-before-selection")
        chat.tap()
        XCTAssertTrue(app.buttons["Back"].waitForExistence(timeout: 15))
        screenshot("Home-UltraList-grouped-selected-chat")
    }

    func testTableProjectGrouping() {
        let app = launch("UITableView", grouping: "project")
        XCTAssertTrue(row("happy", in: app).waitForExistence(timeout: 15))
        screenshot("Home-UITableView-projects")
    }
}
