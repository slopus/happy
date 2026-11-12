import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// New work's empty conversation: Task or Bot over a name and a note on
/// Happy Agent, the computer and folder rows on a legacy account, one
/// block centred between the bar's foot and the composer's top, whatever
/// the keyboard has done to the composer.
final class NewWorkLayoutTests: XCTestCase {
    private typealias M = NewWorkLayout.Metrics
    /// A note that wraps to two 20pt lines at any width.
    private let note = Measurable { CGSize(width: $0, height: 40) }

    private func work(width: CGFloat = 393, top: CGFloat = 106, bottom: CGFloat) -> NewWorkLayout {
        NewWorkLayout(width: width, top: top, bottom: bottom, kindHeight: 32, rows: 1, note: note)
    }

    func testTheWorkBlockIsCentredBetweenTheBarAndTheComposer() {
        // Keyboard down, then up: the composer's top moves, the block follows.
        for bottom: CGFloat in [760, 420] {
            let layout = work(bottom: bottom)
            XCTAssertTrue(layout.fits)
            XCTAssertEqual(layout.block.midY, (106 + bottom) / 2, accuracy: 0.001, "bottom \(bottom)")
            XCTAssertEqual(layout.block.midX, 393 / 2, accuracy: 0.001)
        }
    }

    func testTheKindSitsOverTheNameAndTheNoteUnderIt() throws {
        let layout = work(bottom: 760)
        let kind = try XCTUnwrap(layout.kind)
        XCTAssertEqual(kind, CGRect(x: (320 - M.kindWidth) / 2, y: 0, width: M.kindWidth, height: 32))
        XCTAssertEqual(layout.rows, [CGRect(x: 0, y: 32 + M.kindToRows, width: 320, height: M.rowHeight)])
        let note = try XCTUnwrap(layout.note)
        XCTAssertEqual(note, CGRect(x: 0, y: 32 + M.kindToRows + M.rowHeight + M.rowsToNote, width: 320, height: 40))
        XCTAssertEqual(layout.block.height, note.maxY)
        XCTAssertEqual(layout.block.width, M.maxWidth)
    }

    /// A narrow screen: the block keeps its side margins, the control no
    /// wider than the block.
    func testANarrowScreenKeepsTheSides() throws {
        let layout = work(width: 240, bottom: 760)
        XCTAssertEqual(layout.block.minX, M.side)
        XCTAssertEqual(layout.block.width, 240 - 2 * M.side)
        XCTAssertEqual(try XCTUnwrap(layout.kind).width, 240 - 2 * M.side)
    }

    /// A 430pt Pro Max: still at most 320 wide, in the middle.
    func testAWideScreenCentresAtMostTheMaxWidth() {
        let layout = work(width: 430, top: 110, bottom: 520)
        XCTAssertEqual(layout.block.width, M.maxWidth)
        XCTAssertEqual(layout.block.minX, (430 - M.maxWidth) / 2)
        XCTAssertEqual(layout.block.midY, (110 + 520) / 2, accuracy: 0.001)
    }

    /// Too little room (a landscape phone with the keyboard up): it doesn't
    /// fit, and stands on the composer, running up under the bar.
    func testTooLittleRoomDoesNotFit() {
        let height = 32 + M.kindToRows + M.rowHeight + M.rowsToNote + 40
        let edge = work(top: 100, bottom: 100 + height + 2 * M.margin)
        XCTAssertTrue(edge.fits)
        let short = work(top: 100, bottom: 100 + height + 2 * M.margin - 1)
        XCTAssertFalse(short.fits)
        XCTAssertEqual(short.block.maxY, short.block.minY + height)
        XCTAssertEqual(short.block.maxY, 100 + height + M.margin - 1, "a margin over the composer")
    }

    /// Legacy with one computer: folder and harness, no kind or note.
    func testOneComputerAsksTheFolderAndHarness() {
        let layout = NewWorkLayout(width: 393, top: 106, bottom: 420, kindHeight: nil, rows: 2, note: nil)
        XCTAssertNil(layout.kind)
        XCTAssertNil(layout.note)
        XCTAssertEqual(layout.rows, [
            CGRect(x: 0, y: 0, width: 320, height: M.rowHeight),
            CGRect(x: 0, y: M.rowHeight + M.rowGap, width: 320, height: M.rowHeight),
        ])
        XCTAssertEqual(layout.block.height, 2 * M.rowHeight + M.rowGap)
        XCTAssertEqual(layout.block.midY, (106 + 420) / 2, accuracy: 0.001)
    }

    // MARK: A legacy account's Bot, giving way rather than going

    /// The bot's four-line note (72pt).
    private let botNote = Measurable { CGSize(width: $0, height: 72) }

    /// Kind, computer, name, and the note.
    private func bot(top: CGFloat = 103, bottom: CGFloat) -> NewWorkLayout {
        NewWorkLayout(width: 393, top: top, bottom: bottom, kindHeight: 32, givingWay: 2, note: botNote)
    }

    /// With room, everything shows.
    func testABotShowsEverythingWithRoom() throws {
        let layout = bot(bottom: 760)
        XCTAssertTrue(layout.fits)
        XCTAssertTrue(layout.showsNote)
        let machine = 32 + M.kindToRows
        XCTAssertEqual(layout.rows, [
            CGRect(x: 0, y: machine, width: 320, height: M.rowHeight),
            CGRect(x: 0, y: machine + M.rowHeight + M.rowGap, width: 320, height: M.rowHeight),
        ])
        let note = try XCTUnwrap(layout.note)
        XCTAssertEqual(note.minY, layout.rows[1].maxY + M.rowsToNote)
        XCTAssertEqual(layout.block.height, note.maxY)
        XCTAssertEqual(layout.block.midY, (103 + 760) / 2, accuracy: 0.001)
    }

    /// An iPhone 14 Pro with the keyboard and a two-line composer up, or a
    /// bigger text size: the note goes first, and the kind, the computer
    /// and the name stay, centred.
    func testShortOfRoomTheNoteGoesFirst() {
        let rows = 32 + M.kindToRows + 2 * M.rowHeight + M.rowGap
        let layout = bot(bottom: 103 + rows + 2 * M.margin)
        XCTAssertTrue(layout.fits, "the kind, the computer and the name are on screen")
        XCTAssertFalse(layout.showsNote)
        XCTAssertNil(layout.note)
        XCTAssertNotNil(layout.kind)
        XCTAssertEqual(layout.rows.count, 2)
        XCTAssertEqual(layout.block.height, rows)
    }

    /// Shorter still: the gaps close before anything else goes.
    func testShorterStillTheGapsClose() throws {
        let tight = 32 + M.tightKindToRows + 2 * M.rowHeight + M.tightRowGap
        let layout = bot(bottom: 103 + tight + 2 * M.margin)
        XCTAssertTrue(layout.fits)
        XCTAssertEqual(layout.rows[0].minY, 32 + M.tightKindToRows)
        XCTAssertEqual(layout.rows.map(\.height), [M.rowHeight, M.rowHeight], "controls keep their height")
        XCTAssertEqual(layout.block.height, tight)
        let short = bot(bottom: 103 + tight + 2 * M.margin - 1)
        XCTAssertFalse(short.fits, "a phone held sideways")
        XCTAssertEqual(short.block.maxY, 103 + tight + M.margin - 1, "on the composer, a margin over it")
    }

    /// The computer's status is a chip on the row's top-right corner,
    /// straddling its top edge: as wide as its text, its trailing end and
    /// its middle the same whatever it says.
    func testTheStatusChipSitsOnTheTopRightCorner() {
        typealias S = NewWorkStatusLayout
        let online = S.chip(rowWidth: 320, textWidth: 40.3)
        XCTAssertEqual(online, CGRect(x: 320 - 16 - 55, y: -9, width: 55, height: 18))
        XCTAssertEqual(online.midY, 0, "on the row's top edge")
        let offline = S.chip(rowWidth: 320, textWidth: 66)
        XCTAssertEqual(offline.maxX, online.maxX)
        XCTAssertEqual(offline.midY, online.midY)
        XCTAssertEqual(S.chip(rowWidth: 320, textWidth: 400).width, S.maxWidth, "a long text is cut, not the row")
        XCTAssertLessThan(online.maxY, M.rowHeight / 2 - 19 / 2, "over the name's line box, never on it")
    }

    /// Over the computer row the chip rises into the gap under the kind
    /// and clears it, with room and short of it, inside the block.
    func testTheStatusChipClearsTheKindAndStaysInTheBlock() throws {
        for bottom: CGFloat in [760, 103 + 32 + M.tightKindToRows + 2 * M.rowHeight + M.tightRowGap + 2 * M.margin] {
            let layout = bot(bottom: bottom)
            let kind = try XCTUnwrap(layout.kind)
            let chip = NewWorkStatusLayout.chip(rowWidth: layout.rows[0].width, textWidth: NewWorkStatusLayout.maxWidth)
                .offsetBy(dx: layout.rows[0].minX, dy: layout.rows[0].minY)
            XCTAssertGreaterThanOrEqual(chip.minY - kind.maxY, 5, "\(bottom): clear of the kind")
            XCTAssertGreaterThanOrEqual(chip.minY, 0, "\(bottom): inside the block")
            XCTAssertLessThanOrEqual(chip.maxX, layout.block.width, "\(bottom): inside the block")
        }
    }

    /// Legacy with two: computer, folder, harness, with gaps between.
    func testTwoComputersAskTheComputerOverTheFolderAndHarness() {
        let layout = NewWorkLayout(width: 393, top: 106, bottom: 420, kindHeight: nil, rows: 3, note: nil)
        XCTAssertEqual(layout.rows, [
            CGRect(x: 0, y: 0, width: 320, height: M.rowHeight),
            CGRect(x: 0, y: M.rowHeight + M.rowGap, width: 320, height: M.rowHeight),
            CGRect(x: 0, y: 2 * (M.rowHeight + M.rowGap), width: 320, height: M.rowHeight),
        ])
        XCTAssertEqual(layout.block.height, 3 * M.rowHeight + 2 * M.rowGap)
        XCTAssertEqual(layout.block.midY, (106 + 420) / 2, accuracy: 0.001)
    }

    // MARK: The kind's picture

    /// With room the picture stands centred over the kind, an empty
    /// state's 128 and 16 above it, and the block keeps centring as one.
    func testThePictureStandsOverTheKind() throws {
        let layout = NewWorkLayout(width: 393, top: 106, bottom: 760, kindHeight: 32, rows: 1, note: note, art: true)
        XCTAssertTrue(layout.fits)
        XCTAssertEqual(layout.art, CGRect(x: (320 - 128) / 2, y: 0, width: 128, height: 128))
        let shift = 128 + M.artToKind
        XCTAssertEqual(try XCTUnwrap(layout.kind).minY, shift)
        XCTAssertEqual(layout.rows[0].minY, shift + 32 + M.kindToRows)
        XCTAssertEqual(layout.block.height, try XCTUnwrap(layout.note).maxY)
        XCTAssertEqual(layout.block.midY, (106 + 760) / 2, accuracy: 0.001)
    }

    /// With no rows the block is the picture and the kind, ending at the
    /// kind so the pair centres as one.
    func testWithNoRowsTheBlockEndsAtTheKind() throws {
        let layout = NewWorkLayout(width: 393, top: 106, bottom: 760, kindHeight: 32, rows: 0, note: nil, art: true)
        XCTAssertTrue(layout.rows.isEmpty)
        XCTAssertEqual(layout.block.height, try XCTUnwrap(layout.kind).maxY)
        XCTAssertEqual(layout.block.height, 128 + M.artToKind + 32)
        XCTAssertEqual(layout.block.midY, (106 + 760) / 2, accuracy: 0.001)
    }

    /// Short of room the picture keeps its size and place over the kind:
    /// the block shifts up with the composer, its foot a margin over it,
    /// and runs up under the bar, picture and all.
    func testShortOfRoomThePictureStaysAndTheBlockShiftsUp() throws {
        let height = 128 + M.artToKind + 32 + M.kindToRows + M.rowHeight + M.rowsToNote + 40
        var last: CGFloat?
        for bottom: CGFloat in [760, 100 + height + 2 * M.margin, 400, 300, 200] {
            let layout = NewWorkLayout(width: 393, top: 100, bottom: bottom, kindHeight: 32, rows: 1, note: note, art: true)
            XCTAssertEqual(layout.art, CGRect(x: (320 - 128) / 2, y: 0, width: 128, height: 128), "\(bottom)")
            XCTAssertEqual(try XCTUnwrap(layout.kind).minY, 128 + M.artToKind, "\(bottom)")
            XCTAssertNotNil(layout.note, "\(bottom): the note stays")
            XCTAssertEqual(layout.block.height, height, "\(bottom)")
            XCTAssertEqual(layout.fits, bottom >= 100 + height + 2 * M.margin, "\(bottom)")
            if !layout.fits { XCTAssertEqual(layout.block.maxY, bottom - M.margin, "\(bottom): on the composer") }
            if let last { XCTAssertLessThan(layout.block.minY, last, "\(bottom): shifted up with the composer") }
            last = layout.block.minY
        }
        let under = NewWorkLayout(width: 393, top: 100, bottom: 200, kindHeight: 32, rows: 1, note: note, art: true)
        XCTAssertLessThan(under.block.minY, 100, "under the bar rather than gone")
    }

    /// A legacy account's bot: the note and then the gaps give way, the
    /// robot never; with no room left the block stands on the composer.
    func testABotsPictureOutlastsTheNote() throws {
        let full = NewWorkLayout(width: 393, top: 103, bottom: 760, kindHeight: 32, givingWay: 2, note: botNote, art: true)
        XCTAssertEqual(full.art?.width, 128)
        XCTAssertEqual(try XCTUnwrap(full.kind).minY, 128 + M.artToKind)
        XCTAssertTrue(full.showsNote)
        let rows = 128 + M.artToKind + 32 + M.kindToRows + 2 * M.rowHeight + M.rowGap
        let noNote = NewWorkLayout(width: 393, top: 103, bottom: 103 + rows + 2 * M.margin, kindHeight: 32, givingWay: 2, note: botNote, art: true)
        XCTAssertTrue(noNote.fits)
        XCTAssertFalse(noNote.showsNote, "the note goes first")
        XCTAssertEqual(noNote.art?.width, 128, "the robot stays")
        let short = NewWorkLayout(width: 393, top: 103, bottom: 300, kindHeight: 32, givingWay: 2, note: botNote, art: true)
        XCTAssertFalse(short.fits)
        XCTAssertEqual(short.art?.width, 128, "the robot stays")
        XCTAssertEqual(short.block.maxY, 300 - M.margin, "on the composer")
    }
}
