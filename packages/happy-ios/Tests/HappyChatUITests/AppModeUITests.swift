import XCTest

/// An HTML artifact that asks to run as an app (`-screen appMode`): its
/// card in the conversation opens it full screen; the page neither scrolls
/// nor zooms and gets the safe area; swipes don't take it away; the close
/// button fades, comes back near a finger, and closes it. Screens are
/// attached, named by step.
@MainActor
final class AppModeUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        super.setUp()
        _ = skipsQuiescence
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    private func keep(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func launch(_ extra: [String] = []) {
        app = XCUIApplication()
        app.launchArguments = ["-screen", "appMode"] + extra
        app.launch()
        fillScreen()
    }

    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    /// An iPad keeps a window's size between launches: one left smaller
    /// (`testWindowedScreens`) is dragged by its corner back to the screen's.
    private func fillScreen() {
        guard UIDevice.current.userInterfaceIdiom == .pad else { return }
        let window = app.windows.firstMatch
        guard window.waitForExistence(timeout: 10) else { return }
        let screen = springboard.windows.firstMatch.frame
        let frame = window.frame
        guard frame.width < screen.width - 1 || frame.height < screen.height - 1 else { return }
        resize(window: frame, to: CGPoint(x: screen.maxX + 40, y: screen.maxY + 40))
        // Then its top-leading corner to the screen's, by its title bar.
        let now = window.frame
        if now.minX > 0 || now.minY > 0 {
            springboard.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: now.midX, dy: now.minY + 6))
                .press(forDuration: 0.3, thenDragTo: springboard.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: now.midX - now.minX, dy: 6)), withVelocity: .slow, thenHoldForDuration: 0.3)
            sleep(1)
            resize(window: window.frame, to: CGPoint(x: screen.maxX + 40, y: screen.maxY + 40))
        }
        print("APP_MODE filled \(frame) -> \(window.frame) on \(screen)")
    }

    /// Drags a window's bottom-trailing resize grabber to `point`.
    private func resize(window frame: CGRect, to point: CGPoint) {
        let origin = springboard.coordinate(withNormalizedOffset: .zero)
        origin.withOffset(CGVector(dx: frame.maxX - 6, dy: frame.maxY - 6))
            .press(forDuration: 0.3, thenDragTo: origin.withOffset(CGVector(dx: point.x, dy: point.y)), withVelocity: .slow, thenHoldForDuration: 0.3)
        sleep(2)
    }

    private var appScreen: XCUIElement { app.otherElements["artifact-app"] }
    private var close: XCUIElement { app.buttons["artifact-app-close"] }
    private var hud: XCUIElement { app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'mode='")).firstMatch }

    private func hudText() -> String { hud.exists ? hud.label : "" }

    private func swipe(from: CGVector, to: CGVector) {
        let window = app.windows.firstMatch
        window.coordinate(withNormalizedOffset: from).press(forDuration: 0.05, thenDragTo: window.coordinate(withNormalizedOffset: to), withVelocity: .fast, thenHoldForDuration: 0.05)
        sleep(1)
    }

    /// The game's card: "Dot Chase", App, Open.
    private func openFromCard(shot: String = "01-chat-card") {
        let card = app.buttons["Open Dot Chase"]
        XCTAssertTrue(card.waitForExistence(timeout: 20), "the conversation never showed")
        // The app's card says so once the page's head is read.
        sleep(3)
        keep(shot)
        card.tap()
    }

    func testTheCardOpensTheAppFullScreenAndOnlyTheCloseButtonClosesIt() throws {
        launch()
        openFromCard()
        XCTAssertTrue(appScreen.waitForExistence(timeout: 15), "the card didn't open the app")
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        XCTAssertEqual(close.label, "Close")
        XCTAssertTrue(hud.waitForExistence(timeout: 20), "the page never ran")
        sleep(1)
        let opened = hudText()
        print("APP_MODE hud: \(opened)")
        XCTAssertTrue(opened.contains("mode=app"), opened)
        XCTAssertTrue(opened.contains("scrollY=0"), opened)
        XCTAssertTrue(opened.contains("zoom=1.00"), opened)
        keep("02-app-open")

        // A swipe up and down the page doesn't scroll it.
        swipe(from: CGVector(dx: 0.5, dy: 0.8), to: CGVector(dx: 0.5, dy: 0.15))
        swipe(from: CGVector(dx: 0.5, dy: 0.3), to: CGVector(dx: 0.5, dy: 0.9))
        XCTAssertTrue(hudText().contains("scrollY=0"), hudText())
        // A pinch doesn't zoom it.
        app.webViews.firstMatch.pinch(withScale: 2.5, velocity: 2)
        sleep(1)
        XCTAssertTrue(hudText().contains("zoom=1.00"), hudText())
        // A double tap doesn't either.
        app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)).doubleTap()
        sleep(1)
        XCTAssertTrue(hudText().contains("zoom=1.00"), hudText())
        keep("03-after-swipes-and-pinch")

        // Neither a swipe from the leading edge nor one down from the top takes it away.
        swipe(from: CGVector(dx: 0.005, dy: 0.5), to: CGVector(dx: 0.95, dy: 0.5))
        XCTAssertTrue(appScreen.exists, "an edge swipe closed the app")
        swipe(from: CGVector(dx: 0.5, dy: 0.12), to: CGVector(dx: 0.5, dy: 0.95))
        XCTAssertTrue(appScreen.exists, "a swipe down closed the app")
        print("APP_MODE after swipes: \(hudText())")

        // The close button fades after three seconds…
        sleep(5)
        XCTAssertEqual(close.value as? String, "faded")
        keep("04-close-faded")
        // …comes back when a finger nears it, and closes the app.
        close.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).withOffset(CGVector(dx: 40, dy: 30)).tap()
        Thread.sleep(forTimeInterval: 0.4)
        XCTAssertEqual(close.value as? String, "shown", "a touch near the button didn't bring it back")
        keep("05-close-shown-near-finger")
        close.tap()
        XCTAssertTrue(appScreen.waitForNonExistence(timeout: 5), "the close button didn't close the app")
        sleep(1)
        keep("06-closed-back-in-chat")
    }

    /// The screens for review, in `HAPPY_ORIENTATION` (portrait or
    /// landscape): the card, the app just opened, its close button faded,
    /// and an ordinary page in the viewer beside it.
    func testScreens() throws {
        let orientation = ProcessInfo.processInfo.environment["HAPPY_ORIENTATION"] ?? "portrait"
        XCUIDevice.shared.orientation = orientation == "landscape" ? .landscapeLeft : .portrait
        launch()
        openFromCard(shot: "card-\(orientation)")
        XCTAssertTrue(appScreen.waitForExistence(timeout: 15), "the card didn't open the app")
        let ran = hud.waitForExistence(timeout: 20)
        if !ran { print("APP_MODE tree: \(app.debugDescription)") }
        XCTAssertTrue(ran, "the page never ran")
        // Painted, its close button still fully shown: it fades three seconds after the page loads.
        XCTAssertEqual(close.value as? String, "shown")
        keep("app-open-\(orientation)")
        sleep(5)
        XCTAssertEqual(close.value as? String, "faded")
        keep("app-faded-\(orientation)")
        print("APP_MODE hud \(orientation): \(hudText())")
        close.tap()
        XCTAssertTrue(appScreen.waitForNonExistence(timeout: 5))
        app.terminate()
        launch(["-viaViewer", "notes"])
        XCTAssertTrue(app.webViews.staticTexts["Release notes"].waitForExistence(timeout: 20), "the page never showed")
        sleep(1)
        XCTAssertFalse(appScreen.exists, "an ordinary page opened as an app")
        keep("page-viewer-\(orientation)")
    }

    /// On an iPad in windowed multitasking: the app's window made smaller
    /// by its corner, the app opened in it, its close button in that
    /// window's top-leading corner rather than the screen's.
    func testWindowedScreens() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("an iPad's windows") }
        XCUIDevice.shared.orientation = .landscapeLeft
        launch()
        XCTAssertTrue(app.buttons["Open Dot Chase"].waitForExistence(timeout: 20))
        let screen = springboard.windows.firstMatch.frame
        let window = app.windows.firstMatch
        let before = window.frame
        resize(window: before, to: CGPoint(x: screen.width * 0.72, y: screen.height * 0.78))
        print("APP_MODE window \(before) -> \(window.frame) on \(screen)")
        openFromCard(shot: "windowed-card-landscape")
        XCTAssertTrue(appScreen.waitForExistence(timeout: 15))
        Thread.sleep(forTimeInterval: 2.2)
        keep("windowed-app-open-landscape")
        print("APP_MODE windowed close at \(close.frame) in window \(app.windows.firstMatch.frame)")
        sleep(5)
        keep("windowed-app-faded-landscape")
        close.tap()
        XCTAssertTrue(appScreen.waitForNonExistence(timeout: 5))
        fillScreen()
    }

    /// Opened as the Artifacts list or the Feed opens it, through the
    /// viewer: the viewer steps aside, and closing the app returns to the
    /// conversation under it.
    func testTheViewerStepsAsideForTheApp() throws {
        launch(["-viaViewer"])
        XCTAssertTrue(appScreen.waitForExistence(timeout: 20), "the viewer didn't open the app")
        XCTAssertTrue(hud.waitForExistence(timeout: 20), "the page never ran")
        keep("07-viewer-presented-app")
        close.tap()
        XCTAssertTrue(appScreen.waitForNonExistence(timeout: 5))
        sleep(1)
        XCTAssertFalse(app.otherElements["artifact"].exists, "the viewer stayed under the app")
        keep("08-viewer-closed")
    }
}
