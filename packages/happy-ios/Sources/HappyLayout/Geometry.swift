import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// HappyLayout imports Foundation and, on Apple platforms, CoreGraphics for
// the geometry types; never UIKit. On Linux, CGFloat, CGSize, CGPoint and
// CGRect come from swift-corelibs-foundation. That is the whole contract:
// every layout here is a pure function from sizes to frames, and runs under
// `swift test` on any machine.

/// Safe-area, keyboard or padding insets. `UIEdgeInsets` lives in UIKit, so
/// layouts take this instead.
public struct LayoutInsets: Equatable, Sendable {
    public var top: CGFloat
    public var left: CGFloat
    public var bottom: CGFloat
    public var right: CGFloat

    public init(top: CGFloat = 0, left: CGFloat = 0, bottom: CGFloat = 0, right: CGFloat = 0) {
        self.top = top
        self.left = left
        self.bottom = bottom
        self.right = right
    }

    public static let zero = LayoutInsets()

    public var horizontal: CGFloat { left + right }
    public var vertical: CGFloat { top + bottom }
}

/// Content whose size depends on the width it is offered, such as wrapping
/// text. UIKit views pass a closure over `sizeThatFits`; tests pass fixed
/// sizes or a fake text measurer.
public struct Measurable {
    private let measure: (CGFloat) -> CGSize

    public init(_ measure: @escaping (_ width: CGFloat) -> CGSize) {
        self.measure = measure
    }

    /// Content that is the same size at any width, like an icon.
    public static func fixed(_ size: CGSize) -> Measurable {
        Measurable { _ in size }
    }

    public static func fixed(width: CGFloat, height: CGFloat) -> Measurable {
        .fixed(CGSize(width: width, height: height))
    }

    /// The size of the content when offered `width`. Never wider than the
    /// offer and never negative, whatever the measurer returns.
    public func size(fitting width: CGFloat) -> CGSize {
        let offered = max(0, width)
        let measured = measure(offered)
        return CGSize(width: min(max(0, measured.width), offered), height: max(0, measured.height))
    }

    public func height(fitting width: CGFloat) -> CGFloat {
        size(fitting: width).height
    }

    /// Lays several alternatives over one another and takes the largest, the
    /// way the first-run screens reserve room for whichever content is
    /// tallest so their buttons never move.
    public static func largest(of items: [Measurable]) -> Measurable {
        Measurable { width in
            items.reduce(CGSize.zero) { result, item in
                let size = item.size(fitting: width)
                return CGSize(width: max(result.width, size.width), height: max(result.height, size.height))
            }
        }
    }
}

public enum PixelGrid {
    /// Rounds a frame's edges to the nearest device pixel, so text and
    /// hairlines land crisply. Edges are rounded rather than origin and size,
    /// so adjacent frames that share an edge still share it after snapping.
    /// The size is a whole number of pixels divided once by the scale, so a
    /// 52-point box at a third of a point is 52, not 51.99999999999999.
    public static func snap(_ rect: CGRect, scale: CGFloat) -> CGRect {
        guard scale > 0, !rect.isNull, !rect.isInfinite else { return rect }
        func pixel(_ value: CGFloat) -> CGFloat {
            (value * scale).rounded()
        }
        let minX = pixel(rect.minX)
        let minY = pixel(rect.minY)
        let maxX = pixel(rect.maxX)
        let maxY = pixel(rect.maxY)
        // A hairline still gets one pixel instead of rounding away.
        let width = rect.width > 0 ? max(maxX - minX, 1) / scale : 0
        let height = rect.height > 0 ? max(maxY - minY, 1) / scale : 0
        return CGRect(x: minX / scale, y: minY / scale, width: width, height: height)
    }

    /// Up to the screen's next pixel, as React Native ceils a measured
    /// Text's box (`RCTTextLayoutManager.mm` 391-392); a `scale` of 0 is
    /// whole points. A thousandth of a pixel over is float noise in
    /// TextKit's sum of lines, not a pixel (`FileLinesLayout.textHeight`).
    public static func ceil(_ value: CGFloat, scale: CGFloat) -> CGFloat {
        let scale = scale > 0 ? scale : 1
        return ((value * scale) - 0.001).rounded(.up) / scale
    }

    /// Rounds a length to the nearest device pixel, for an inset measured
    /// to a snapped edge, so it lands where `snap` put that edge.
    public static func round(_ value: CGFloat, scale: CGFloat) -> CGFloat {
        guard scale > 0, value.isFinite else { return value }
        return (value * scale).rounded() / scale
    }
}

extension CGRect {
    /// A rect of `size` centred horizontally in `width`, starting at `y`.
    static func centered(_ size: CGSize, inWidth width: CGFloat, originX: CGFloat = 0, y: CGFloat) -> CGRect {
        CGRect(x: originX + (width - size.width) / 2, y: y, width: size.width, height: size.height)
    }
}
