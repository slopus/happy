import Foundation
import XCTest
@testable import HappyCore

/// What new work offers to make at once, as desktop's `createOffers`.
final class StemCellOffersTests: XCTestCase {
    func testOnlyTheKindsTheDaemonServes() {
        var capabilities = AgentWire.Health.Capabilities()
        XCTAssertEqual(StemCellOffer.available(surfaces: true, capabilities: capabilities), [.surface("todo"), .bot])
        capabilities.collaborativeDocuments = true
        capabilities.calendarSurfaces = true
        capabilities.systemMonitorSurfaces = true
        XCTAssertEqual(StemCellOffer.available(surfaces: true, capabilities: capabilities), [
            .surface("todo"), .surface("document"), .surface("calendar"), .surface("system_monitor"), .bot,
        ])
        capabilities.chatSurfaces = true
        XCTAssertEqual(StemCellOffer.available(surfaces: true, capabilities: capabilities).count, 6)
        // No Surfaces at all: a bot is still on offer.
        XCTAssertEqual(StemCellOffer.available(surfaces: false, capabilities: capabilities), [.bot])
    }

    func testASurfaceRowWearsItsKindsGlyph() {
        XCTAssertEqual(StemCellsRows.surfaceGlyph("todo"), "tasks")
        XCTAssertEqual(StemCellsRows.surfaceGlyph("document"), "doc")
        XCTAssertEqual(StemCellsRows.surfaceGlyph("calendar"), "calendar")
        XCTAssertEqual(StemCellsRows.surfaceGlyph("system_monitor"), "pulse")
        XCTAssertEqual(StemCellsRows.surfaceGlyph("chat"), "users")
        XCTAssertEqual(StemCellsRows.surfaceGlyph(nil), "doc")
    }
}
