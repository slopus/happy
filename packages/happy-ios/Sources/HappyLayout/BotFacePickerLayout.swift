import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The faces a new bot may wear (BotFacePicker.tsx): a heading, four faces
/// and the die on one row, and the artist's credit beneath.
///
///     Avatar
///     [☺] [☺] [☺] [☺] (⚄)        ← faces up to 52 square, 10 apart
///     Art by Lisa Wischofsky
///
/// The four faces share what the die leaves and shrink together on a
/// narrow phone, so the row never runs past its width. Each face keeps a
/// 2pt ring laid out whether picked or not, so picking moves nothing.
public struct BotFacePickerLayout: Equatable, Sendable {
    public enum Metrics {
        public static let faceCount = 4
        /// The most a face takes (`FACE_SIZE`).
        public static let faceSize: CGFloat = 52
        public static let faceRadius: CGFloat = 14
        public static let ringWidth: CGFloat = 2
        /// The picture inside the ring.
        public static let imageRadius: CGFloat = faceRadius - ringWidth
        public static let dieSize: CGFloat = 40
        public static let dieIconSize: CGFloat = 22
        /// Between the heading, the row and the credit.
        public static let gap: CGFloat = 6
        /// Between the faces, and before the die.
        public static let facesGap: CGFloat = 10
    }

    /// The picker's words, measured.
    public struct Text {
        /// "Avatar".
        public var heading: Measurable
        /// "Art by Lisa Wischofsky", on one line.
        public var credit: Measurable
        /// "Art by ", the part before the link.
        public var creditLead: Measurable

        public init(heading: Measurable, credit: Measurable, creditLead: Measurable) {
            self.heading = heading
            self.credit = credit
            self.creditLead = creditLead
        }
    }

    public var size: CGSize
    public var heading: CGRect
    /// Each face's square, ring included.
    public var faces: [CGRect]
    public var die: CGRect
    public var credit: CGRect
    /// The artist's name, which opens their page.
    public var creditLink: CGRect

    public init(width: CGFloat, text: Text) {
        typealias M = Metrics
        let width = max(0, width)

        let headingSize = text.heading.size(fitting: width)
        heading = CGRect(x: 0, y: 0, width: min(headingSize.width, width), height: headingSize.height)

        // `flex: 1` up to 52 each, from what the gaps and the die leave.
        let gaps = CGFloat(M.faceCount) * M.facesGap
        let face = max(0, min(M.faceSize, (width - M.dieSize - gaps) / CGFloat(M.faceCount)))
        let rowTop = heading.maxY + M.gap
        let rowHeight = max(face, M.dieSize)
        faces = (0..<M.faceCount).map { index in
            CGRect(x: CGFloat(index) * (face + M.facesGap), y: rowTop + (rowHeight - face) / 2, width: face, height: face)
        }
        die = CGRect(
            x: CGFloat(M.faceCount) * (face + M.facesGap),
            y: rowTop + (rowHeight - M.dieSize) / 2,
            width: M.dieSize,
            height: M.dieSize
        )

        let creditSize = text.credit.size(fitting: width)
        credit = CGRect(x: 0, y: rowTop + rowHeight + M.gap, width: min(creditSize.width, width), height: creditSize.height)
        let lead = min(text.creditLead.size(fitting: .greatestFiniteMagnitude).width, credit.width)
        creditLink = CGRect(x: credit.minX + lead, y: credit.minY, width: credit.width - lead, height: credit.height)

        size = CGSize(width: width, height: credit.maxY)
    }
}
