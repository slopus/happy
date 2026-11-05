import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The artifacts list's rows (`ArtifactListItems`): a card row whose
/// leading tile is a 16:9 slot, the same in every row, for the artifact's
/// cover or its kind's glyph, and a title of one line, so every row is
/// one height and the list never measures one.
public enum ArtifactListMetrics {
    /// The slot, 72 by 40 (16:9 to within 1.2%), with a tile's corners.
    public static let slot = CGSize(width: 72, height: 40)
    public static let slotRadius: CGFloat = CardListMetrics.tileRadius
    public static let titleLines = 1
}

/// Where a cover sits in a row's slot (`ArtifactListMetrics.slot`): one
/// the slot's shape (within the 2% a cover may be off its own) or wider
/// fills it, cropped to it; a narrower one, a square, stands whole at the
/// slot's height, centred, on the slot's fill. `ratio` is the cover's
/// height over its width.
public enum ArtifactCoverSlot {
    public static func picture(ratio: CGFloat, in slot: CGRect, scale: CGFloat = 1) -> CGRect {
        guard !fills(ratio: ratio, slot: slot.size) else { return slot }
        func pixel(_ value: CGFloat) -> CGFloat { (value * max(1, scale)).rounded() / max(1, scale) }
        let width = min(slot.width, pixel(slot.height / ratio))
        return CGRect(x: pixel(slot.midX - width / 2), y: slot.minY, width: width, height: slot.height)
    }

    /// Whether the picture fills the slot, its corners the slot's, or
    /// stands inside it, square-cornered.
    public static func fills(ratio: CGFloat, slot: CGSize) -> Bool {
        guard ratio > 0, ratio.isFinite, slot.width > 0, slot.height > 0 else { return true }
        return ratio <= slot.height / slot.width * 1.02
    }
}
