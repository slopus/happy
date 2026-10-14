import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// The home list's headings and notices, sized from their layouts with the
/// text's line heights in place of labels.
final class HomeRowKindHeightTests: XCTestCase {
    private let widths: [CGFloat] = [0, 120, 393, 1024]
    /// The styles' lines, the desktop glyph at 12 on a 3x screen
    /// ((454 + 71) / 512 × 12, up to a third), a 3x hairline.
    private let metrics = HomeRowMetrics(
        dayHeaderLine: TextStyles.sessionDayHeader.lineHeight!,
        archiveToggleLine: TextStyles.archiveToggle.lineHeight!,
        machineLine: TextStyles.projectMachine.lineHeight!,
        sectionLine: TextStyles.projectSection.lineHeight!,
        machineIcon: CGSize(width: 12, height: 37.0 / 3),
        hairline: 1.0 / 3
    )

    private func height(_ kind: HomeRowKind, width: CGFloat = 393, metrics: HomeRowMetrics? = nil) -> CGFloat {
        HomeRowHeights.height(kind, width: width, metrics: metrics ?? self.metrics)
    }

    func testTheStylesAreOneFixedLine() {
        XCTAssertEqual(metrics.dayHeaderLine, 18)
        XCTAssertEqual(metrics.archiveToggleLine, 18)
        XCTAssertEqual(metrics.machineLine, 14)
        XCTAssertEqual(metrics.sectionLine, 14)
    }

    func testHeadings() {
        // 20 above, a line, 8 below.
        XCTAssertEqual(height(.dayHeader(label: "Today")), 46)
        // Banded: 24 and 8; dividing the page: 20 and 12.
        XCTAssertEqual(height(.archiveToggle(label: "Show archived", banded: true)), 50)
        XCTAssertEqual(height(.archiveToggle(label: "Show archived", banded: false)), 50)
        // 14 above, the name's line over the glyph, 2 below.
        XCTAssertEqual(height(.machineHeader(name: "MacBook Pro")), 30, accuracy: 0.0001)
        // 18 above, a line, 6 below.
        XCTAssertEqual(height(.section(label: "Projects")), 38)
    }

    func testAnEmptyLabelHasNoLine() {
        XCTAssertEqual(height(.dayHeader(label: "")), 28)
        XCTAssertEqual(height(.archiveToggle(label: "", banded: true)), 32)
        XCTAssertEqual(height(.archiveToggle(label: "", banded: false)), 32)
        // Only the glyph is left to hold the row open.
        XCTAssertEqual(height(.machineHeader(name: "")), 14 + 37.0 / 3 + 2, accuracy: 0.0001)
        XCTAssertEqual(height(.section(label: "")), 24)
    }

    func testAFlatSessionIsItsLines() {
        for width in widths {
            for workspace in [false, true] {
                for changes in [false, true] {
                    XCTAssertEqual(height(.flatSession(workspace: workspace, changes: changes), width: width), HomeRowHeights.flatSession(width: width))
                }
            }
        }
        XCTAssertEqual(height(.flatSession(workspace: true, changes: false)), 81)
        var larger = metrics
        larger.sessionLines = .init(title: 79, project: 71.5, workspace: 64.5, changes: 51.5)
        XCTAssertEqual(height(.flatSession(workspace: true, changes: false), metrics: larger), 236)
        XCTAssertEqual(height(.flatSession(workspace: false, changes: false), metrics: larger), 189.5)
        // The counts' line under a taller workspace changes nothing; alone
        // it is the row's third line.
        XCTAssertEqual(height(.flatSession(workspace: true, changes: true), metrics: larger), 236)
        XCTAssertEqual(height(.flatSession(workspace: false, changes: true), metrics: larger), 223)
        larger.branchIcon = CGSize(width: 13, height: 70)
        XCTAssertEqual(height(.flatSession(workspace: true, changes: false), metrics: larger), 241.5)
    }

    /// The kind's height is the row's own, with any words in it, at any
    /// lines and width.
    func testAFlatSessionsHeightIsItsLayouts() {
        let lineSets: [FlatSessionRowLayout.Lines] = [
            .designed,
            .init(title: 18.5, project: 16.5, workspace: 15, changes: 12),
            .init(title: 22, project: 19, workspace: 18, changes: 14.5),
            .init(title: 29.5, project: 27, workspace: 24.5, changes: 19),
            .init(title: 79, project: 71.5, workspace: 64.5, changes: 51.5),
            // Counts whose line passes the workspace's.
            .init(title: 22, project: 20, workspace: 18, changes: 30),
        ]
        for lines in lineSets {
            var scaled = metrics
            scaled.sessionLines = lines
            for width in widths {
                for workspace in [false, true] {
                    for changes in [false, true] {
                        let layout = FlatSessionRowLayout(.init(
                            width: width,
                            title: text("A long title that never wraps on its one line", lineHeight: lines.title, maxLines: 1),
                            timestamp: text("12:55 PM", lineHeight: lines.title, maxLines: 1),
                            project: text("happy", lineHeight: lines.project, maxLines: 1),
                            workspace: workspace ? text("fix-login", lineHeight: lines.workspace, maxLines: 1) : nil,
                            branchIcon: scaled.branchIcon,
                            changes: changes ? CGSize(width: 64, height: lines.changes) : nil,
                            showsDivider: true,
                            lines: lines
                        ))
                        XCTAssertEqual(
                            height(.flatSession(workspace: workspace, changes: changes), width: width, metrics: scaled),
                            layout.size.height,
                            "\(lines) at \(width)"
                        )
                    }
                }
            }
        }
    }

    func testTheContentRowsAreApplysOwnHeights() {
        for width in widths {
            XCTAssertEqual(height(.projectCard, width: width), HomeRowHeights.projectCard(width: width))
            XCTAssertEqual(height(.worktree, width: width), HomeRowHeights.worktree(width: width))
            XCTAssertEqual(height(.chat, width: width), HomeRowHeights.projectChat(width: width))
        }
        XCTAssertEqual(height(.projectCard), 60)
        XCTAssertEqual(height(.worktree), 48)
        XCTAssertEqual(height(.chat), 48)
    }

    func testNoHeightDependsOnWidthOrText() {
        let kinds: [HomeRowKind] = [
            .dayHeader(label: "3 days ago"),
            .archiveToggle(label: "Hide archived", banded: true),
            .archiveToggle(label: "Hide archived", banded: false),
            .machineHeader(name: String(repeating: "Long name ", count: 20)),
            .section(label: "Bots"),
        ]
        for kind in kinds {
            for width in widths {
                XCTAssertEqual(height(kind, width: width), height(kind), "\(kind) at \(width)")
            }
        }
        XCTAssertEqual(height(.dayHeader(label: "Today")), height(.dayHeader(label: String(repeating: "x", count: 200))))
    }

    /// A bigger font or another screen moves the heights: nothing here is
    /// fixed to today's styles.
    func testTheMetricsAreWhatTheHeightsAreMadeOf() {
        var larger = metrics
        larger.dayHeaderLine = 24
        larger.archiveToggleLine = 22
        larger.machineLine = 20
        larger.sectionLine = 17
        XCTAssertEqual(height(.dayHeader(label: "Today"), metrics: larger), 52)
        XCTAssertEqual(height(.archiveToggle(label: "Show", banded: true), metrics: larger), 54)
        XCTAssertEqual(height(.archiveToggle(label: "Show", banded: false), metrics: larger), 54)
        XCTAssertEqual(height(.machineHeader(name: "Mac"), metrics: larger), 36)
        XCTAssertEqual(height(.section(label: "Bots"), metrics: larger), 41)

        var tallGlyph = metrics
        tallGlyph.machineIcon = CGSize(width: 30, height: 30)
        XCTAssertEqual(height(.machineHeader(name: "Mac"), metrics: tallGlyph), 46)
    }

    // MARK: Notices

    private let chevron = CGSize(width: 10, height: 18)

    private func banner(_ title: String, _ subtitle: String) -> HomeBannerHeights.Banner {
        HomeBannerHeights.Banner(
            title: .fixed(width: 0, height: title.isEmpty ? 0 : 22),
            subtitle: text(subtitle, lineHeight: 20, maxLines: 2)
        )
    }

    func testAOneLineNotice() {
        // 4 above, an 11 + 22 + 2 + 20 + 11 row, 16 below.
        XCTAssertEqual(HomeBannerHeights.banner(banner("Offline", "Troubleshoot"), width: 393, maxWidth: nil, chevron: chevron), 86)
    }

    func testASubtitleWrapsToTwoLinesAtMost() {
        // The text lane on a 393 phone: 361 of card, less 57 ahead, 16 + 8
        // after and the 4 + 10 chevron, is 266; 39 characters take 312.
        let whatsNew = banner("What's new", "See the latest updates and improvements")
        XCTAssertEqual(HomeBannerHeights.banner(whatsNew, width: 393, maxWidth: nil, chevron: chevron), 106)
        XCTAssertEqual(HomeBannerHeights.banner(whatsNew, width: 1024, maxWidth: nil, chevron: chevron), 86)
        let long = banner("Offline", String(repeating: "word ", count: 80))
        XCTAssertEqual(HomeBannerHeights.banner(long, width: 393, maxWidth: nil, chevron: chevron), 106, "two lines, then cut")
    }

    func testTheGroupKeepsToTheContentWidth() {
        let whatsNew = banner("What's new", "See the latest updates and improvements")
        XCTAssertEqual(HomeBannerHeights.banner(whatsNew, width: 1024, maxWidth: 320, chevron: chevron), 106)
    }

    func testAnEmptyTitleLeavesTheIconToHoldTheRow() {
        // 2 + 20 of text, under the 29 icon: 29 + 22.
        XCTAssertEqual(HomeBannerHeights.banner(banner("", "Troubleshoot"), width: 393, maxWidth: nil, chevron: chevron), 4 + 51 + 16)
    }

    func testTheNoticesStack() {
        XCTAssertEqual(HomeBannerHeights.header([], width: 393, maxWidth: nil, chevron: chevron), 0)
        let notices = [banner("Offline", "Troubleshoot"), banner("What's new", "See the latest updates and improvements")]
        XCTAssertEqual(HomeBannerHeights.header(notices, width: 393, maxWidth: nil, chevron: chevron), 86 + 106)
    }

    func testTheGroupPaddingIsTheHeaderViews() {
        XCTAssertEqual(HomeBannerHeights.Metrics.groupPaddingTop, 4)
        XCTAssertEqual(HomeBannerHeights.Metrics.groupPaddingBottom, 16)
    }
}
