#if canImport(UIKit)
@testable import HappyCore
import HappyLayout
import HappyStore
@testable import HappyUI
import UIKit
import XCTest

@MainActor
private final class CaptureUltraView: HomeUltraListView {
    var snapshots: [[HomeUltraRow]] = []
    var insetUpdates = 0
    var deactivations = 0
    var waiting: CheckedContinuation<Void, Never>?
    override func apply(rows: [HomeUltraRow]? = nil, top: CGFloat, bottom: CGFloat, archiveToggle: Bool = false) {
        guard let rows else { insetUpdates += 1; return }
        snapshots.append(rows)
        waiting?.resume(); waiting = nil
    }
    override func deactivate() { deactivations += 1 }
    func nextSnapshot() async -> [HomeUltraRow] {
        await withCheckedContinuation { waiting = $0 }
        return snapshots.last!
    }
}

@MainActor
final class HomeUltraListTests: XCTestCase {
    override func setUp() { super.setUp(); LegacyFonts.registerBundledFonts() }

    func testDeferredArchivedTextKeepsNativePixelsAndOverlayGeometry() async {
        for category in [UIContentSizeCategory.large, .accessibilityExtraExtraExtraLarge] {
            let environment = await HomeTextEnvironment.make(.init(scale: TextScale(TextSizeCategory(category)), displayScale: 3))
            let sessions = [HomeRowMeasurerTests.session(workspace: nil), HomeRowMeasurerTests.session(workspace: "A long workspace title for exact truncation")]
            await Task.detached {
                func draw(_ plan: HomeRowDrawing) -> Data? {
                    let format = UIGraphicsImageRendererFormat(); format.scale = 3; format.opaque = false
                    return UIGraphicsImageRenderer(size: plan.size, format: format).image { plan.draw(in: $0.cgContext) }.pngData()
                }
                for var row in sessions {
                    row.archived = true; row.faded = true; row.shimmersTitle = false; row.corner = .timestamp
                    for width in [CGFloat(320), 430] {
                        for grouped in [false, true] {
                            let source: HomeListRow = grouped ? .project(.archived(row)) : .flat(.session(row))
                            let exact = HomeRowDrawing.make(source, width: width, grouped: grouped, selected: true, environment: environment, dark: true)
                            let deferred = HomeRowDrawing.make(source, width: width, grouped: grouped, selected: true, environment: environment, dark: true, deferArchiveText: true)
                            XCTAssertTrue(deferred.defersText)
                            XCTAssertTrue(deferred.marks.isEmpty, "no eager text plan for hidden archive rows")
                            XCTAssertEqual(exact.size, deferred.size)
                            XCTAssertEqual(exact.avatarFrame, deferred.avatarFrame)
                            XCTAssertEqual(exact.avatarAlpha, deferred.avatarAlpha)
                            XCTAssertEqual(exact.accessibilityLabel, deferred.accessibilityLabel)
                            XCTAssertEqual(exact.background, deferred.background)
                            XCTAssertEqual(draw(exact), draw(deferred), "visible rows still use exact native TextKit geometry")
                        }
                    }
                    row.archived = false
                    XCTAssertFalse(HomeRowDrawing.make(.flat(.session(row)), width: 320, grouped: false, selected: false, environment: environment, dark: false, deferArchiveText: true).defersText)
                    row.archived = true; row.shimmersTitle = true
                    XCTAssertFalse(HomeRowDrawing.make(.flat(.session(row)), width: 320, grouped: false, selected: false, environment: environment, dark: false, deferArchiveText: true).defersText)
                    row.shimmersTitle = false; row.corner = .blockedDot
                    XCTAssertFalse(HomeRowDrawing.make(.flat(.session(row)), width: 320, grouped: false, selected: false, environment: environment, dark: false, deferArchiveText: true).defersText)
                }
            }.value
        }
    }

    func testCustomPlansKeepExistingSessionGeometryAtEveryTextSize() async {
        for category in [UIContentSizeCategory.large, .extraExtraExtraLarge, .accessibilityExtraExtraExtraLarge] {
            let text = TextEnvironment(scale: TextScale(TextSizeCategory(category)), displayScale: 3)
            let environment = await HomeTextEnvironment.make(text)
            for workspace in [nil, "fix-login"] {
                let row = HomeRowMeasurerTests.session(workspace: workspace, changes: HomeRowMeasurerTests.changes)
                for width in [CGFloat(320), 393, 430] {
                    let plan = await Task.detached { HomeRowDrawing.make(.flat(.session(row)), width: width, grouped: false, selected: false, environment: environment, dark: false) }.value
                    let cell = SessionRowCell(style: .default, reuseIdentifier: nil)
                    cell.traitOverrides.followsTextSize = true
                    cell.traitOverrides.preferredContentSizeCategory = category
                    cell.traitOverrides.displayScale = 3
                    cell.lines = environment.rows.sessionLines
                    cell.configure(row, style: .gradient, monochrome: false)
                    cell.updateTraitsIfNeeded()
                    let layout = cell.layout(width: width)
                    XCTAssertEqual(plan.size, layout.size)
                    XCTAssertEqual(plan.avatarFrame, layout.avatar)
                    XCTAssertTrue(plan.accessibilityLabel.contains("+1.2k"))
                    XCTAssertTrue(plan.accessibilityLabel.contains("-7"))
                }
            }
        }
    }

    func testLatestWidthWinsAndOneChangedSessionKeepsOtherRevision() async throws {
        let environment = await HomeTextEnvironment.make(.init(scale: .standard, displayScale: 3))
        let bridge = CaptureUltraView()
        let adapter = HomeUltraListAdapter(view: bridge, pictures: nil)
        var first = HomeRowMeasurerTests.session("first", workspace: "branch")
        let second = HomeRowMeasurerTests.session("second", workspace: nil)
        func model(_ first: SessionRow) -> HomeListModel {
            HomeListModel(ids: [.session(first.id), .session(second.id)], rows: [.flat(.session(first)), .flat(.session(second))], avatarStyle: .gradient, avatarMonochrome: false, grouped: false, offline: nil)
        }
        adapter.update(.init(model: model(first), width: 320, environment: environment, dark: false, selected: nil))
        adapter.update(.init(model: model(first), width: 430, environment: environment, dark: false, selected: "second"))
        let initial = await bridge.nextSnapshot()
        let initialRows = initial
        XCTAssertEqual(initialRows.count, 2)
        let overlay = initialRows[0].makeOverlay
        XCTAssertEqual(overlay().bounds.width, 430, "obsolete width must never mount")
        first.title = "Newest title"
        adapter.update(.init(model: model(first), width: 430, environment: environment, dark: false, selected: "second"))
        let changed = await bridge.nextSnapshot()
        let changedRows = changed
        XCTAssertNotEqual(initialRows[0].revision, changedRows[0].revision)
        XCTAssertTrue(initialRows[1] === changedRows[1], "unchanged rows keep the actual NodeRow and prepared content")
        XCTAssertTrue(changedRows[0].plan.accessibilityLabel.contains("Newest title"))
        let applies = bridge.snapshots.count
        adapter.setInsets(top: 100, bottom: 108)
        XCTAssertEqual(bridge.snapshots.count, applies, "insets must not rebuild rows")
        XCTAssertEqual(bridge.insetUpdates, 1)
        adapter.deactivate()
    }

    func testDetachedRendererCannotRunOldAccountActions() async throws {
        let environment = await HomeTextEnvironment.make(.init(scale: .standard, displayScale: 3))
        let row = HomeRowMeasurerTests.session(workspace: nil)
        let model = HomeListModel(ids: [.session(row.id)], rows: [.flat(.session(row))], avatarStyle: .pixelated, avatarMonochrome: false, grouped: false, offline: nil)
        let bridge = CaptureUltraView()
        let adapter = HomeUltraListAdapter(view: bridge, pictures: nil)
        var opened: [HomeListRow.ID] = []
        adapter.onSelect = { opened.append($0) }
        adapter.update(.init(model: model, width: 393, environment: environment, dark: false, selected: nil))
        let snapshot = await bridge.nextSnapshot()
        let tap = try XCTUnwrap(snapshot[0].select)
        tap()
        XCTAssertEqual(opened, [.session(row.id)])
        adapter.deactivate()
        tap()
        XCTAssertEqual(opened.count, 1)
        XCTAssertEqual(bridge.deactivations, 1)
    }

    func testReinsertedIdentityCannotReuseRemovedAsyncRevision() async throws {
        let environment = await HomeTextEnvironment.make(.init(scale: .standard, displayScale: 3))
        var row = HomeRowMeasurerTests.session(workspace: nil)
        let bridge = CaptureUltraView()
        let adapter = HomeUltraListAdapter(view: bridge, pictures: nil)
        func update(_ row: SessionRow?) {
            let model = HomeListModel(ids: row.map { [.session($0.id)] } ?? [], rows: row.map { [.flat(.session($0))] } ?? [], avatarStyle: .gradient, avatarMonochrome: false, grouped: false, offline: nil)
            adapter.update(.init(model: model, width: 393, environment: environment, dark: false, selected: nil))
        }
        update(row)
        let initial = await bridge.nextSnapshot()
        let before = try XCTUnwrap(initial.first?.revision)
        update(nil)
        _ = await bridge.nextSnapshot()
        row.title = "Reinserted newest content"
        update(row)
        let final = await bridge.nextSnapshot()
        let after = try XCTUnwrap(final.first?.revision)
        XCTAssertNotEqual(before, after, "UltraList may still retain the removed revision's measurement or bitmap")
        adapter.deactivate()
    }

    func testPressFeedbackSitsUnderContentAsTableCellsShowIt() async throws {
        let environment = await HomeTextEnvironment.make(.init(scale: .standard, displayScale: 2))
        let session = HomeRowMeasurerTests.session(workspace: nil)
        let plans = await Task.detached {
            [false, true].map { grouped in
                (HomeRowDrawing.make(grouped ? .project(.archiveToggle(hidden: true)) : .flat(.archiveToggle(hidden: true)), width: 320, grouped: grouped, selected: false, environment: environment, dark: false),
                 HomeRowDrawing.make(.flat(.session(session)), width: 320, grouped: grouped, selected: false, environment: environment, dark: false),
                 HomeRowDrawing.make(.flat(.dayHeader(.today)), width: 320, grouped: grouped, selected: false, environment: environment, dark: false))
            }
        }.value
        for (grouped, (toggle, row, heading)) in zip([false, true], plans) {
            // ArchiveToggleCell: half-strength content over its page colour.
            XCTAssertEqual(toggle.press, .dim)
            XCTAssertEqual(toggle.background, grouped ? Palette.groupedBackground : Palette.flatListBackground)
            XCTAssertEqual(row.press, .fill(Palette.surfaceSelected), "SessionRowCell's selected background")
            XCTAssertEqual(heading.press, .none)
            // The page colour is the row view's layer, so a press fill can
            // sit between it and the drawing: the drawing leaves it clear.
            let corner = await Task.detached { () -> UInt8 in
                let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = false
                let image = UIGraphicsImageRenderer(size: toggle.size, format: format).image { HomeNodeDrawing(plan: toggle).draw(in: $0.cgContext, bounds: CGRect(origin: .zero, size: toggle.size)) }
                var pixel: [UInt8] = [0, 0, 0, 0]
                pixel.withUnsafeMutableBytes { bytes in
                    let context = CGContext(data: bytes.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
                    context.clear(CGRect(x: 0, y: 0, width: 1, height: 1))
                    context.draw(image.cgImage!, in: CGRect(x: 0, y: 0, width: toggle.size.width, height: toggle.size.height))
                }
                return pixel[3]
            }.value
            XCTAssertEqual(corner, 0, "the drawing must not paint over the press fill")
        }
        let model = HomeListModel(ids: [.archiveToggle, .session(session.id)], rows: [.flat(.archiveToggle(hidden: true)), .flat(.session(session))], avatarStyle: .gradient, avatarMonochrome: false, grouped: false, offline: nil)
        let bridge = CaptureUltraView()
        let adapter = HomeUltraListAdapter(view: bridge, pictures: nil)
        adapter.update(.init(model: model, width: 320, environment: environment, dark: false, selected: nil))
        let rows = await bridge.nextSnapshot()
        XCTAssertNotNil(rows[0].select)
        XCTAssertNil(rows[0].longPress, "a held toggle must stay a tap")
        XCTAssertNotNil(rows[1].longPress)
        adapter.deactivate()
    }

    func testNodeDrawingRunsOnBackgroundQueue() async {
        let environment = await HomeTextEnvironment.make(.init(scale: .standard, displayScale: 3))
        let row = HomeRowMeasurerTests.session(workspace: "branch", changes: HomeRowMeasurerTests.changes)
        let plan = await Task.detached { HomeRowDrawing.make(.flat(.session(row)), width: 393, grouped: false, selected: false, environment: environment, dark: false) }.value
        let drawn = await Task.detached {
            XCTAssertFalse(Thread.isMainThread)
            let format = UIGraphicsImageRendererFormat(); format.scale = 3
            let image = UIGraphicsImageRenderer(size: plan.size, format: format).image { context in
                HomeNodeDrawing(plan: plan).draw(in: context.cgContext, bounds: CGRect(origin: .zero, size: plan.size))
            }
            return image.cgImage != nil
        }.value
        XCTAssertTrue(drawn)
    }

    func testGitCountsKeepTheirSemanticFramesWhenOtherSlotsAreAbsent() async {
        let environment = await HomeTextEnvironment.make(.init(scale: .standard, displayScale: 3))
        for approximate in [false, true] {
            for insertions in [0, 1234] {
                for deletions in [0, 7] {
                    let counts = HomeGitDrawing(.init(approximate: approximate, insertions: insertions, deletions: deletions), flat: true, environment: environment)
                    var plan = HomeRowDrawing(environment: environment, dark: false)
                    let offset = CGRect(x: 33, y: 11, width: counts.layout.size.width, height: counts.layout.size.height)
                    counts.append(to: &plan, at: offset)
                    let marks = plan.marks.compactMap { mark -> (String, CGRect)? in
                        if case .text(let value, _, _, let frame) = mark { return (value, frame) }
                        return nil
                    }
                    XCTAssertEqual(marks.count, (approximate ? 1 : 0) + (insertions > 0 ? 1 : 0) + (deletions > 0 ? 1 : 0))
                    if deletions > 0 {
                        XCTAssertEqual(marks.last?.0, "-7")
                        XCTAssertEqual(marks.last?.1, counts.layout.removed?.offsetBy(dx: 33, dy: 11))
                    }
                    if insertions > 0 { XCTAssertTrue(counts.spoken.contains("+1.2k")) }
                }
            }
        }
    }

    func testTabletPlansMatchNativeHeadersAndCardSegments() async throws {
        _ = await TranslationCatalog.load("en")
        for category in [UIContentSizeCategory.large, .accessibilityExtraExtraExtraLarge] {
            let environment = await HomeTextEnvironment.make(.init(scale: TextScale(TextSizeCategory(category)), displayScale: 2))
            for width in [CGFloat(280), 320] {
                func check(_ row: TabletGroupedRow, cell: UITableViewCell, title: StyledLabel) throws {
                    let plan = HomeRowDrawing.makeTablet(row, width: width, selected: true, environment: environment, dark: true)
                    cell.traitOverrides.preferredContentSizeCategory = category
                    cell.traitOverrides.displayScale = 2; cell.updateTraitsIfNeeded()
                    cell.frame = CGRect(x: 0, y: 0, width: width, height: plan.size.height)
                    cell.layoutIfNeeded()
                    XCTAssertEqual(plan.size, cell.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)))
                    let frame = try XCTUnwrap(plan.marks.compactMap { mark -> CGRect? in
                        if case .text(let value, _, _, let frame) = mark, value == title.string { return frame }
                        return nil
                    }.first)
                    let native = title.convert(title.bounds, to: cell.contentView)
                    XCTAssertEqual(PixelGrid.snap(frame, scale: 2), native)
                }
                let heading = TabletSectionHeaderCell(style: .default, reuseIdentifier: nil)
                heading.configure(Strings.Tablet.bots)
                try check(.botsHeader, cell: heading, title: heading.label)
                let workspace = TabletWorkspaceHeader(id: "p", projectName: "happy", avatar: .init(seed: "p"), branch: "main", changes: .init(approximate: false, insertions: 0, deletions: 7), checkout: nil, place: .init(machineId: nil, path: nil, worktreeKey: nil))
                let header = TabletWorkspaceHeaderCell(style: .default, reuseIdentifier: nil)
                header.configure(workspace, style: .gradient, monochrome: false)
                try check(.workspace(workspace), cell: header, title: header.titleLabel)
                for first in [false, true] {
                    for last in [false, true] {
                        let chat = TabletChatRow(id: "c", title: "A chat title with enough words for two lines", connected: true, indicator: .dot(.working, pulsing: false), showsBorder: !last, first: first, last: last, projectEnd: last)
                        let cell = TabletChatCell(style: .default, reuseIdentifier: nil); cell.configure(chat)
                        try check(.chat(chat), cell: cell, title: cell.titleLabel)
                    }
                }
                let session = SessionRecord(id: "a", seq: 1, createdAt: 0, updatedAt: 0, active: false, activeAt: 0, projectId: nil, metadataVersion: 1, metadataCipher: "", metadata: nil, agentStateVersion: 0, agentStateCipher: nil, agentState: nil, dataKeyCipher: "", decryptable: true, thinking: false, unread: false)
                var archived = TabletArchivedRow(session, row: HomeRowMeasurerTests.session("a", workspace: nil), now: 10_000, first: true)
                archived.last = true
                let cell = TabletArchivedCell(style: .default, reuseIdentifier: nil)
                cell.configure(archived, style: .gradient, monochrome: false)
                try check(.archived(archived), cell: cell, title: cell.titleLabel)
            }
        }
    }

    func testGroupedPlansUseCapturedLanguageOffMain() async {
        let environment = await HomeTextEnvironment.make(.init(scale: .standard, displayScale: 2))
        let catalog = await TranslationCatalog.load("ru")
        let expected = catalog("sidebar.bots")
        let plans = await Task.detached {
            [HomeRowDrawing.makeTablet(.botsHeader, width: 320, selected: false, environment: environment, dark: false, catalog: catalog),
             HomeRowDrawing.make(.flat(.archiveToggle(hidden: true)), width: 320, grouped: false, selected: false, environment: environment, dark: false, catalog: catalog)]
        }.value
        XCTAssertEqual(plans[0].accessibilityLabel, expected)
        XCTAssertEqual(plans[1].accessibilityLabel, catalog("sidebar.showArchived"))
        XCTAssertNotEqual(expected, "Bots")
        let previous = AppLocalization.screens
        AppLocalization.use(catalog)
        defer { AppLocalization.use(previous) }
        let view = CaptureUltraView()
        let adapter = HomeUltraListAdapter(view: view, pictures: nil)
        AppLocalization.use(await TranslationCatalog.load("fr"))
        let tablet = TabletGroupedList(ids: [.botsHeader], rows: [.botsHeader], avatarStyle: .gradient, avatarMonochrome: false, offline: nil)
        adapter.update(.init(model: .empty, width: 320, environment: environment, dark: false, selected: nil, tablet: tablet))
        let snapshot = await view.nextSnapshot()
        XCTAssertEqual(snapshot.first?.plan.accessibilityLabel, expected, "queued work belongs to its screen's captured language")
        adapter.deactivate()
    }
}
#endif
