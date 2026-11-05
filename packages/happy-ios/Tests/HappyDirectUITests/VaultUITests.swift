import XCTest

/// A vault Surface on a real phone against a Happy Agent that serves
/// vaults. A driver outside the test opens the daemon's pairing link
/// (`VAULT_PAIR_LINK` in the runner's environment, never logged); the test
/// is the person's finger. Each test opens "Demo vault" from home and
/// walks part of the browser, leaving screenshots behind as attachments.
/// The vault holds Docs (Launch plan.md, Reports with Q3 summary.txt and
/// budget.csv), Empty folder, Sites (launch.artifact, handbook.artifact)
/// and notes.txt.
@MainActor
final class VaultUITests: XCTestCase {
    private let app = XCUIApplication()
    private let vault = "Demo vault"

    override func setUp() {
        continueAfterFailure = true
        app.launch()
    }

    // MARK: Steps

    private func any(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func anyStarting(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch
    }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func pause(_ seconds: Double) { Thread.sleep(forTimeInterval: seconds) }

    /// Pairs when the phone has no computer yet.
    private func paired() -> Bool {
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "row:")).firstMatch
        if row.waitForExistence(timeout: 10) { return true }
        if let link = ProcessInfo.processInfo.environment["VAULT_PAIR_LINK"], let url = URL(string: link) {
            app.open(url)
        }
        print("VAULT_PAIR_READY")
        let match = app.buttons["Emoji match"]
        guard match.waitForExistence(timeout: 120) else { return false }
        pause(1.5)
        capture("00-pairing-emoji")
        match.tap()
        return row.waitForExistence(timeout: 90)
    }

    /// Home, then the vault's root.
    private func openVault() {
        XCTAssertTrue(paired(), "no computer")
        let row = app.descendants(matching: .any)["row:space:\(vault)"]
        for _ in 0..<8 where !row.isHittable { app.swipeUp(velocity: .slow) }
        XCTAssertTrue(row.waitForExistence(timeout: 20), "home lists no \(vault)")
        row.tap()
        XCTAssertTrue(any("Docs").waitForExistence(timeout: 20), "the vault's root never showed")
        pause(1)
    }

    private func open(_ label: String, timeout: Double = 15) {
        let element = any(label)
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "no \(label)")
        element.tap()
        pause(1.2)
    }

    /// A folder in the move sheet, not the browser under it.
    private func pick(_ label: String) {
        let list = app.descendants(matching: .any)["vault-folder-picker-list"]
        XCTAssertTrue(list.waitForExistence(timeout: 10))
        let row = list.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "the picker shows no \(label)")
        row.tap()
        pause(1.2)
    }

    private func back() {
        app.navigationBars.buttons.element(boundBy: 0).tap()
        pause(0.8)
    }

    /// Holds a row and picks `action` from its menu.
    private func menu(_ label: String, _ action: String) {
        let element = any(label)
        XCTAssertTrue(element.waitForExistence(timeout: 15), "no \(label)")
        element.press(forDuration: 1.2)
        let button = app.buttons[action]
        XCTAssertTrue(button.waitForExistence(timeout: 5), "no \(action) for \(label)")
        button.tap()
        pause(0.8)
    }

    private func barMenu(_ identifier: String, _ action: String) {
        app.buttons[identifier].tap()
        let button = app.buttons[action]
        XCTAssertTrue(button.waitForExistence(timeout: 5), "no \(action)")
        button.tap()
        pause(1)
    }

    /// Types `text` into the alert's field (whose selection it replaces) and confirms.
    private func answer(_ text: String, _ confirm: String) {
        let field = app.alerts.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        pause(0.5)
        field.typeText(text)
        app.alerts.buttons[confirm].tap()
        pause(1.5)
    }

    // MARK: Walks

    func test1Browse() {
        openVault()
        capture("01-vault-root")
        open("Docs")
        capture("02-folder-docs")
        open("Reports")
        capture("03-folder-reports-path")
        open("Q3 summary.txt")
        pause(2)
        capture("04-preview-text")
        back()
        open("budget.csv")
        pause(2)
        capture("05-preview-csv")
        back(); back()
        open("Launch plan.md")
        pause(3)
        capture("06-preview-markdown")
        back(); back()
        open("Sites")
        capture("07-folder-sites")
        open("launch.artifact")
        pause(6)
        capture("08-preview-site-live")
        back()
        open("handbook.artifact")
        pause(5)
        capture("09-preview-markdown-artifact")
        back(); back()
        // Sort by date, then back to names.
        barMenu("vault-more", "Sort By")
        capture("10-sort-menu")
        app.buttons["Date Modified"].tap()
        pause(1)
        capture("11-sorted-by-date")
        barMenu("vault-more", "Sort By")
        app.buttons["Name"].tap()
        pause(1)
    }

    func test3FoldersRenameMoveTrash() {
        openVault()
        barMenu("vault-add", "New Folder")
        answer("Phone test", "Create")
        XCTAssertTrue(any("Phone test").waitForExistence(timeout: 10))
        capture("14-new-folder")
        menu("Phone test", "Rename")
        answer("Phone folder", "Save")
        XCTAssertTrue(any("Phone folder").waitForExistence(timeout: 10))
        capture("15-renamed")
        menu("notes.txt", "Move")
        XCTAssertTrue(app.buttons["vault-picker-choose"].waitForExistence(timeout: 10))
        pick("Phone folder")
        capture("16-move-picker")
        app.buttons["vault-picker-choose"].tap()
        pause(2)
        XCTAssertFalse(any("notes.txt").exists, "notes.txt is still at the root")
        open("Phone folder")
        XCTAssertTrue(any("notes.txt").waitForExistence(timeout: 10))
        capture("17-moved-into-folder")
        back()
        menu("Phone folder", "Move to Trash")
        pause(1.5)
        capture("18-after-trash")
        barMenu("vault-more", "Trash")
        XCTAssertTrue(any("Phone folder").waitForExistence(timeout: 15))
        capture("19-trash")
        open("Phone folder")
        app.buttons["Restore"].firstMatch.tap()
        pause(2)
        capture("20-trash-after-restore")
        back()
        XCTAssertTrue(any("Phone folder").waitForExistence(timeout: 10))
        // Put the demo back as it was: notes.txt at the root, the folder gone.
        open("Phone folder")
        menu("notes.txt", "Move")
        app.buttons["vault-picker-choose"].tap()
        pause(2)
        back()
        menu("Phone folder", "Move to Trash")
        capture("21-restored-and-tidied")
    }

    func test4Upload() {
        openVault()
        barMenu("vault-add", "Upload Photos and Videos")
        pause(3)
        let photo = app.scrollViews.images.firstMatch
        if photo.waitForExistence(timeout: 10) {
            photo.tap()
            pause(0.5)
            capture("22-photo-picker")
            let add = app.buttons["Add"]
            if add.exists { add.tap() }
            pause(0.4)
            capture("23-upload-progress")
            pause(8)
            capture("24-uploaded")
        } else {
            capture("22-photo-picker-empty")
            app.buttons["Cancel"].firstMatch.tap()
        }
        barMenu("vault-add", "Upload Files")
        pause(3)
        capture("25-files-picker")
        let recent = app.cells.firstMatch
        if recent.waitForExistence(timeout: 5) {
            recent.tap()
            pause(6)
            capture("26-file-uploaded")
        } else {
            app.buttons["Cancel"].firstMatch.tap()
        }
    }

    func test5History() {
        openVault()
        open("Docs")
        menu("Launch plan.md", "Version History")
        XCTAssertTrue(anyStarting("Version 3").waitForExistence(timeout: 15))
        pause(1)
        capture("27-history")
        menu(anyStarting("Version 1").label, "Pin")
        pause(1.5)
        capture("28-history-pinned")
        open(anyStarting("Version 2").label)
        pause(3)
        capture("29-preview-old-version")
        back()
        menu(anyStarting("Version 2").label, "Restore This Version")
        app.alerts.buttons["Restore"].tap()
        XCTAssertTrue(anyStarting("Version 4").waitForExistence(timeout: 15), "restoring made no new version")
        pause(1)
        capture("30-history-restored")
        menu(anyStarting("Version 1").label, "Unpin")
        pause(1)
    }

    func test6ShareAndZip() {
        openVault()
        open("Docs")
        menu("Launch plan.md", "Share")
        pause(4)
        capture("31-share-file")
        app.buttons["Close"].firstMatch.tap()
        pause(1)
        back()
        menu("Sites", "Download as Zip")
        pause(6)
        capture("32-share-folder-zip")
        app.buttons["Close"].firstMatch.tap()
        pause(1)
    }

    func test7Settings() {
        openVault()
        barMenu("vault-more", "Vault Settings")
        XCTAssertTrue(anyStarting("Time Machine").waitForExistence(timeout: 15))
        pause(1)
        capture("33-settings-default")
        open("Last 10 versions")
        pause(1.5)
        capture("34-settings-last-ten")
        open("Custom")
        pause(1)
        capture("35-settings-custom")
        app.swipeUp(velocity: .slow)
        open("1 week")
        pause(1)
        capture("36-settings-trash-week")
        open("30 days")
        app.swipeDown(velocity: .slow)
        open(anyStarting("Time Machine").label)
        pause(1.5)
        capture("37-settings-back-to-default")
    }

    /// Something made on the computer shows here with no refresh.
    func test8Live() {
        openVault()
        print("VAULT_LIVE_READY")
        let made = any("live from the computer")
        XCTAssertTrue(made.waitForExistence(timeout: 240), "the new folder never showed")
        pause(1)
        capture("38-live-update")
    }
}
