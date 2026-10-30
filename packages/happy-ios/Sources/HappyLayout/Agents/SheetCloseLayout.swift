import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Where every modal sheet's close button goes: a 44 circle at the top
/// right of the sheet's header, as far down from the sheet's top as it is
/// in from its right side.
public enum SheetCloseLayout {
    public static let size: CGFloat = 44
    public static let inset: CGFloat = 16

    /// In a sheet `width` wide whose top edge is at `top`.
    public static func frame(width: CGFloat, top: CGFloat = 0) -> CGRect {
        CGRect(x: max(0, width) - inset - size, y: top + inset, width: size, height: size)
    }
}
