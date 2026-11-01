import XCTest

/// The composer's "+" through the whole app (`-screen split`:
/// AppCoordinator's window and its ShellViewController), with the drawn
/// library (`-attachLibrary authorized`: picture 0 a photo, picture 1 a
/// video), in the Happy Agent chat and the Happy CLI chat. Taps go through
/// hit-testing, as a finger's do: the hosted tests send the controls'
/// actions straight, which is how the menu's send could stop answering a
/// finger with every one of them passing.
///
/// "+" opens the menu, with and without the keyboard; a photo or a video
/// picked in the grid and sent with the menu's own send closes the menu,
/// leaves nothing waiting in the composer and lands in the transcript. On
/// an iPad each runs in the split and in a window narrowed to one stack.
///
/// The Happy CLI account is seeded offline and can't encrypt, so its
/// upload stops at the outbox's "Not sent"; the upload itself is
/// HostedLegacyAttachTests'. The agent's computer takes the video's upload.
@MainActor
final class AttachButtonUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        _ = skipsQuiescence
        XCUIDevice.shared.orientation = .portrait
    }

    private var add: XCUIElement { app.buttons.matching(NSPredicate(format: "label IN %@", ["Add photo", "Add a picture"])).firstMatch }
    private var sheet: XCUIElement { app.descendants(matching: .any)["attach-sheet"] }
    private var agentMedia: XCUIElementQuery { app.descendants(matching: .any).matching(identifier: "media") }
    private var cliFiles: XCUIElementQuery { app.staticTexts.matching(NSPredicate(format: "label == %@", "File")) }

    /// The layouts to run in: a phone's one; an iPad's split and narrowed.
    private var layouts: [[String]] {
        UIDevice.current.userInterfaceIdiom == .pad ? [[], ["-narrow"]] : [[]]
    }

    private func launch(_ arguments: [String]) {
        app?.terminate()
        app = XCUIApplication()
        app.launchArguments = ["-screen", "split", "-attachLibrary", "authorized"] + arguments
        app.launch()
        XCTAssertTrue(add.waitForExistence(timeout: 20), "\(arguments): the chat never showed its +")
        if arguments.contains("-narrow") {
            let window = app.windows.firstMatch
            let deadline = Date().addingTimeInterval(10)
            while window.frame.width >= 768, Date() < deadline { usleep(200_000) }
        }
        sleep(2)
    }

    private func waitGone(_ element: XCUIElement, _ seconds: TimeInterval = 8) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while element.exists, Date() < deadline { usleep(200_000) }
        return !element.exists
    }

    /// "+" opens the menu; its close takes it away.
    private func opensAndCloses(_ name: String) {
        add.tap()
        XCTAssertTrue(sheet.waitForExistence(timeout: 5), "\(name): the + opened nothing")
        sleep(1)
        app.buttons["attach-close"].tap()
        XCTAssertTrue(waitGone(sheet), "\(name): the menu never closed")
        sleep(1)
    }

    private func plusOpensTheMenu(_ arguments: [String]) {
        for layout in layouts {
            launch(arguments + layout)
            let name = "\(arguments + layout)"
            opensAndCloses("\(name) first")
            opensAndCloses("\(name) again")
            app.textViews.firstMatch.tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "\(name): no keyboard")
            sleep(1)
            opensAndCloses("\(name) with the keyboard")
        }
    }

    /// Picture `index` picked by its circle, sent with the menu's send:
    /// the menu goes, the composer holds nothing, and `landed` turns true.
    private func sendsPicture(_ index: Int, _ arguments: [String], landed: () -> Bool) {
        for layout in layouts {
            launch(arguments + layout)
            let name = "\(arguments + layout) picture \(index)"
            add.tap()
            XCTAssertTrue(sheet.waitForExistence(timeout: 5), "\(name): the + opened nothing")
            let cell = app.descendants(matching: .any)["attach-photo:\(index)"]
            XCTAssertTrue(cell.waitForExistence(timeout: 10), "\(name): the grid never showed it")
            sleep(1)
            cell.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0)).withOffset(CGVector(dx: -17.5, dy: 17.5)).tap()
            let send = app.descendants(matching: .any)["attach-send"]
            XCTAssertTrue(send.waitForExistence(timeout: 3), "\(name): picking offered no send")
            sleep(1)
            send.tap()
            XCTAssertTrue(waitGone(sheet), "\(name): the menu's send didn't send")
            let deadline = Date().addingTimeInterval(15)
            while !landed(), Date() < deadline { usleep(250_000) }
            XCTAssertTrue(landed(), "\(name): nothing landed in the transcript")
            XCTAssertFalse(app.descendants(matching: .any)["composer-attachment"].exists, "\(name): it still waits in the composer")
        }
    }

    func testThePlusOpensTheMenuInTheAgentChat() { plusOpensTheMenu(["-agent", "-open", "ipad-agent"]) }
    func testThePlusOpensTheMenuInTheCLIChat() { plusOpensTheMenu(["-open", "seeded-tab-1"]) }

    func testTheAgentChatSendsAPhoto() {
        sendsPicture(0, ["-agent", "-open", "ipad-agent"]) { agentMedia.count > 0 }
    }

    func testTheAgentChatSendsAVideo() {
        sendsPicture(1, ["-agent", "-open", "ipad-agent"]) { agentMedia.count > 0 }
    }

    func testTheCLIChatSendsAPhoto() {
        sendsPicture(0, ["-open", "seeded-tab-1"]) { cliFiles.count > 0 }
    }

    func testTheCLIChatSendsAVideo() {
        sendsPicture(1, ["-open", "seeded-tab-1"]) { cliFiles.count > 0 }
    }
}
