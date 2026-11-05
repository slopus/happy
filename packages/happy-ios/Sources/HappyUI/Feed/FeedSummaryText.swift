#if canImport(UIKit)
import Foundation
import HappyLayout
import UIKit

/// A post's summary as the Feed draws it at the post's width
/// (`FeedRowLayout.postWidth`): all of it when it fits in
/// `FeedMetrics.captionLines` lines; else cut there, the last line ending
/// "… Show more", or, opened, all of it ending "Show less". Line breaks
/// are kept. Laid out with TextKit 1 as `CardText` measures and
/// `CardDrawing` draws (`.paragraph`, `CardTextStack`), so the toggle is where the tap
/// finds it; worked out off the main thread, and kept per text, width
/// and state, so a derivation that changes nothing lays out nothing.
struct FeedSummaryText: Equatable, Sendable {
    /// The words drawn in the text's colour, then the toggle's.
    var text: String
    var toggle: String?
    var size: CGSize
    /// Where the toggle's words are, from the text's origin.
    var toggleFrame: CGRect?

    nonisolated static func fit(_ summary: String, font: CardFont, width: CGFloat, lines: Int = FeedMetrics.captionLines, expanded: Bool, more: String, less: String, scale: CGFloat) -> FeedSummaryText {
        guard !summary.isEmpty, width > 0 else { return FeedSummaryText(text: summary, size: .zero) }
        let key = "\(font.weight)|\(font.size)|\(font.mono)|\(width)|\(lines)|\(expanded)|\(scale)|\(more)|\(less)|\(summary)" as NSString
        if let kept = cache.object(forKey: key) { return kept.fit }
        let fit = measure(summary, font: font, width: width, lines: lines, expanded: expanded, more: more, less: less, scale: scale)
        cache.setObject(Kept(fit), forKey: key)
        return fit
    }

    private final class Kept: Sendable {
        let fit: FeedSummaryText
        init(_ fit: FeedSummaryText) { self.fit = fit }
    }

    nonisolated(unsafe) private static let cache: NSCache<NSString, Kept> = {
        let cache = NSCache<NSString, Kept>()
        cache.countLimit = 200
        return cache
    }()

    /// Words that never part across a line: the toggle stays whole.
    nonisolated private static func joined(_ words: String) -> String {
        words.replacingOccurrences(of: " ", with: "\u{00A0}")
    }

    nonisolated private static func laid(_ stack: CardTextStack, _ text: String, _ toggle: String?, scale: CGFloat) -> FeedSummaryText {
        let measured = stack.measured(scale: scale)
        return FeedSummaryText(text: text, toggle: toggle, size: measured.size, toggleFrame: measured.toggle)
    }

    nonisolated private static func measure(_ summary: String, font: CardFont, width: CGFloat, lines: Int, expanded: Bool, more: String, less: String, scale: CGFloat) -> FeedSummaryText {
        let whole = CardTextStack(summary, nil, font: font, width: width, lines: lines)
        guard whole.overflows else { return laid(whole, summary, nil, scale: scale) }
        if expanded {
            let toggle = joined(less)
            return laid(CardTextStack(summary + " ", toggle, font: font, width: width, lines: 0), summary + " ", toggle, scale: scale)
        }
        // The last line's words, cut as late as "… Show more" still ends
        // on it; at a space where the line has one.
        let text = summary as NSString
        let toggle = joined(more)
        let lineStart = whole.lastLineStart
        func cut(_ end: Int) -> String {
            text.substring(to: end).replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression) + "…\u{00A0}"
        }
        func fits(_ end: Int) -> Bool { !CardTextStack(cut(end), toggle, font: font, width: width, lines: lines).overflows }
        var low = lineStart
        var high = max(lineStart, whole.laidEnd)
        while low < high {
            let middle = (low + high + 1) / 2
            if fits(middle) { low = middle } else { high = middle - 1 }
        }
        var end = low
        if end < text.length { end = text.rangeOfComposedCharacterSequence(at: end).location }
        func blank(_ index: Int) -> Bool {
            guard index >= 0, index < text.length, let scalar = UnicodeScalar(text.character(at: index)) else { return false }
            return CharacterSet.whitespacesAndNewlines.contains(scalar)
        }
        let space = text.rangeOfCharacter(from: .whitespacesAndNewlines, options: .backwards, range: NSRange(location: lineStart, length: max(0, end - lineStart)))
        if end < text.length, !blank(end), !blank(end - 1), space.location != NSNotFound, space.location > lineStart { end = space.location }
        let shown = cut(end)
        return laid(CardTextStack(shown, toggle, font: font, width: width, lines: lines), shown, toggle, scale: scale)
    }
}
#endif
