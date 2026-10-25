import XCTest

/// The story editor and sticker picker driven with a finger over the
/// harness's own computer (`-screen stories -storiesCompose`): a picture
/// from its library, its two tiny sticker packs, and stories made by hand
/// kept as the daemon keeps them. `stories-probe` reports the editor.
@MainActor
final class StoriesEditorUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() {
        continueAfterFailure = false
        app.launchArguments = ["-screen", "stories", "-storiesCompose"]
        app.launch()
    }

    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }
    private var probe: String { (element("stories-probe").value as? String) ?? "" }
    private func pause(_ seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }

    private func field(_ name: String) -> String? {
        probe.split(separator: " ").first { $0.hasPrefix("\(name)=") }.map { String($0.dropFirst(name.count + 1)) }
    }

    private func wait(_ name: String, _ value: String, timeout: TimeInterval = 6, _ message: String = "") {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline, field(name) != value { pause(0.1) }
        XCTAssertEqual(field(name), value, "\(message) — probe: \(probe)")
    }

    private func wait(_ name: String, contains value: String, timeout: TimeInterval = 6, _ message: String = "") {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline, !(field(name) ?? "").contains(value) { pause(0.1) }
        XCTAssertTrue((field(name) ?? "").contains(value), "\(message) — probe: \(probe)")
    }

    /// The topmost overlay's transform: x, y, scale, rotation.
    private var top: [Double] { (field("top") ?? "").split(separator: ",").compactMap { Double($0) } }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private var canvas: XCUIElement { element("story-editor-canvas") }

    private func at(_ x: CGFloat, _ y: CGFloat) -> XCUICoordinate {
        canvas.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y))
    }

    private func drag(_ from: (CGFloat, CGFloat), _ to: (CGFloat, CGFloat), hold: TimeInterval = 0.05) {
        at(from.0, from.1).press(forDuration: hold, thenDragTo: at(to.0, to.1), withVelocity: 600, thenHoldForDuration: 0.3)
    }

    private func openEditor() {
        wait("editor", "1", timeout: 8, "the editor never opened")
        wait("frames", "1")
        XCTAssertTrue(canvas.waitForExistence(timeout: 3))
        pause(0.8)
    }

    /// The newest draft's Edit, as a conversation's story card has it.
    private func editDraft() {
        element("harness-edit-draft").tap()
        wait("editor", "1", "the draft didn't open")
    }

    private func pickSticker(_ id: String) {
        element("story-tool-sticker").tap()
        let cell = element(id)
        XCTAssertTrue(cell.waitForExistence(timeout: 6), "no \(id) in the picker")
        pause(0.6)
        capture("picker")
        cell.tap()
    }

    /// A sticker placed, grown, turned, snapped onto the centre line and
    /// dropped on the bin; text typed on the canvas, sized, filled and in
    /// Georgia; a link and a reaction bubble from the sheet's pills, the
    /// bubble turned dark with a tap; a caption; posted.
    func testMakeAndPost() {
        openEditor()
        capture("editor")

        pickSticker("sticker:shapes/star")
        wait("overlays", "sticker", "the sticker wasn't placed")
        wait("haptics", contains: "stickerDrop")
        pause(0.8)
        XCTAssertEqual(top, [0.5, 0.5, 0.4, 0])
        XCTAssertTrue(element("story-editor-selection").exists, "the new sticker isn't selected")
        capture("selected")

        // Off the centre line and back to just beside it: it snaps on, and
        // holds there. Landing on it where it already sat ticks nothing.
        drag((0.5, 0.5), (0.4, 0.35))
        XCTAssertFalse((field("trail") ?? "").contains("snap"), "a tick for the line it began on — \(probe)")
        drag((0.4, 0.35), (0.505, 0.35))
        wait("trail", contains: "snap", "nothing snapped")
        pause(0.3)
        XCTAssertEqual(top[0], 0.5, accuracy: 0.0005, "not on the centre line — \(probe)")
        XCTAssertEqual(top[1], 0.35, accuracy: 0.03)

        // Pinched larger and turned.
        canvas.pinch(withScale: 1.8, velocity: 1.5)
        pause(0.4)
        XCTAssertGreaterThan(top[2], 0.5, "the pinch didn't grow it — \(probe)")
        canvas.rotate(0.7, withVelocity: 1.5)
        pause(0.4)
        XCTAssertGreaterThan(abs(top[3]), 0.2, "the turn didn't turn it — \(probe)")
        capture("grown-turned")

        // Onto the bin at the canvas's foot, which takes it.
        drag((0.5, 0.35), (0.5, 0.94), hold: 0.05)
        wait("overlays", "", "the bin didn't take it")
        wait("trail", contains: "trashed")
        wait("haptics", contains: "trash")
        capture("trashed")

        // Text typed on the canvas, made larger, half-filled, in Georgia.
        element("story-tool-text").tap()
        XCTAssertTrue(element("story-text-entry").waitForExistence(timeout: 3))
        app.typeText("Shipped it")
        let size = element("story-text-size")
        size.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)).press(forDuration: 0.1, thenDragTo: size.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)))
        element("story-text-fill").tap()
        element("story-text-font").tap()
        let georgia = app.buttons["Georgia"]
        XCTAssertTrue(georgia.waitForExistence(timeout: 3), "no font menu")
        georgia.tap()
        pause(0.5)
        capture("text-entry")
        element("story-text-done").tap()
        wait("overlays", "text", "the text wasn't placed")
        wait("trail", contains: "text:semi,georgia")
        XCTAssertGreaterThan(top[2], 2.5, "the slider didn't size the text — \(probe)")

        // A link, from the sheet's LINK pill.
        element("story-tool-sticker").tap()
        XCTAssertTrue(element("sticker-link").waitForExistence(timeout: 4), "no LINK pill")
        XCTAssertTrue(element("sticker-reaction").exists, "no reaction sticker")
        pause(0.5)
        capture("sheet-pills")
        element("sticker-link").tap()
        let alert = app.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 3))
        alert.textFields.element(boundBy: 0).typeText("happy.engineering")
        alert.buttons["Done"].tap()
        wait("overlays", "text,link", "the link wasn't placed")

        // A reaction bubble from its sticker and an emoji, turned dark with a tap.
        element("story-tool-sticker").tap()
        XCTAssertTrue(element("sticker-reaction").waitForExistence(timeout: 4))
        element("sticker-reaction").tap()
        let laugh = element("emoji:😂")
        XCTAssertTrue(laugh.waitForExistence(timeout: 4))
        laugh.tap()
        wait("overlays", "text,link,reaction")
        pause(0.6)
        at(0.5, 0.5).tap()
        wait("trail", contains: "reaction:dark")

        // A caption.
        element("story-editor-caption").tap()
        app.typeText("Made in the harness\n")
        pause(0.6)
        capture("before-post")

        element("story-editor-post").tap()
        wait("editor", "0", timeout: 8, "the editor didn't close on post")
        wait("saved", "posted:1:3", "the story wasn't posted with its three overlays")
        wait("haptics", contains: "post")
        pause(1)
        capture("posted-row")
    }

    /// Closing with changes asks first; Save draft keeps them, the draft
    /// opens again from its Edit, and its next save edits it.
    func testSaveAndEdit() {
        openEditor()
        pickSticker("sticker-tab-emoji")
        let eyes = element("emoji:😍")
        XCTAssertTrue(eyes.waitForExistence(timeout: 4))
        eyes.tap()
        wait("overlays", "emoji")
        element("story-editor-close").tap()
        let save = app.buttons["Save draft"]
        XCTAssertTrue(save.waitForExistence(timeout: 3), "closing didn't ask")
        capture("discard-sheet")
        save.tap()
        wait("editor", "0")
        wait("saved", "draft:1:1", "the draft wasn't made")

        // Again, from its Edit.
        editDraft()
        wait("overlays", "emoji")
        pickSticker("sticker:shapes/heart")
        wait("overlays", "emoji,sticker")
        element("story-editor-close").tap()
        XCTAssertTrue(save.waitForExistence(timeout: 3))
        save.tap()
        wait("saved", "draft:2:2", "the edit didn't make a second version")

        // A change, then close and discard: the draft stays as saved.
        editDraft()
        wait("overlays", "emoji,sticker")
        pickSticker("sticker:shapes/circle")
        wait("overlays", "emoji,sticker,sticker")
        element("story-editor-close").tap()
        let discard = app.buttons["Discard"]
        XCTAssertTrue(discard.waitForExistence(timeout: 3))
        discard.tap()
        wait("editor", "0")
        wait("saved", "draft:2:2", "discarding changed the draft")
    }

    /// The frames button opens the frames; its "+" opens the library sheet,
    /// two photos picked there in order (numbered 1 and 2, the first
    /// unpicked and picked again as 2) become the second and third frames,
    /// and a card selects the first again.
    func testFrames() {
        openEditor()
        XCTAssertEqual(element("story-editor-frames").value as? String, "1")
        element("story-editor-frames").tap()
        let add = element("story-editor-add")
        XCTAssertTrue(add.waitForExistence(timeout: 3))
        pause(0.4)
        capture("frames-panel")
        add.tap()
        // A fresh install asks for the library first, as a person sees it.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let full = springboard.buttons["Allow Full Access"]
        if full.waitForExistence(timeout: 4) {
            capture("library-access")
            full.tap()
        }
        let first = element("library-cell:0")
        let second = element("library-cell:1")
        XCTAssertTrue(first.waitForExistence(timeout: 8), "the library sheet never showed photos")
        XCTAssertFalse(element("library-add").isHittable, "Add showed with nothing picked")
        pause(0.8)
        capture("library")
        first.tap()
        XCTAssertEqual(first.value as? String, "1")
        second.tap()
        XCTAssertEqual(second.value as? String, "2")
        first.tap()
        XCTAssertEqual((first.value as? String) ?? "", "", "unpicking kept its number")
        XCTAssertEqual(second.value as? String, "1", "the numbers didn't close up")
        first.tap()
        XCTAssertEqual(first.value as? String, "2")
        pause(0.6)
        capture("library-picked")

        // The count after Cancel shows only the picks, in the order picked,
        // until Back.
        let count = element("library-selected")
        XCTAssertTrue(count.isHittable, "no count with two picked")
        XCTAssertEqual(count.label, "2 Selected")
        count.tap()
        XCTAssertTrue(app.staticTexts["2 Selected"].waitForExistence(timeout: 3), "the title didn't say what shows")
        XCTAssertEqual(element("library-cancel").label, "Back")
        XCTAssertEqual(first.value as? String, "1", "the picks aren't in the order picked")
        XCTAssertEqual(second.value as? String, "2")
        XCTAssertFalse(element("library-cell:2").exists, "more than the picks showed")
        XCTAssertFalse(count.isHittable, "the count stayed while only the picks show")
        pause(0.6)
        capture("library-selected")
        element("library-cancel").tap()
        XCTAssertTrue(element("library-cell:2").waitForExistence(timeout: 3), "Back didn't show everything again")
        XCTAssertEqual(element("library-cancel").label, "Cancel")
        XCTAssertEqual(first.value as? String, "2")
        XCTAssertEqual(second.value as? String, "1")
        pause(0.4)
        XCTAssertTrue(count.isHittable, "the count didn't come back")

        let addPicked = element("library-add")
        XCTAssertTrue(addPicked.isHittable)
        XCTAssertEqual(addPicked.label, "Add 2")
        addPicked.tap()
        wait("frames", "3", timeout: 15, "the two photos didn't become frames")
        // The last one added is shown.
        wait("selected", "2")
        pause(1)
        capture("two-photos-added")
        element("story-editor-frame:0").tap()
        wait("selected", "0")
        capture("two-frames")
    }

    /// The picker: Recently used appears with its ✕ once a sticker is used,
    /// search narrows the grid to a pack, an emoji chip finds by emoji, and
    /// the ✕ clears the recents.
    func testPicker() {
        openEditor()
        pickSticker("sticker:shapes/square")
        wait("overlays", "sticker")
        element("story-tool-sticker").tap()
        let recents = element("sticker-header:Recently used")
        XCTAssertTrue(recents.waitForExistence(timeout: 4), "no Recently used")
        XCTAssertTrue(element("sticker-header:Shapes").exists)
        pause(0.5)
        capture("recents")

        element("sticker-search").tap()
        app.typeText("gly")
        let tab = element("sticker-tab-emoji")
        tab.tap()
        XCTAssertTrue(element("sticker:glyphs/plus").waitForExistence(timeout: 4), "search didn't find the glyphs")
        XCTAssertFalse(element("sticker-header:Smileys & People").exists)
        XCTAssertFalse(element("sticker-link").isHittable, "the pills show over search results")
        capture("search")
        element("sticker-search").buttons.firstMatch.tap()
        element("sticker-tab-stickers").tap()

        element("sticker-chip:❤️").tap()
        let heart = element("sticker:shapes/heart")
        XCTAssertTrue(heart.waitForExistence(timeout: 4), "the chip didn't find the heart")
        XCTAssertFalse(element("sticker:shapes/circle").exists)
        capture("chip")
        element("sticker-search").buttons.firstMatch.tap()

        XCTAssertTrue(element("sticker-recents-clear").waitForExistence(timeout: 3))
        element("sticker-recents-clear").tap()
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: recents)
        waitForExpectations(timeout: 4)
    }
}
