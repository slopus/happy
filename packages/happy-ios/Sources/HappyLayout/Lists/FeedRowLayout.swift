import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// One Feed entry as a row of its date's card, in its slot's coordinates:
///
///     |16| avatar |12| title ……………………… time |6| • |16|
///                      ◯◯◯ +N |6| summary ……………………… |16|
///                      ……… hairline to the card's edge
///
/// The title and the summary are one line each; the faces overlap by
/// `faceOverlap`, the first leftmost. The dot's lane is kept whether or
/// not the entry is unread.
public struct FeedRowLayout: Equatable, Sendable {
    public var size: CGSize
    public var card: CGRect
    public var avatar: CGRect
    public var title: CGRect
    public var time: CGRect?
    public var dot: CGRect
    /// First to last, each a square `face` wide.
    public var faces: [CGRect]
    public var more: CGRect?
    public var summary: CGRect?
    public var separator: CGRect?

    /// `faces` is how many faces show (at most `maxFaces`), `more` the
    /// size of "+N" when there are more actors than that.
    public init(width: CGFloat, maxWidth: CGFloat = .greatestFiniteMagnitude, place: CardPlace, title: Measurable, time: CGSize?, faces: Int, more: CGSize?, summary: Measurable?, hairline: CGFloat, scale: CGFloat = 1) {
        typealias M = FeedMetrics
        typealias C = CardListMetrics
        func pixel(_ value: CGFloat) -> CGFloat { (value * max(1, scale)).rounded() / max(1, scale) }
        let column = CardColumn(width: width, maxWidth: maxWidth)
        let right = column.maxX - C.inset
        let avatarX = column.x + C.inset
        let textX = avatarX + M.avatar + C.tileGap
        let dotX = right - M.dot
        let timeRight = dotX - M.dotGap
        let titleRight = time.map { timeRight - $0.width - C.trailingGap } ?? timeRight
        let titleSize = title.size(fitting: max(0, titleRight - textX))

        let shown = max(0, min(M.maxFaces, faces))
        let facesWidth = shown > 0 ? M.face + CGFloat(shown - 1) * (M.face - M.faceOverlap) : 0
        var x = textX + facesWidth
        var moreX: CGFloat?
        if let more {
            moreX = shown > 0 ? x + M.moreGap : x
            x = moreX! + more.width
        }
        let summaryX = x > textX ? x + M.summaryGap : textX
        let summarySize = summary?.size(fitting: max(0, right - summaryX))
        let lineHeight = max(shown > 0 ? M.face : 0, more?.height ?? 0, summarySize?.height ?? 0)
        let hasLine = lineHeight > 0
        let textHeight = titleSize.height + (hasLine ? M.lineGap + lineHeight : 0)
        let height = max(M.minHeight, pixel(textHeight + 2 * C.padding))
        let top = pixel((height - textHeight) / 2)
        let lineTop = top + titleSize.height + M.lineGap
        func centred(_ size: CGFloat, in top: CGFloat, _ height: CGFloat) -> CGFloat { pixel(top + (height - size) / 2) }

        size = CGSize(width: max(0, width), height: height)
        card = CGRect(x: column.x, y: 0, width: column.width, height: height)
        avatar = CGRect(x: avatarX, y: pixel((height - M.avatar) / 2), width: M.avatar, height: M.avatar)
        self.title = CGRect(x: textX, y: top, width: max(0, titleRight - textX), height: titleSize.height)
        self.time = time.map { CGRect(x: timeRight - $0.width, y: centred($0.height, in: top, titleSize.height), width: $0.width, height: $0.height) }
        dot = CGRect(x: dotX, y: centred(M.dot, in: top, titleSize.height), width: M.dot, height: M.dot)
        self.faces = (0..<shown).map { index in
            CGRect(x: textX + CGFloat(index) * (M.face - M.faceOverlap), y: centred(M.face, in: lineTop, lineHeight), width: M.face, height: M.face)
        }
        self.more = more.map { CGRect(x: moreX ?? textX, y: centred($0.height, in: lineTop, lineHeight), width: $0.width, height: $0.height) }
        self.summary = summarySize.map { CGRect(x: summaryX, y: centred($0.height, in: lineTop, lineHeight), width: max(0, right - summaryX), height: $0.height) }
        separator = place.last ? nil : CGRect(x: textX, y: height - hairline, width: max(0, column.maxX - textX), height: hairline)
    }
}
