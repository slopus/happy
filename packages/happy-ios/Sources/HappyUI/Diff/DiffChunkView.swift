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
/// engine's cache); it is immutable.
final class DiffChunkPlan: @unchecked Sendable {
    let source: DiffChunkSource
    let files: [DiffFilePlan]
    let layout: DiffChunkLayout
    /// Files the reader opened with "show more", by index.
    let expanded: Set<Int>
    let syntaxDeadline: ContinuousClock.Instant?

    /// DiffChunk's defaults: line numbers on, 80 rows before "show more",
    /// hunk separators only when a file has more than one hunk. Rows are
    /// syntax-coloured until `syntaxDeadline` (see `DiffFilePlan`); give
    /// the plans of one pass the same deadline, or nil for none.
    init(
        source: DiffChunkSource,
        width: CGFloat,
        showLineNumbers: Bool = true,
        collapseAfter: Int = DiffChunkLayout.collapseAfter,
        fontSize: CGFloat = DiffMetrics.defaultFontSize,
        expanded: Set<Int> = [],
        syntaxDeadline: ContinuousClock.Instant? = DiffFilePlan.syntaxDeadline()
    ) {
        self.source = source
        self.expanded = expanded
        self.syntaxDeadline = syntaxDeadline
        let document = DiffFileItem.document(source.source)
        files = document.files.enumerated().map { index, file in
            let hunks = file.rows.reduce(0) { count, row in
                if case .hunk = row { return count + 1 }
                return count
            }
            let options = DiffViewOptions(fontSize: fontSize, showLineNumbers: showLineNumbers, showHunkHeaders: hunks > 1, collapseAfter: collapseAfter)
            return DiffFilePlan(file: file, width: width, options: options, expanded: expanded.contains(index), syntaxDeadline: syntaxDeadline)
        }
        layout = DiffChunkLayout(files.map(\.layout.input))
    }

    /// Nothing to draw (DiffChunk renders null).
    var isEmpty: Bool { files.isEmpty }

    var size: CGSize { layout.size }

    /// The same diff with file `index` opened in full.
    func expanding(_ index: Int, width: CGFloat) -> DiffChunkPlan {
        let first = files.first?.options
        return DiffChunkPlan(
            source: source,
            width: width,
            showLineNumbers: first?.showLineNumbers ?? true,
            collapseAfter: first?.collapseAfter ?? DiffChunkLayout.collapseAfter,
            fontSize: first?.fontSize ?? DiffMetrics.defaultFontSize,
            expanded: expanded.union([index]),
            syntaxDeadline: syntaxDeadline == nil ? nil : DiffFilePlan.syntaxDeadline()
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
