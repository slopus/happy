#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import UIKit

/// components/diff/DiffChunk.tsx's input: a patch, or the text before and
/// after (a patch wins when there is one).
struct DiffChunkSource: Equatable, Sendable {
    var patch: String?
    var oldText: String?
    var newText: String?
    /// Names the language; "file.txt" when nil.
    var fileName: String?
    var contextLines = 3

    init(patch: String? = nil, oldText: String? = nil, newText: String? = nil, fileName: String? = nil, contextLines: Int = 3) {
        self.patch = patch
        self.oldText = oldText
        self.newText = newText
        self.fileName = fileName
        self.contextLines = contextLines
    }

    var source: DiffFileItem.Source? {
        if let patch, !patch.isEmpty { return .patch(patch) }
        guard oldText != nil || newText != nil else { return nil }
        return .contents(path: fileName ?? "file.txt", oldText: oldText ?? "", newText: newText ?? "", contextLines: contextLines)
    }
}

/// The chat-sized diff, built and measured: each file's plan, stacked.
/// Build it off the main thread (the diff itself is built here, through the
/// account's documents); it is immutable.
final class DiffChunkPlan: @unchecked Sendable {
    let source: DiffChunkSource
    let render: RenderServices
    let files: [DiffFilePlan]
    let layout: DiffChunkLayout
    /// Files the reader opened with "show more", by index.
    let expanded: Set<Int>
    let syntaxDeadline: ContinuousClock.Instant?
    /// The text size it was measured at; nil is the designed size.
    let text: TextEnvironment?

    /// DiffChunk's defaults: line numbers on, 80 rows before "show more",
    /// hunk separators only when a file has more than one hunk. Rows are
    /// syntax-coloured until `syntaxDeadline` (see `DiffFilePlan`); give
    /// the plans of one pass the same deadline, or nil for none. `text` is
    /// the text size the chat draws at (its traits' `textEnvironment`):
    /// the rows' font, line and advance grow with it. Nil, the designed
    /// size. A plan is for one width and one text size; plan again when
    /// either changes.
    init(
        source: DiffChunkSource,
        width: CGFloat,
        render: RenderServices,
        showLineNumbers: Bool = true,
        collapseAfter: Int = DiffChunkLayout.collapseAfter,
        fontSize: CGFloat = DiffMetrics.defaultFontSize,
        expanded: Set<Int> = [],
        syntaxDeadline: ContinuousClock.Instant? = DiffFilePlan.syntaxDeadline(),
        text: TextEnvironment? = nil
    ) {
        self.source = source
        self.text = text
        self.render = render
        self.expanded = expanded
        self.syntaxDeadline = syntaxDeadline
        let document = DiffFileItem.document(source.source, cache: render.diffDocuments)
        files = document.files.enumerated().map { index, file in
            let hunks = file.rows.reduce(0) { count, row in
                if case .hunk = row { return count + 1 }
                return count
            }
            let options = DiffViewOptions(fontSize: fontSize, showLineNumbers: showLineNumbers, showHunkHeaders: hunks > 1, collapseAfter: collapseAfter)
            return DiffFilePlan(file: file, width: width, syntax: render.diffSyntax, options: options, expanded: expanded.contains(index), syntaxDeadline: syntaxDeadline, text: text)
        }
        layout = DiffChunkLayout(files.map(\.layout.input))
    }

    /// Nothing to draw (DiffChunk renders null).
    var isEmpty: Bool { files.isEmpty }

    var size: CGSize { layout.size }

    /// The same diff with file `index` opened in full, at the same text size.
    func expanding(_ index: Int, width: CGFloat) -> DiffChunkPlan {
        let first = files.first?.options
        return DiffChunkPlan(
            source: source,
            width: width,
            render: render,
            showLineNumbers: first?.showLineNumbers ?? true,
            collapseAfter: first?.collapseAfter ?? DiffChunkLayout.collapseAfter,
            fontSize: first?.fontSize ?? DiffMetrics.defaultFontSize,
            expanded: expanded.union([index]),
            syntaxDeadline: syntaxDeadline == nil ? nil : DiffFilePlan.syntaxDeadline(),
            text: text
        )
    }
}

/// components/diff/DiffChunk.tsx: what an agent's edit looks like in the
/// chat. Apply a plan; on "show more", plan again with `expanding(_:)` and
/// re-measure the row.
final class DiffChunkView: UIView {
    /// "Show N more lines" on file `index`.
    var onShowMore: ((Int) -> Void)?

    private(set) var plan: DiffChunkPlan?
    private var fileViews: [DiffFileView] = []

    func apply(_ plan: DiffChunkPlan) {
        guard plan !== self.plan else { return }
        self.plan = plan
        while fileViews.count < plan.files.count {
            let view = DiffFileView()
            let index = fileViews.count
            view.onShowMore = { [weak self] in self?.onShowMore?(index) }
            addSubview(view)
            fileViews.append(view)
        }
        while fileViews.count > plan.files.count {
            fileViews.removeLast().removeFromSuperview()
        }
        for (view, file) in zip(fileViews, plan.files) { view.apply(file) }
        setNeedsLayout()
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        CGSize(width: size.width, height: plan?.size.height ?? 0)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let plan else { return }
        for (view, frame) in zip(fileViews, plan.layout.frames) { view.frame = frame }
    }
}
#endif
