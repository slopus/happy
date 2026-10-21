import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// The home list sizes these rows without measuring their text; any
/// content, at any width, must give the same height.
final class HomeRowHeightTests: XCTestCase {
    private let widths: [CGFloat] = [0, 120, 393, 1024]
    private let contents: [Measurable] = [
        .fixed(.zero),
        text("A long title that wraps if it is allowed to", lineHeight: 22),
        text("x", lineHeight: 40, maxLines: 1),
        block(height: 300),
    ]

    func testFlatSessionRow() {
        for width in widths {
            XCTAssertEqual(HomeRowHeights.flatSession(width: width), 81)
            for content in contents {
                for workspace in [nil, content] {
                    for divider in [false, true] {
                        let layout = FlatSessionRowLayout(.init(
                            width: width, title: content, timestamp: content, project: content,
                            workspace: workspace, showsDivider: divider
                        ))
                        XCTAssertEqual(layout.size.height, HomeRowHeights.flatSession(width: width))
                    }
                }
            }
        }
    }

    func testProjectCard() {
        for width in widths {
            for content in contents {
                for flag in [false, true] {
                    let layout = ProjectCardLayout(.init(
                        width: width, hairline: 1 / 3, name: content, showsDot: flag,
                        changes: flag ? content : nil, showsAdd: flag, showsTree: flag
                    ))
                    XCTAssertEqual(layout.size.height, HomeRowHeights.projectCard(width: width))
                }
            }
        }
    }

    func testWorktreeRow() {
        for width in widths {
            for content in contents {
                for flag in [false, true] {
                    let layout = WorktreeRowLayout(.init(
                        width: width, hairline: 1 / 3, label: content, chevron: flag ? CGSize(width: 12, height: 30) : nil,
                        showsDot: flag, changes: flag ? content : nil, last: flag
                    ))
                    XCTAssertEqual(layout.size.height, HomeRowHeights.worktree(width: width))
                }
            }
        }
    }

    func testProjectChatRow() {
        for width in widths {
            for content in contents {
                XCTAssertEqual(ProjectChatRowLayout(width: width, name: content, corner: content).size.height, HomeRowHeights.projectChat(width: width))
            }
        }
    }
}
