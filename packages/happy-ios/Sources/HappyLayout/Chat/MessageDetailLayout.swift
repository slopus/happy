import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A message's own screen ([messageId].tsx). A tool's full view sits in a
/// readable column, 16 in and at most 800 wide, 12 from the top and 32
/// from the bottom (ToolFullView); an edit's diffs run edge to edge on a
/// phone and 16 in past 700 wide, within `maxContentWidth`. A text message
/// is 16 in all round.
public struct MessageDetailLayout: Equatable, Sendable {
    public enum Metrics {
        public static let toolPaddingTop: CGFloat = 12
        public static let toolPaddingBottom: CGFloat = 32
        public static let readableMaxWidth: CGFloat = 800
        public static let paddingH: CGFloat = 16
        /// Wide content gets its padding back past this screen width.
        public static let widePaddingFrom: CGFloat = 700
        public static let textPadding: CGFloat = 16
    }

    public enum Kind: Sendable {
        /// A readable column.
        case tool
        /// An edit's diffs.
        case wideTool
        case text
    }

    public var content: CGRect
    public var contentSize: CGSize

    /// `maxContentWidth` is layout.maxWidth: unlimited on a phone, 800
    /// on a tablet.
    public init(width: CGFloat, kind: Kind, content: Measurable, maxContentWidth: CGFloat = .greatestFiniteMagnitude) {
        typealias M = Metrics
        let width = max(0, width)
        switch kind {
        case .tool, .wideTool:
            let wrapper = min(width, maxContentWidth)
            let column = kind == .tool ? min(wrapper, M.readableMaxWidth) : wrapper
            let padding = kind == .tool || width > M.widePaddingFrom ? M.paddingH : 0
            let inner = max(0, column - 2 * padding)
            let height = content.height(fitting: inner)
            self.content = CGRect(x: (width - column) / 2 + padding, y: M.toolPaddingTop, width: inner, height: height)
            contentSize = CGSize(width: width, height: M.toolPaddingTop + height + M.toolPaddingBottom)
        case .text:
            let inner = max(0, width - 2 * M.textPadding)
            let height = content.height(fitting: inner)
            self.content = CGRect(x: M.textPadding, y: M.textPadding, width: inner, height: height)
            contentSize = CGSize(width: width, height: height + 2 * M.textPadding)
        }
    }
}

/// MultiEditViewFull's edit header: "Edit N of M" in purple, then a
/// "Replace All" badge 8 to its right when the edit replaces every
/// occurrence, the two centred on one row.
public struct MultiEditHeaderLayout: Equatable, Sendable {
    public enum Metrics {
        public static let badgeGap: CGFloat = 8
        public static let badgePaddingH: CGFloat = 8
        public static let badgePaddingV: CGFloat = 4
        public static let badgeRadius: CGFloat = 12
    }

    public var size: CGSize
    public var number: CGRect
    /// The badge's pill and the text inside it.
    public var badge: CGRect?
    public var badgeText: CGRect?

    public init(width: CGFloat, number: Measurable, badge: Measurable?) {
        typealias M = Metrics
        let width = max(0, width)
        let badgeText = badge.map { $0.size(fitting: width) }
        let badgeSize = badgeText.map { CGSize(width: $0.width + 2 * M.badgePaddingH, height: $0.height + 2 * M.badgePaddingV) }
        let numberWidth = max(0, width - (badgeSize.map { $0.width + M.badgeGap } ?? 0))
        let numberSize = number.size(fitting: numberWidth)
        let height = max(numberSize.height, badgeSize?.height ?? 0)
        self.number = CGRect(x: 0, y: (height - numberSize.height) / 2, width: numberSize.width, height: numberSize.height)
        if let badgeSize, let badgeText {
            let pill = CGRect(x: numberSize.width + M.badgeGap, y: (height - badgeSize.height) / 2, width: badgeSize.width, height: badgeSize.height)
            self.badge = pill
            self.badgeText = CGRect(x: pill.minX + M.badgePaddingH, y: pill.minY + M.badgePaddingV, width: badgeText.width, height: badgeText.height)
        } else {
            self.badge = nil
            self.badgeText = nil
        }
        size = CGSize(width: width, height: height)
    }
}

/// Long text cut into pieces small enough to draw one at a time, so a
/// message screen showing thousands of lines of output only ever draws
/// the few near the screen.
///
/// Pieces end after a newline, at most `maxLines` lines and, once past
/// `maxLength` UTF-16 units, at the next newline. A line longer than twice
/// that is cut after its last space (or anywhere, if it has none).
/// Joined back together, the pieces are the text.
public enum TextChunks {
    public static let maxLines = 40
    public static let maxLength = 3000

    public static func split(_ text: String, maxLines: Int = maxLines, maxLength: Int = maxLength) -> [String] {
        var chunks: [String] = []
        var start = text.startIndex
        var lines = 0
        var length = 0
        var lastSpace: String.Index?
        var index = start
        while index < text.endIndex {
            let character = text[index]
            let next = text.index(after: index)
            length += character.utf16.count
            if character.isNewline {
                lines += 1
                lastSpace = nil
                if lines >= maxLines || length >= maxLength {
                    chunks.append(String(text[start..<next]))
                    start = next
                    lines = 0
                    length = 0
                }
            } else {
                if character.isWhitespace { lastSpace = next }
                if length >= 2 * maxLength {
                    let cut = lastSpace ?? next
                    chunks.append(String(text[start..<cut]))
                    length = text[cut..<next].utf16.count
                    start = cut
                    lines = 0
                    lastSpace = nil
                }
            }
            index = next
        }
        if start < text.endIndex || chunks.isEmpty { chunks.append(String(text[start...])) }
        return chunks
    }

    /// What a piece other than the last draws: without the newline that
    /// ends it (the next piece starts on the next line anyway), and with a
    /// space for an empty last line, which would otherwise take no room.
    public static func drawn(_ chunk: String) -> String {
        guard let last = chunk.last, last.isNewline else { return chunk }
        let line = String(chunk.dropLast())
        if line.isEmpty || line.last?.isNewline == true { return line + " " }
        return line
    }
}
