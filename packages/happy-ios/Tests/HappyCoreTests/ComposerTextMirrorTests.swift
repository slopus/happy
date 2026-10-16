import Foundation
import XCTest
@testable import HappyCore

/// The composer's text kept off the main thread from its edits.
final class ComposerTextMirrorTests: XCTestCase {
    /// A text storage's string and the mirror fed from its edits, as
    /// `AgentInputCardView` feeds it from `didProcessEditing`.
    private struct Storage {
        let units = NSMutableString(string: "")
        let mirror = ComposerTextMirror()

        func replace(_ range: NSRange, with text: String) {
            units.replaceCharacters(in: range, with: text)
            let length = (text as NSString).length
            mirror.edited(
                range: NSRange(location: range.location, length: length),
                changeInLength: length - range.length, in: units
            )
        }

        func type(_ text: String) {
            replace(NSRange(location: units.length, length: 0), with: text)
        }
    }

    func testEditsReachTheMirrorInOrder() async {
        let storage = Storage()
        storage.type("hello")
        storage.type(" world")
        storage.replace(NSRange(location: 0, length: 5), with: "goodbye")
        storage.replace(NSRange(location: 7, length: 1), with: "")
        storage.replace(NSRange(location: 7, length: 0), with: "日本😀")
        let text = await storage.mirror.snapshot().text()
        XCTAssertEqual(text, storage.units as String)
        XCTAssertEqual(text, "goodbye日本😀world")
        XCTAssertEqual(storage.mirror.length, storage.units.length)
    }

    /// processEditing coalesces the edits of one begin/endEditing into one
    /// range covering them all.
    func testACoalescedEditReplacesItsWholeRange() async {
        let storage = Storage()
        storage.type("abcdef")
        storage.units.replaceCharacters(in: NSRange(location: 1, length: 1), with: "XY")
        storage.units.replaceCharacters(in: NSRange(location: 4, length: 2), with: "")
        // b→XY and de→"": "aXYcf", edited 1..<4 in the new string, one shorter.
        storage.mirror.edited(range: NSRange(location: 1, length: 3), changeInLength: -1, in: storage.units)
        let text = await storage.mirror.snapshot().text()
        XCTAssertEqual(text, "aXYcf")
    }

    func testASnapshotIsTheTextAtItsRevisionWhateverFollows() async {
        let storage = Storage()
        storage.type("first")
        let first = storage.mirror.snapshot()
        storage.type(", second")
        let second = storage.mirror.snapshot()
        XCTAssertFalse(first === second)
        XCTAssertEqual(first.revision, 1)
        let firstText = await first.text()
        let secondText = await second.text()
        XCTAssertEqual(firstText, "first")
        XCTAssertEqual(secondText, "first, second")
    }

    /// The measurement and the draft writer share one copy per revision.
    func testOneSnapshotPerRevision() {
        let storage = Storage()
        storage.type("a")
        XCTAssertTrue(storage.mirror.snapshot() === storage.mirror.snapshot())
        storage.type("b")
        XCTAssertFalse(storage.mirror.snapshot().revision == 1)
    }

    func testAResetStartsAgainFromTheText() async {
        let mirror = ComposerTextMirror()
        mirror.replace(NSRange(location: 0, length: 0), with: "stale")
        mirror.reset("fresh text")
        XCTAssertEqual(mirror.length, 10)
        let text = await mirror.snapshot().text()
        XCTAssertEqual(text, "fresh text")
    }

    /// Only the edited units cross on the caller's thread: a keystroke at
    /// the end of a 100 KB text hands over one.
    func testAKeystrokeHandsOverOnlyItsOwnUnits() async {
        let storage = Storage()
        storage.type(String(repeating: "x", count: 100_000))
        XCTAssertEqual(storage.mirror.unitsHandedOver, 100_000)
        for _ in 0..<50 { storage.type("y") }
        XCTAssertEqual(storage.mirror.unitsHandedOver, 100_050)
        let text = await storage.mirror.snapshot().text()
        XCTAssertEqual(text.utf16.count, 100_050)
        XCTAssertTrue(text.hasSuffix(String(repeating: "y", count: 50)))
    }

    func testDraftTextsCompareStringsByValueAndSnapshotsByIdentity() async {
        let mirror = ComposerTextMirror()
        mirror.replace(NSRange(location: 0, length: 0), with: "same")
        let snapshot = mirror.snapshot()
        XCTAssertEqual(ComposerDraftText("same"), "same")
        XCTAssertEqual(ComposerDraftText(snapshot), ComposerDraftText(snapshot))
        XCTAssertNotEqual(ComposerDraftText(snapshot), "same", "a snapshot's text isn't read to compare")
        let resolved = await ComposerDraftText(snapshot).resolve()
        XCTAssertEqual(resolved, "same")
    }
}
