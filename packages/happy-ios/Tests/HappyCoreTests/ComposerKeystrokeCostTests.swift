import Foundation
import XCTest
@testable import HappyCore

/// A keystroke at the end of a long draft, as the chat's composer handles
/// it on the main thread: the storage's edit reaches the text mirror, the
/// blank check stops at the first character, the draft model decides,
/// the writer takes the field's snapshot and the measurement shares it.
/// Only the edit's own units cross on main, at 100 B as at 100 KB.
@MainActor
final class ComposerKeystrokeCostTests: XCTestCase {
    private static let nonBlank = CharacterSet.whitespacesAndNewlines.inverted

    private struct Run {
        var unitsPerKeystroke: Double
        var medianMicroseconds: Double
        var previousMedianMicroseconds: Double
    }

    /// Types `keystrokes` characters at the end of a `length`-unit draft.
    private func type(at length: Int, keystrokes: Int, synced: Bool) async throws -> Run {
        let storage = CountingDraftStorage()
        let writer = ComposerDraftWriter(sessionId: "s", storage: storage, sending: NoSending())
        storage.writer = writer
        let log = DeliveryLog()
        writer.start { log.receive($0) }
        try await log.waitFor(1)

        // The text view's storage, and what the card feeds from it.
        let units = NSMutableString(string: "")
        let mirror = ComposerTextMirror()
        var model = ComposerDraftModel()
        _ = model.receive(log.all[0], text: "", synced: synced, composing: false)
        let opening = String(repeating: "lorem ipsum ", count: length / 12 + 1).prefix(length)
        units.append(String(opening))
        mirror.edited(range: NSRange(location: 0, length: units.length), changeInLength: units.length, in: units)
        if let write = model.textChanged(isBlank: false, synced: synced, text: ComposerDraftText(mirror.snapshot())).write {
            writer.save(write)
        }
        await writer.settle()

        let before = mirror.unitsHandedOver
        var times: [Double] = []
        var previousTimes: [Double] = []
        for index in 0..<keystrokes {
            // UIKit's own editing, not measured.
            let at = units.length
            units.replaceCharacters(in: NSRange(location: at, length: 0), with: "x")

            let start = DispatchTime.now().uptimeNanoseconds
            mirror.edited(range: NSRange(location: at, length: 1), changeInLength: 1, in: units)
            let isBlank = units.rangeOfCharacter(from: Self.nonBlank).location == NSNotFound
            let (write, _) = model.textChanged(isBlank: isBlank, synced: synced, text: ComposerDraftText(mirror.snapshot()))
            if let write { writer.save(write) }
            // The height measurement takes the same snapshot.
            let measured = mirror.snapshot()
            times.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1000)
            XCTAssertEqual(measured.revision, mirror.revision)
            // The debounce running out now and then.
            if index % 10 == 0, let flushed = model.flush(text: ComposerDraftText(measured)) { writer.save(flushed) }
        }

        if let flushed = model.flush(text: ComposerDraftText(mirror.snapshot())) { writer.save(flushed) }
        await writer.settle()
        XCTAssertEqual(storage.stored, units as String, "the newest text is saved")

        // What the main thread did before, on its own so the two don't
        // share the machine: the text copied out for the draft and for the
        // measurement (`textView.text` copies the storage's mutable
        // string), and compared with the text last saved.
        var lastSaved = units as String
        for _ in 0..<keystrokes {
            units.replaceCharacters(in: NSRange(location: units.length, length: 0), with: "x")
            let start = DispatchTime.now().uptimeNanoseconds
            let copy = String(decoding: Array((units.copy() as! NSString as String).utf16), as: UTF16.self)
            let measured = String(decoding: Array((units.copy() as! NSString as String).utf16), as: UTF16.self)
            if copy != lastSaved, synced { lastSaved = measured }
            previousTimes.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1000)
        }
        writer.close()
        func median(_ values: [Double]) -> Double { values.sorted()[values.count / 2] }
        return Run(
            unitsPerKeystroke: Double(mirror.unitsHandedOver - before) / Double(keystrokes),
            medianMicroseconds: median(times),
            previousMedianMicroseconds: median(previousTimes)
        )
    }

    func testAKeystrokeAtTheEndOfA100KBDraftCostsWhatOneAt100BDoes() async throws {
        for synced in [true, false] {
            let short = try await type(at: 100, keystrokes: 200, synced: synced)
            let long = try await type(at: 100_000, keystrokes: 200, synced: synced)
            print(String(format: "COMPOSER_PERF keystroke synced=%@ 100B=%.1fus 100KB=%.1fus units/keystroke=%.0f previous 100B=%.1fus 100KB=%.1fus",
                         synced ? "yes" : "no", short.medianMicroseconds, long.medianMicroseconds, long.unitsPerKeystroke,
                         short.previousMedianMicroseconds, long.previousMedianMicroseconds))
            // The operation count: one unit crosses per keystroke, whatever
            // the length; the model and the writer take no text on main.
            XCTAssertEqual(short.unitsPerKeystroke, 1)
            XCTAssertEqual(long.unitsPerKeystroke, 1)
            // A generous debug ceiling for a shared build machine, and no
            // growth with the text past noise: copying 100 KB on main, as
            // before, costs far more than this slack.
            XCTAssertLessThan(long.medianMicroseconds, 1000)
            XCTAssertLessThan(long.medianMicroseconds, short.medianMicroseconds * 4 + 20)
        }
    }
}
