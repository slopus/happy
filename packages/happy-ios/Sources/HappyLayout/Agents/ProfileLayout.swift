import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The person's own Profile page, under the bar and scrolling: their
/// picture large and round, "Change Photo" under it, then settings' cards
/// (the name as a field in the first, "Remove Photo" in the next while
/// there is a picture).
public struct ProfileLayout: Equatable, Sendable {
    public enum Metrics {
        public static let avatarTop: CGFloat = 16
        public static let avatar: CGFloat = 100
        public static let buttonGap: CGFloat = 8
        /// "Change Photo": its text and room around it for a thumb.
        public static let buttonHeight: CGFloat = 32
        public static let buttonPadding: CGFloat = 12
        public static let cardsTop: CGFloat = 20
    }

    public var avatar: CGRect
    public var changePhoto: CGRect
    public var cards: [SettingsLayout.Card]
    /// The first card's first row's text, where the name is typed.
    public var nameField: CGRect
    public var contentHeight: CGFloat

    /// `buttonWidth` is "Change Photo" as measured.
    public init(width: CGFloat, buttonWidth: CGFloat, cards specs: [[SettingsLayout.RowSpec]]) {
        typealias M = Metrics
        typealias S = SettingsLayout.Metrics
        avatar = CGRect(x: ((width - M.avatar) / 2).rounded(), y: M.avatarTop, width: M.avatar, height: M.avatar)
        let button = min(width, buttonWidth.rounded(.up) + 2 * M.buttonPadding)
        changePhoto = CGRect(x: ((width - button) / 2).rounded(), y: avatar.maxY + M.buttonGap, width: button, height: M.buttonHeight)
        let cardWidth = max(0, width - 2 * S.side)
        var y = changePhoto.maxY + M.cardsTop
        var cards: [SettingsLayout.Card] = []
        for spec in specs where !spec.isEmpty {
            let rows = spec.enumerated().map { index, row in
                SettingsLayout.row(row, y: CGFloat(index) * S.row, width: cardWidth, last: index == spec.count - 1)
            }
            cards.append(SettingsLayout.Card(frame: CGRect(x: S.side, y: y, width: cardWidth, height: CGFloat(spec.count) * S.row), rows: rows))
            y += CGFloat(spec.count) * S.row + S.cardGap
        }
        self.cards = cards
        nameField = cards.first.flatMap { card in card.rows.first.map { $0.title.offsetBy(dx: card.frame.minX, dy: card.frame.minY) } } ?? .zero
        contentHeight = (cards.last?.frame.maxY ?? changePhoto.maxY) + S.bottom
    }
}

/// A picked picture as it is sent: its middle square, no more than
/// `maxSide` pixels across, never enlarged.
public struct ProfilePhotoCrop: Equatable, Sendable {
    /// Three times the page's 100-point circle, and then some.
    public static let maxSide: CGFloat = 512

    /// The output's side, in pixels.
    public var side: CGFloat
    /// Where the whole picture is drawn in the `side`-square output, so
    /// its middle square fills it.
    public var draw: CGRect

    /// `size` is the picture's, upright, in pixels.
    public init(size: CGSize, maxSide: CGFloat = Self.maxSide) {
        let square = min(size.width, size.height)
        side = max(1, min(maxSide, square).rounded(.down))
        let scale = square > 0 ? side / square : 1
        let width = size.width * scale, height = size.height * scale
        draw = CGRect(x: ((side - width) / 2).rounded(), y: ((side - height) / 2).rounded(), width: width.rounded(), height: height.rounded())
    }
}
