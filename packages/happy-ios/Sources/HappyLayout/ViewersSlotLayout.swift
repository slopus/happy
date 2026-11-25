import Foundation

/// The viewers' faces in a header: one fixed-width slot, so the header
/// lays out the same for nobody and for fifty. Faces overlap left to
/// right in the list's order (here, then the newest), the first on top;
/// past four, a "+N" disc takes a fifth face's place. Content sits at the
/// slot's trailing edge, beside the bar's other buttons.
public struct ViewersSlotLayout: Equatable, Sendable {
    public enum Metrics {
        public static let height: CGFloat = 36
        /// Here and recently here.
        public static let face: CGFloat = 24
        /// Seen before: smaller, tucked behind.
        public static let seenFace: CGFloat = 20
        public static let overlap: CGFloat = 9
        /// The ground between a face and its ring, which also cuts each
        /// face out of the one it overlaps.
        public static let ringGap: CGFloat = 2
        public static let ringWidth: CGFloat = 2
        public static let ringOutset: CGFloat = ringGap + ringWidth
        public static let most = 4
        public static let dot: CGFloat = 8
        public static let badgeHeight: CGFloat = 12
        /// Four faces wearing rings and the "+N": the widest it gets.
        public static let width: CGFloat = (ringOutset + CGFloat(most) * (face - overlap) + face).rounded(.up)
    }

    /// Each shown face's disc, in the list's order.
    public var faces: [CGRect]
    /// The "+N" disc.
    public var more: CGRect?

    /// `large` says, for each person in order, whether they are here or
    /// recent (full size) rather than seen; `total` counts everyone.
    public init(large: [Bool], total: Int) {
        typealias M = Metrics
        let shown = Array(large.prefix(M.most))
        let extra = total > M.most
        var x = M.ringOutset
        var discs: [CGRect] = []
        for isLarge in shown {
            let side = isLarge ? M.face : M.seenFace
            discs.append(CGRect(x: x, y: (M.height - side) / 2, width: side, height: side))
            x += side - M.overlap
        }
        var chip = extra ? CGRect(x: x, y: (M.height - M.face) / 2, width: M.face, height: M.face) : nil
        let end = chip?.maxX ?? discs.last?.maxX ?? 0
        let shift = M.width - end
        faces = discs.map { $0.offsetBy(dx: shift, dy: 0) }
        chip = chip?.offsetBy(dx: shift, dy: 0)
        more = chip
    }

    /// The ground around a face, under it.
    public static func halo(_ face: CGRect) -> CGRect {
        face.insetBy(dx: -Metrics.ringGap, dy: -Metrics.ringGap)
    }

    /// Where the presence ring goes around a face.
    public static func ring(_ face: CGRect) -> CGRect {
        face.insetBy(dx: -Metrics.ringOutset + Metrics.ringWidth / 2, dy: -Metrics.ringOutset + Metrics.ringWidth / 2)
    }

    /// The green dot of someone here, on the face's lower trailing edge.
    public static func dot(_ face: CGRect) -> CGRect {
        let side = Metrics.dot
        return CGRect(x: face.maxX - side + 1.5, y: face.maxY - side + 1.5, width: side, height: side)
    }

    /// A recent face's "4m", `width` measured, over its lower trailing edge.
    public static func badge(_ face: CGRect, width: CGFloat) -> CGRect {
        let w = max(Metrics.badgeHeight, width + 6)
        return CGRect(x: face.maxX - w + 4, y: face.maxY - Metrics.badgeHeight + 3, width: w, height: Metrics.badgeHeight)
    }
}
