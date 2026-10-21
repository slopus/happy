#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// GitChangesView's three semantic slots, measured without a view. A missing
/// approximate or positive count never changes which frame a negative count uses.
struct HomeGitDrawing: Sendable {
    struct Part: Sendable {
        let text: String
        let style: TextStyle
        let color: ColorToken
        let size: CGSize
    }
    let approximate: Part?
    let added: Part?
    let removed: Part?
    let layout: GitChangesLayout
    var spoken: String { [approximate, added, removed].compactMap { $0?.text }.joined(separator: " ") }

    nonisolated init(_ changes: GitLineChanges?, flat: Bool, environment: HomeTextEnvironment) {
        func part(_ value: String, style: TextStyle, color: ColorToken) -> Part {
            Part(text: value, style: style, color: color, size: HomeRowMeasurer.measure(value, style: style, in: environment.text, width: .greatestFiniteMagnitude, maxLines: 1))
        }
        let count = flat ? TextStyles.sessionLineChanges : TextStyles.gitLineCount
        approximate = changes?.approximate == true ? part("≈", style: flat ? TextStyles.sessionLineChanges : TextStyles.gitApproximate, color: Palette.textSecondary) : nil
        added = changes.flatMap { $0.insertions > 0 ? part("+" + GitLineChanges.compact($0.insertions), style: count, color: Palette.gitAddedText) : nil }
        removed = changes.flatMap { $0.deletions > 0 ? part("-" + GitLineChanges.compact($0.deletions), style: count, color: Palette.gitRemovedText) : nil }
        layout = GitChangesLayout(approximate: approximate?.size, added: added?.size, removed: removed?.size)
    }

    nonisolated func append(to plan: inout HomeRowDrawing, at frame: CGRect) {
        for (part, local) in [(approximate, layout.approximate), (added, layout.added), (removed, layout.removed)] {
            guard let part, let local else { continue }
            plan.marks.append(.text(part.text, part.style, part.color, local.offsetBy(dx: frame.minX, dy: frame.minY)))
        }
    }
}
#endif
