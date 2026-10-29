#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The stem-cell sidebar's story rows as desktop draws them (`sidebar.css`
/// "Story rows"): a 64 card, the 50 disc in its ring, the title and the time,
/// the lines changed and the status in up to two lines, the draft or the
/// empty mark on the last line, and one signal lane. With `HAPPY_PREVIEW_DIR`
/// set, it writes what it drew there as PNGs.
@MainActor
final class StemCellsStoryRowTests: XCTestCase {
    typealias S = StemCellsStoryRowMetrics

    private static func minutesAgo(_ minutes: Double) -> Double {
        (Date().timeIntervalSince1970 - minutes * 60) * 1000
    }

    /// A realistic list: working, unread, a ring, counts, a draft, empty, a long status.
    static func rows() -> [StemCellsRow] {
        func space(_ id: String, _ label: String, _ mark: StemCellsRow.Mark, status: StemCellsRow.Status = .none, unread: Bool = false, line: String?, ago: Double?) -> StemCellsRow {
            var row = StemCellsRow(id: "space:\(id)", nodeId: id, kind: .space, label: label, mark: mark, status: status, unread: unread, agentId: id)
            row.hasAgent = true
            row.statusLine = line
            row.activityTime = ago.map(minutesAgo)
            return row
        }
        var counts = space("ios", "iOS three-line rows", .clay("navigation"), status: .working, line: "Porting desktop's story rows: geometry, the signal lane and the empty mark", ago: 0)
        counts.lineChanges = .init(added: 248, deleted: 37)
        var draft = space("release", "Preview release", .glyph("tasks"), line: "Ready for the morning build", ago: 2 * 60)
        draft.draft = "Ship it after the screenshots land"
        let rows = [
            space("happy", "Happy", .happy, status: .working, line: "Two things running", ago: 1),
            space("stories", "Stories", .clay("testing"), unread: true, line: "Testing with a few friends", ago: 5),
            counts,
            draft,
            StemCellsRow(id: "section:later", nodeId: "later", kind: .section, label: "Later", collapsed: false),
            space("new", "New work", .stemCell(seed: "new"), line: nil, ago: 26 * 60),
            space("bench", "Agent benchmark", .glyph("agents"), unread: true, line: "Compared four models on the sidebar task; Opus held the layout rules best and asked one question about the draft line before shipping", ago: 9 * 24 * 60),
        ]
        return StemCellsRows.withStories(rows, rings: [
            "happy": StoryRing(agentId: "happy", storyIds: ["h1"], unseenCount: 1, latestPostedAt: nil),
            "stories": StoryRing(agentId: "stories", storyIds: ["s1", "s2", "s3", "s4"], unseenCount: 2, latestPostedAt: nil),
            "ios": StoryRing(agentId: "ios", storyIds: ["i1", "i2"], unseenCount: 0, latestPostedAt: nil),
        ])
    }

    private func sidebar(_ rows: [StemCellsRow] = rows(), style: UIUserInterfaceStyle = .light, height: CGFloat = 520) -> StemCellsSidebarView {
        let sidebar = StemCellsSidebarView(frame: CGRect(x: 0, y: 0, width: 402, height: height))
        sidebar.overrideUserInterfaceStyle = style
        sidebar.backgroundColor = UIColor(Palette.surface)
        sidebar.apply(rows)
        sidebar.layoutIfNeeded()
        return sidebar
    }

    private func rowView(_ sidebar: StemCellsSidebarView, _ id: String) -> StemCellsRowView? {
        sidebar.subviews.compactMap { $0 as? StemCellsRowView }.first { $0.row?.id == id }
    }

    private func frame(_ sidebar: StemCellsSidebarView, _ id: String) throws -> StemCellsSidebarLayout.Frame {
        let index = try XCTUnwrap(sidebar.rows.firstIndex { $0.id == id })
        return try XCTUnwrap(sidebar.layoutResult?.frames[index])
    }

    private func parts<T: UIView>(_ view: UIView, _ type: T.Type) -> [T] { view.subviews.compactMap { $0 as? T } }
    private func status(_ view: StemCellsRowView) -> StemCellsTopLabel { parts(view, StemCellsTopLabel.self)[0] }
    private func time(_ view: StemCellsRowView) -> UILabel { parts(view, UILabel.self).first { $0.textAlignment == .right && !($0 is StemCellsTopLabel) }! }
    private func draft(_ view: StemCellsRowView) -> UILabel { parts(view, UILabel.self).first { $0.textAlignment != .right && !($0 is StemCellsTopLabel) }! }
    private func corner(_ view: StemCellsRowView) -> StemCellsCornerView { parts(view, StemCellsCornerView.self)[0] }
    private func empty(_ view: StemCellsRowView) -> StemCellsEmptyMarkView { parts(view, StemCellsEmptyMarkView.self)[0] }

    /// Two colours as drawn in the light theme.
    private func assertSameColor(_ a: UIColor?, _ b: UIColor, file: StaticString = #filePath, line: UInt = #line) {
        let light = UITraitCollection(userInterfaceStyle: .light)
        XCTAssertEqual(a?.resolvedColor(with: light).cgColor, b.resolvedColor(with: light).cgColor, file: file, line: line)
    }

    private func keep(_ view: UIView, _ name: String) {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 3
        let image = UIGraphicsImageRenderer(bounds: view.bounds, format: format).image { context in
            view.traitCollection.performAsCurrent { view.layer.render(in: context.cgContext) }
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
            try? image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
        }
    }

    func testTheCardTheDiscAndTheTextStandWhereDesktopsDo() throws {
        let sidebar = sidebar()
        let ids = sidebar.rows.filter { $0.story != nil }.map(\.id)
        XCTAssertEqual(ids.count, 6, "no nesting, no folds")
        for id in ids {
            let frame = try frame(sidebar, id)
            let view = try XCTUnwrap(rowView(sidebar, id))
            // The card 3 in from the list, 64 tall, its corners 14 where filled.
            XCTAssertEqual(view.frame, CGRect(x: 3, y: frame.box.minY, width: 396, height: 64), id)
            // The disc 7 into it, centred; the ring box around it; the text 10 past it.
            XCTAssertEqual(frame.mark?.minX, 10, id)
            XCTAssertEqual(frame.mark?.size, CGSize(width: 50, height: 50), id)
            XCTAssertEqual(frame.mark!.midY, frame.box.midY, accuracy: 1.0 / 3, id)
            XCTAssertEqual(view.ringView?.frame.size, CGSize(width: 58, height: 58), id)
            XCTAssertEqual(frame.label.minX, 70, id)
            XCTAssertEqual(status(view).frame.minX + view.frame.minX, 70, id)
            // What the row draws is what the list laid out.
            XCTAssertEqual(status(view).frame, frame.subtitle!.offsetBy(dx: -frame.box.minX, dy: -frame.box.minY), id)
            // The status ends 31.9 inside the card, whatever the lane holds.
            XCTAssertEqual(status(view).frame.maxX, 396 - 31.9, accuracy: 1e-6, id)
            // The time's ink ends 11.9 inside the card, its cap top on the title's.
            let clock = time(view)
            XCTAssertFalse(clock.isHidden, id)
            XCTAssertEqual(clock.frame.maxX - S.timeBearing, 396 - 11.9, accuracy: 1e-6, id)
            let timeCap = clock.frame.minY + clock.font.ascender - clock.font.capHeight
            let titleFont = StemCellsStoryRowText.titleFont(1)
            let titleCap = frame.label.minY - frame.box.minY + titleFont.ascender - titleFont.capHeight
            XCTAssertEqual(timeCap, titleCap, accuracy: 1e-6, id)
        }
        // The title's baseline 19.5 into the card, as measured from the font.
        let happy = try frame(sidebar, "space:happy")
        XCTAssertEqual(happy.label.minY - happy.box.minY + StemCellsStoryRowText.titleFont(1).ascender, 19.5, accuracy: 1e-6)
        // Cards 70.5 apart.
        XCTAssertEqual(try frame(sidebar, "space:stories").box.minY - happy.box.minY, 70.5)
    }

    func testTheSignalLaneIsOneWidthForTheSpinnerTheDotAndNothing() throws {
        let sidebar = sidebar()
        let working = try frame(sidebar, "space:happy")
        let unread = try frame(sidebar, "space:stories")
        let quiet = try frame(sidebar, "space:release")
        let lanes = [working, unread, quiet].map { $0.signalLane!.offsetBy(dx: 0, dy: -$0.box.minY) }
        XCTAssertEqual(Set(lanes.map(\.width)), [14])
        for lane in lanes {
            XCTAssertEqual(lane.minX, lanes[0].minX, accuracy: 1e-9)
            XCTAssertEqual(lane.minY, lanes[0].minY, accuracy: 1e-9)
        }
        XCTAssertEqual(working.subtitle!.maxX, quiet.subtitle!.maxX)
        XCTAssertEqual(unread.subtitle!.maxX, quiet.subtitle!.maxX)
        // The spinner and the dot end on the lane's right and the last baseline.
        let spinner = corner(try XCTUnwrap(rowView(sidebar, "space:happy")))
        XCTAssertEqual(spinner.corner, .braille)
        XCTAssertFalse(spinner.isHidden)
        XCTAssertEqual(spinner.frame.size, S.braille)
        let dot = corner(try XCTUnwrap(rowView(sidebar, "space:stories")))
        XCTAssertEqual(dot.corner, .dot)
        XCTAssertEqual(dot.frame.size, CGSize(width: 10, height: 10))
        assertSameColor(dot.backgroundColor, UIColor(Palette.stemCellsUnreadDot))
        for (view, card) in [(spinner, working), (dot, unread)] {
            XCTAssertEqual(view.frame.maxX, 396 - 11.9, accuracy: 1.0 / 6)
            XCTAssertEqual(view.frame.maxY, 64 - 11.9, accuracy: 1.0 / 6)
            XCTAssertNotNil(card.corner)
        }
        XCTAssertTrue(corner(try XCTUnwrap(rowView(sidebar, "space:release"))).isHidden)
        // Unread and working: the spinner alone.
        var both = Self.rows()[0]
        both.unread = true
        XCTAssertEqual(both.corner, .braille)
    }

    func testAHeadingAmongStoryRowsIsDesktopsOwnSize() throws {
        let sidebar = sidebar()
        let frame = try frame(sidebar, "section:later")
        let view = try XCTUnwrap(rowView(sidebar, "section:later"))
        XCTAssertEqual(view.frame, CGRect(x: 6, y: frame.box.minY, width: 390, height: 22))
        // 11 bold mono, as desktop's, on the discs' left edge.
        let title = try XCTUnwrap(parts(view, StemCellsShimmerLabel.self).first?.attributedText)
        let font = try XCTUnwrap(title.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)
        XCTAssertEqual(font.pointSize, 11)
        XCTAssertEqual(frame.label.minX, try self.frame(sidebar, "space:new").mark!.minX)
        // The fold's 12 glyph 22 in from the list's right edge, the "+" 22 before it.
        let glyphs = parts(view, UIImageView.self).filter { !$0.isHidden && $0.image != nil && $0.frame.width == 12 }
        XCTAssertEqual(glyphs.count, 1, "the chevron")
        XCTAssertEqual(frame.chevron!.midX, 402 - 22)
        XCTAssertEqual(frame.add!.midX, 402 - 44)
        XCTAssertEqual(parts(view, UIImageView.self).compactMap(\.image?.size.width).filter { $0 == 12 }.count, 2, "the fold and the +")
        // A finger gets the gaps around it too.
        XCTAssertTrue(view.point(inside: CGPoint(x: 100, y: -5), with: nil))
        XCTAssertTrue(view.point(inside: CGPoint(x: 100, y: 27), with: nil))
        XCTAssertFalse(view.point(inside: CGPoint(x: 100, y: -7), with: nil))
    }

    func testALongStatusIsCutAtTwoLines() throws {
        let sidebar = sidebar()
        let view = try XCTUnwrap(rowView(sidebar, "space:bench"))
        let label = status(view)
        XCTAssertEqual(label.numberOfLines, 2)
        XCTAssertEqual(label.lineBreakMode, .byTruncatingTail)
        XCTAssertEqual(label.frame.height, 32)
        // The whole of it would take more than two lines at this width.
        let unclamped = NSMutableAttributedString(attributedString: label.attributedText!)
        let wrapping = NSMutableParagraphStyle()
        wrapping.minimumLineHeight = 16
        wrapping.maximumLineHeight = 16
        unclamped.addAttribute(.paragraphStyle, value: wrapping, range: NSRange(location: 0, length: unclamped.length))
        let whole = unclamped.boundingRect(with: CGSize(width: label.bounds.width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin], context: nil)
        XCTAssertGreaterThan(whole.height, 33)
        XCTAssertLessThanOrEqual(label.textRect(forBounds: label.bounds, limitedToNumberOfLines: 2).height, 32.01)
        // A short status keeps to its first line, at the top.
        let short = status(try XCTUnwrap(rowView(sidebar, "space:stories")))
        XCTAssertEqual(short.textRect(forBounds: short.bounds, limitedToNumberOfLines: 2).height, 16, accuracy: 0.01)
    }

    func testSelectingOrPressingARowMovesNothing() throws {
        let sidebar = sidebar()
        func snapshot() -> [String: [CGRect]] {
            Dictionary(uniqueKeysWithValues: sidebar.subviews.compactMap { $0 as? StemCellsRowView }.compactMap { view in
                view.row.map { ($0.id, [view.frame] + view.subviews.map(\.frame)) }
            })
        }
        let before = snapshot()
        let layout = sidebar.layoutResult
        for id in ["space:stories", "space:ios", "space:new"] {
            sidebar.selectedRowId = id
            sidebar.layoutIfNeeded()
            XCTAssertEqual(snapshot(), before, id)
            XCTAssertEqual(sidebar.layoutResult, layout, id)
            let view = try XCTUnwrap(rowView(sidebar, id))
            XCTAssertTrue(view.selected)
            view.pressed = true
            view.layoutIfNeeded()
            XCTAssertEqual(snapshot(), before, id)
            view.pressed = false
        }
        sidebar.selectedRowId = nil
        XCTAssertEqual(snapshot(), before)
        // The filled card is rounded 14 and the title keeps one weight.
        sidebar.selectedRowId = "space:stories"
        let view = try XCTUnwrap(rowView(sidebar, "space:stories"))
        XCTAssertEqual(view.subviews[0].layer.cornerRadius, 14)
        XCTAssertNotEqual(view.subviews[0].backgroundColor, .clear)
    }

    func testAnEmptyRowShowsThePixelDinosaurOnItsLastLine() throws {
        let sidebar = sidebar()
        let view = try XCTUnwrap(rowView(sidebar, "space:new"))
        let frame = try frame(sidebar, "space:new")
        let mark = empty(view)
        XCTAssertFalse(mark.isHidden)
        XCTAssertEqual(mark.frame, frame.empty!.offsetBy(dx: -frame.box.minX, dy: -frame.box.minY))
        XCTAssertEqual(mark.frame.minX + view.frame.minX, 70)
        // As tall as "Ag" and on whole pixels: 14 × 31 at 3x.
        XCTAssertEqual(mark.frame.size, CGSize(width: 31, height: 14))
        let scale = sidebar.traitCollection.displayScale
        for value in [mark.frame.minX + view.frame.minX, mark.frame.minY + view.frame.minY, mark.frame.width, mark.frame.height] {
            XCTAssertEqual((value * scale).rounded(), value * scale, accuracy: 1e-6)
        }
        // Every pixel is a cell or nothing: ink is fully on or off.
        let image = StemCellsEmptyMarkView.image(size: CGSize(width: 31, height: 14), scale: 3).cgImage!
        XCTAssertEqual([image.width, image.height], [93, 42])
        var alpha = [UInt8](repeating: 0, count: 93 * 42)
        let context = CGContext(data: &alpha, width: 93, height: 42, bitsPerComponent: 8, bytesPerRow: 93, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.alphaOnly.rawValue)!
        context.draw(image, in: CGRect(x: 0, y: 0, width: 93, height: 42))
        XCTAssertTrue(alpha.allSatisfy { $0 == 0 || $0 == 255 })
        XCTAssertGreaterThan(alpha.filter { $0 == 255 }.count, 600)
        // The ground runs the full width on the last pixel row.
        XCTAssertTrue(alpha[(41 * 93)..<(42 * 93)].allSatisfy { $0 == 255 })
        // The status keeps one line; nothing else on the last line.
        XCTAssertEqual(status(view).numberOfLines, 1)
        XCTAssertTrue(draft(view).isHidden)
        // A row that says something has no dinosaur.
        XCTAssertTrue(empty(try XCTUnwrap(rowView(sidebar, "space:stories"))).isHidden)
    }

    func testADraftTakesTheLastLine() throws {
        let sidebar = sidebar()
        let view = try XCTUnwrap(rowView(sidebar, "space:release"))
        let frame = try frame(sidebar, "space:release")
        let line = draft(view)
        XCTAssertFalse(line.isHidden)
        XCTAssertEqual(line.attributedText?.string, "Draft: Ship it after the screenshots land")
        XCTAssertEqual(line.numberOfLines, 1)
        XCTAssertEqual(line.frame, frame.draft!.offsetBy(dx: -frame.box.minX, dy: -frame.box.minY))
        XCTAssertEqual(line.frame.maxX, status(view).frame.maxX)
        XCTAssertEqual((line.attributedText?.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)?.fontName, "Figtree-Medium")
        XCTAssertEqual(status(view).numberOfLines, 1)
        XCTAssertEqual(status(view).attributedText?.string, "Ready for the morning build")
        XCTAssertTrue(empty(view).isHidden)
        XCTAssertTrue(view.accessibilityValue?.contains("Draft: Ship it") == true)
    }

    func testLineCountsLeadTheStatusInItsFontWithTabularFigures() throws {
        let sidebar = sidebar()
        let view = try XCTUnwrap(rowView(sidebar, "space:ios"))
        let text = try XCTUnwrap(status(view).attributedText)
        XCTAssertTrue(text.string.hasPrefix("+248\u{2212}37Porting desktop"))
        let added = text.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? UIColor
        let deleted = text.attribute(.foregroundColor, at: 4, effectiveRange: nil) as? UIColor
        let rest = text.attribute(.foregroundColor, at: 7, effectiveRange: nil) as? UIColor
        assertSameColor(added, UIColor(Palette.stemCellsLinesAdded))
        assertSameColor(deleted, UIColor(Palette.stemCellsLinesDeleted))
        assertSameColor(rest, UIColor(Palette.stemCellsRowText))
        // 4 after each mark.
        XCTAssertEqual(text.attribute(.kern, at: 3, effectiveRange: nil) as? CGFloat, 4)
        XCTAssertEqual(text.attribute(.kern, at: 6, effectiveRange: nil) as? CGFloat, 4)
        // The status's face and size, with even figures.
        let font = try XCTUnwrap(text.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)
        XCTAssertEqual(font.pointSize, 14)
        XCTAssertEqual(font.familyName, StemCellsStoryRowText.statusFont(1).familyName)
        let features = font.fontDescriptor.object(forKey: .featureSettings) as? [[UIFontDescriptor.FeatureKey: Int]]
        XCTAssertEqual(features?.first?[.type], kNumberSpacingType)
        XCTAssertEqual(StemCellsStoryRowText.compactCount(842), "842")
        XCTAssertEqual(StemCellsStoryRowText.compactCount(1200), "1.2k")
        XCTAssertEqual(StemCellsStoryRowText.compactCount(4038), "4k")
        XCTAssertEqual(StemCellsStoryRowText.compactCount(12800), "13k")
        // Counts alone are something to say: no dinosaur.
        var counted = StemCellsRow(id: "c", nodeId: "c", kind: .space, label: "C")
        counted.lineChanges = .init(added: 3, deleted: 0)
        XCTAssertEqual(StemCellsStoryRowText.lastLine(counted), .status)
        XCTAssertEqual(StemCellsStoryRowText.status(counted, scale: 1).string, "+3")
    }

    func testATimeReadsAsDesktopsAndATapOnTheRingOpensStories() throws {
        let sidebar = sidebar()
        XCTAssertEqual(time(try XCTUnwrap(rowView(sidebar, "space:ios"))).text, "now")
        XCTAssertEqual(time(try XCTUnwrap(rowView(sidebar, "space:stories"))).text, "5m")
        XCTAssertEqual(time(try XCTUnwrap(rowView(sidebar, "space:release"))).text, "2h")
        var opened: [String] = []
        var selected: [String] = []
        sidebar.onOpenStory = { row, _ in opened.append(row.id) }
        sidebar.onSelect = { row in selected.append(row.id) }
        let view = try XCTUnwrap(rowView(sidebar, "space:stories"))
        let frame = try frame(sidebar, "space:stories")
        sidebar.tap(view, at: CGPoint(x: frame.ring!.midX, y: frame.ring!.midY))
        sidebar.tap(view, at: CGPoint(x: frame.label.midX, y: frame.label.midY))
        XCTAssertEqual(opened, ["space:stories"])
        XCTAssertEqual(selected, ["space:stories"])
    }

    func testALargerTextSizeScalesTheFontsAndKeepsTheCard() throws {
        let sidebar = sidebar()
        let window = UIWindow(frame: sidebar.frame)
        window.addSubview(sidebar)
        window.isHidden = false
        defer { window.isHidden = true }
        sidebar.traitOverrides.preferredContentSizeCategory = .accessibilityLarge
        sidebar.setNeedsLayout()
        sidebar.layoutIfNeeded()
        let multiplier = TextScale(.accessibilityLarge).multiplier
        let frame = try frame(sidebar, "space:bench")
        XCTAssertEqual(frame.box.height, StemCellsSidebarLayout.storyHeight(multiplier), accuracy: 1e-6)
        XCTAssertEqual(frame.mark?.size, CGSize(width: 50, height: 50))
        XCTAssertEqual(frame.label.minX, 70)
        let view = try XCTUnwrap(rowView(sidebar, "space:bench"))
        let font = try XCTUnwrap(status(view).attributedText?.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)
        XCTAssertEqual(font.pointSize, 14 * multiplier, accuracy: 0.01)
        XCTAssertEqual(status(view).frame.height, 32 * multiplier, accuracy: 1e-6)
        XCTAssertEqual(time(view).font.pointSize, 12.5 * multiplier, accuracy: 0.01)
        XCTAssertLessThanOrEqual(status(view).textRect(forBounds: status(view).bounds, limitedToNumberOfLines: 2).height, status(view).frame.height + 1.0 / 3, "within a pixel")
        keep(sidebar, "story-rows-ax-large")
        // Back at the default, as designed.
        sidebar.traitOverrides.preferredContentSizeCategory = .large
        sidebar.setNeedsLayout()
        sidebar.layoutIfNeeded()
        XCTAssertEqual(try self.frame(sidebar, "space:bench").box.height, 64)
    }

    func testScreenshotsInBothThemes() throws {
        for style: UIUserInterfaceStyle in [.light, .dark] {
            let sidebar = sidebar(style: style, height: 500)
            let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow()
            window.frame = sidebar.frame
            window.overrideUserInterfaceStyle = style
            window.addSubview(sidebar)
            window.isHidden = false
            defer { window.isHidden = true }
            sidebar.selectedRowId = "space:ios"
            sidebar.setNeedsLayout()
            sidebar.layoutIfNeeded()
            XCTAssertEqual(sidebar.traitCollection.userInterfaceStyle, style)
            XCTAssertEqual(rowView(sidebar, "space:ios")?.traitCollection.userInterfaceStyle, style)
            XCTAssertEqual(sidebar.contentSize.height, try frame(sidebar, "space:bench").box.maxY + StemCellsMetrics.contentBottom)
            keep(sidebar, style == .light ? "story-rows-light" : "story-rows-dark")
        }
    }
}
#endif
