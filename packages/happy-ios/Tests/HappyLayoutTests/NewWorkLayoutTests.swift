import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// New work's empty conversation: Task or Bot over a name and a note on
/// Happy Agent, the kind, what it is and the computer and folder rows on a
/// legacy account, one
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

    /// With room, everything shows: the kind, what it is, then the rows.
    func testABotShowsEverythingWithRoom() throws {
        let layout = bot(bottom: 760)
        XCTAssertTrue(layout.fits)
        XCTAssertTrue(layout.showsNote)
        let note = try XCTUnwrap(layout.note)
        XCTAssertEqual(note, CGRect(x: 0, y: 32 + M.kindToRows, width: 256, height: 72))
        let machine = note.maxY + M.kindToRows
        XCTAssertEqual(layout.rows, [
            CGRect(x: 0, y: machine, width: 256, height: M.rowHeight),
            CGRect(x: 0, y: machine + M.rowHeight + M.rowGap, width: 256, height: M.rowHeight),
        ])
        XCTAssertEqual(layout.block.height, layout.rows[1].maxY)
        XCTAssertEqual(layout.block.width, M.givingWayMaxWidth, "snugger than Happy Agent's")
        XCTAssertEqual(layout.block.minX, (393 - 256) / 2)
        XCTAssertEqual(layout.block.midY, (103 + 760) / 2, accuracy: 0.001)
    }

    /// The kind, the note and the rows.
    private let whole: CGFloat = 32 + 16 + 72 + 16 + 2 * 44 + 8

    /// Short of room nothing closes or shrinks, as on Happy Agent's new
    /// work: it stands a margin over the composer and runs up, until the
    /// kind meets the bar's foot.
    func testShortOfRoomItStandsOnTheComposerAndShrinksNothing() throws {
        XCTAssertEqual(bot(bottom: 760).block.height, whole)
        let fits = bot(bottom: 103 + whole + 2 * M.margin)
        XCTAssertTrue(fits.fits)
        XCTAssertEqual(fits.block.minY, 103 + M.margin)
        let short = bot(bottom: 103 + whole + 2 * M.margin - 5)
        XCTAssertFalse(short.fits)
        XCTAssertEqual(short.block.height, whole, "nothing shrinks")
        XCTAssertEqual(short.noteAlpha, 1)
        XCTAssertEqual(short.block.maxY, 103 + whole + M.margin - 5, "on the composer, a margin over it")
        XCTAssertEqual(short.block.minY, 103 + M.margin - 5)
    }

    /// Shorter still: the kind stops at the bar's foot, so it can be
    /// tapped, and the rows rise over the note, which fades as they cover
    /// it; never over the composer. Past that, on up under the bar.
    func testTheKindStopsAtTheBarAndTheRowsRiseOverTheNote() throws {
        let bottom: CGFloat = 103 + whole + M.margin - 40
        let layout = bot(bottom: bottom)
        XCTAssertEqual(layout.block.minY + (try XCTUnwrap(layout.kind)).minY, 103, "the kind at the bar's foot")
        XCTAssertEqual(layout.block.maxY, bottom - M.margin, "on the composer")
        XCTAssertEqual(layout.rows.map(\.height), [M.rowHeight, M.rowHeight], "controls keep their height")
        XCTAssertEqual(layout.rows[0].minY, 32 + 16 + 72 + 16 - 40, "risen 40")
        XCTAssertEqual(layout.noteAlpha, 0, "gone before the rows reach it")
        XCTAssertEqual(bot(bottom: 103 + whole + M.margin - 8).noteAlpha, 0.5, accuracy: 0.0001, "fading across the gap")
        XCTAssertEqual(try XCTUnwrap(layout.note).minY, 32 + 16, "the note stays where it was")
        // The kind and the rows alone.
        let bare: CGFloat = 32 + 16 + 2 * 44 + 8
        let covered = bot(bottom: 103 + bare + M.margin)
        XCTAssertEqual(covered.noteAlpha, 0)
        XCTAssertFalse(covered.showsNote)
        XCTAssertEqual(covered.rows[0].minY, 32 + 16, "up to the kind")
        XCTAssertEqual(covered.block.minY, 103)
        let shorter = bot(bottom: 103 + bare + M.margin - 10)
        XCTAssertEqual(shorter.block.minY, 103 - 10, "no room even then: on up under the bar")
        XCTAssertEqual(shorter.block.maxY, 103 + bare - 10)
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

    /// Over the computer row the chip rises into the gap under the note
    /// and clears it, with room and short of it, inside the block.
    func testTheStatusChipClearsTheNoteAndStaysInTheBlock() throws {
        for bottom: CGFloat in [760, 103 + whole + 2 * M.margin, 200] {
            let layout = bot(bottom: bottom)
            let note = try XCTUnwrap(layout.note)
            let kind = try XCTUnwrap(layout.kind)
            let chip = NewWorkStatusLayout.chip(rowWidth: layout.rows[0].width, textWidth: NewWorkStatusLayout.maxWidth)
                .offsetBy(dx: layout.rows[0].minX, dy: layout.rows[0].minY)
            if layout.noteAlpha == 1 { XCTAssertGreaterThanOrEqual(chip.minY - note.maxY, 5, "\(bottom): clear of the note") }
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

    /// A legacy account's bot: the robot is always 77; short of room it
    /// goes up under the bar first, the kind stopping at the bar's foot.
    func testABotsPictureNeverShrinks() throws {
        for bottom: CGFloat in [760, 460, 360, 300] {
            let layout = NewWorkLayout(width: 393, top: 103, bottom: bottom, kindHeight: 32, givingWay: 2, note: botNote, art: true)
            XCTAssertEqual(layout.art?.width, M.givingWayArt, "\(bottom)")
            XCTAssertEqual(try XCTUnwrap(layout.kind).minY, M.givingWayArt + M.artToKind, "\(bottom)")
            XCTAssertGreaterThanOrEqual(layout.block.minY + M.givingWayArt + M.artToKind, 103 - 0.001, "\(bottom): the kind under the bar's foot")
        }
        let short = NewWorkLayout(width: 393, top: 103, bottom: 360, kindHeight: 32, givingWay: 2, note: botNote, art: true)
        XCTAssertFalse(short.fits)
        XCTAssertLessThan(short.block.minY, 103, "the robot under the bar")
        XCTAssertEqual(short.block.maxY, 360 - M.margin, "on the composer")
    }

    /// Laid out at its tallest kind's, the kind, the note and the computer
    /// hold still as the picture and the rows come and go.
    func testTheKindHoldsStillAcrossKinds() throws {
        func kind(art: Bool, rows: Int, bottom: CGFloat) -> NewWorkLayout {
            NewWorkLayout(width: 393, top: 103, bottom: bottom, kindHeight: 32, givingWay: rows, note: botNote, art: art, reserveArt: true, reserveRows: 3)
        }
        for bottom: CGFloat in [760, 460, 360, 300, 200] {
            let session = kind(art: false, rows: 3, bottom: bottom)
            XCTAssertNil(session.art, "\(bottom): a session has none")
            for other in [kind(art: true, rows: 2, bottom: bottom), kind(art: true, rows: 1, bottom: bottom)] {
                XCTAssertEqual(other.block, session.block, "\(bottom)")
                XCTAssertEqual(other.kind, session.kind, "\(bottom)")
                XCTAssertEqual(other.note, session.note, "\(bottom)")
                XCTAssertEqual(other.rows.first, session.rows.first, "\(bottom)")
            }
        }
    }

    /// Held where the tallest keyboard leaves it: the room's foot is the
    /// same with the keyboard up, down, or on its way; a taller keyboard
    /// takes it up.
    func testTheRoomIsHeldWhereTheTallestKeyboardLeavesIt() {
        let height: CGFloat = 852, reserve: CGFloat = 336
        let up = NewWorkLayout.heldBottom(bottom: 400, keyboardTop: height - reserve, height: height, reserve: reserve)
        XCTAssertEqual(up, 400)
        XCTAssertEqual(NewWorkLayout.heldBottom(bottom: 400 + reserve - 34, keyboardTop: height - 34, height: height, reserve: reserve), 400, "down")
        XCTAssertEqual(NewWorkLayout.heldBottom(bottom: 500, keyboardTop: height - reserve + 100, height: height, reserve: reserve), 400, "on its way")
        XCTAssertEqual(NewWorkLayout.heldBottom(bottom: 350, keyboardTop: height - reserve - 50, height: height, reserve: reserve), 350, "taller")
    }

    /// The composer growing line by line: the block keeps every size,
    /// stays centred while it fits, then stands a margin over the composer
    /// and slides up, only ever up, never over the composer, and the kind
    /// never past the bar's foot.
    func testAGrowingComposerSlidesTheBlockUpAndShrinksNothing() throws {
        func layout(_ bottom: CGFloat, art: Bool) -> NewWorkLayout {
            NewWorkLayout(width: 402, top: 116, bottom: bottom, kindHeight: 32, givingWay: art ? 2 : 3, note: botNote, art: art, reserveArt: true, reserveRows: 3)
        }
        for art in [false, true] {
            let rest = layout(520, art: art)
            var lastKind = CGFloat.infinity
            for line in 1...12 {
                let bottom = 520 - CGFloat(min(line, 6) - 1) * 22
                let grown = layout(bottom, art: art)
                XCTAssertEqual(grown.art, rest.art, "line \(line): the picture keeps its size")
                XCTAssertEqual(grown.kind, rest.kind, "line \(line)")
                XCTAssertEqual(grown.note, rest.note, "line \(line)")
                let kind = grown.block.minY + (try XCTUnwrap(grown.kind)).minY
                XCTAssertLessThanOrEqual(kind, lastKind, "line \(line): only up")
                XCTAssertGreaterThanOrEqual(kind, 116, "line \(line): the kind stays under the bar's foot")
                XCTAssertLessThanOrEqual(grown.block.maxY, bottom - M.margin + 0.001, "line \(line): never over the composer")
                lastKind = kind
            }
        }
    }
}

/// A legacy account's row in two columns, lined up across the rows.
final class NewWorkRowColumnsTests: XCTestCase {
    func testTheLabelColumnIsAsWideAsTheWidestLabel() {
        let row = NewWorkRowColumns(size: CGSize(width: 256, height: 44), labelWidth: 69.4, lineHeight: 19.1)
        XCTAssertEqual(row.icon, CGRect(x: 16, y: 14, width: 16, height: 16))
        XCTAssertEqual(row.label, CGRect(x: 40, y: 12, width: 70, height: 20))
        XCTAssertEqual(row.value, CGRect(x: 126, y: 12, width: 256 - 16 - 126, height: 20))
        let other = NewWorkRowColumns(size: CGSize(width: 256, height: 44), labelWidth: 69.4, lineHeight: 19.1)
        XCTAssertEqual(other.value.minX, row.value.minX, "lined up")
    }

    /// The chip rises 9 over the row: the texts, a line high and centred, stay clear of it.
    func testTheTextsStayClearOfTheChip() {
        let row = NewWorkRowColumns(size: CGSize(width: 256, height: 44), labelWidth: 70, lineHeight: 19.1)
        XCTAssertGreaterThan(row.value.minY, NewWorkStatusLayout.chip(rowWidth: 256, textWidth: 40).maxY)
    }
}
