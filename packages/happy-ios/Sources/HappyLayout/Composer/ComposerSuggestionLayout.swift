import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A row of the suggestion list (AgentInputSuggestionView.tsx): 48pt,
/// 16 in from the sides, everything centred down the row.
///
/// A command is `/name` in semibold, then 12, then its description taking
/// what is left on one line. A file is a 32pt round icon, 12, its path on
/// one line taking what is left, 8, then FILE or FOLDER.
public struct ComposerSuggestionRowLayout: Equatable, Sendable {
    public enum Metrics {
        public static let height: CGFloat = 48
        public static let paddingH: CGFloat = 16
        public static let commandGap: CGFloat = 12
        public static let iconSize: CGFloat = 32
        public static let iconGlyphSize: CGFloat = 18
        public static let iconGap: CGFloat = 12
        public static let labelGap: CGFloat = 8
    }

    public enum Input: Equatable, Sendable {
        /// The single-line sizes of `/name` and the description.
        case command(name: CGSize, description: CGSize?)
        /// The single-line sizes of the path and the label.
        case file(path: CGSize, label: CGSize)
    }

    public var size: CGSize
    public var name: CGRect?
    public var description: CGRect?
    public var icon: CGRect?
    public var iconGlyph: CGRect?
    public var path: CGRect?
    public var label: CGRect?

    public init(width: CGFloat, input: Input) {
        typealias M = Metrics
        let width = max(0, width)
        size = CGSize(width: width, height: M.height)
        let left = M.paddingH
        let right = max(left, width - M.paddingH)
        func centred(_ x: CGFloat, _ width: CGFloat, _ height: CGFloat) -> CGRect {
            CGRect(x: x, y: (M.height - height) / 2, width: max(0, width), height: height)
        }
        switch input {
        case .command(let name, let description):
            // The name keeps its width (flexShrink 0), up to the row.
            let nameWidth = min(name.width, right - left)
            self.name = centred(left, nameWidth, name.height)
            if let description {
                let x = left + nameWidth + M.commandGap
                self.description = centred(x, min(description.width, max(0, right - x)), description.height)
            }
        case .file(let path, let label):
            let icon = centred(left, M.iconSize, M.iconSize)
            self.icon = icon
            iconGlyph = CGRect(
                x: icon.midX - M.iconGlyphSize / 2,
                y: icon.midY - M.iconGlyphSize / 2,
                width: M.iconGlyphSize,
                height: M.iconGlyphSize
            )
            let labelWidth = min(label.width, max(0, right - icon.maxX - M.iconGap - M.labelGap))
            let pathX = icon.maxX + M.iconGap
            let pathWidth = max(0, right - labelWidth - M.labelGap - pathX)
            // flex: 1 — the path takes the room left, whatever its text.
            self.path = centred(pathX, pathWidth, path.height)
            self.label = centred(pathX + pathWidth + M.labelGap, labelWidth, label.height)
        }
    }
}

/// AgentInputAutocomplete's list: fixed-pitch rows inside a hairline rim,
/// scrolling past 320.
public enum ComposerSuggestionListLayout {
    /// The rows' content height and each row's frame inside the rim.
    public static func rows(count: Int, width: CGFloat, border: CGFloat) -> [CGRect] {
        let inset = max(0, border)
        let rowWidth = max(0, width - 2 * inset)
        return (0..<max(0, count)).map { index in
            CGRect(
                x: 0,
                y: CGFloat(index) * ComposerSuggestionRowLayout.Metrics.height,
                width: rowWidth,
                height: ComposerSuggestionRowLayout.Metrics.height
            )
        }
    }
}
