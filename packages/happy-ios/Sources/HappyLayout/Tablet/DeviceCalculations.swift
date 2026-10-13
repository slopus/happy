import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// utils/responsive.ts and utils/deviceCalculations.ts, iOS values: when
/// happy-app draws its tablet layout, how tall its headers are, and what it
/// calls a tablet when it sizes content (components/layout.ts).
///
/// Two different questions get two different answers there, and both are
/// kept:
///   - `isTablet(windowWidth:)` (`useIsTablet`) is a rule about the window,
///     not the device. An iPad in Split View or Slide Over can fall below it
///     and get the phone layout; widening the window brings the sidebar
///     back.
///   - `deviceType(…)` (`getDeviceType`) is about the screen. It only feeds
///     `layout.maxWidth`, and it calls most iPads phones: only a screen over
///     9 inches across (the 13-inch iPads) is a tablet.
public enum TabletBreakpoint {
    /// "At 768 logical pixels the sidebar is 250px and leaves 518px for
    /// content."
    public static let minWidth: CGFloat = 768

    /// `useIsTablet`: width alone, never height, so a keyboard that shrinks
    /// the window never collapses the sidebar.
    public static func isTablet(windowWidth: CGFloat) -> Bool {
        windowWidth >= minWidth
    }

    /// `useIsLandscape`.
    public static func isLandscape(_ window: CGSize) -> Bool {
        window.width > window.height
    }
}

public enum DeviceCalculations {
    /// iOS points per inch (`calculateDeviceDimensions`'s 163).
    public static let pointsPerInch: CGFloat = 163
    /// `determineDeviceType`'s default threshold.
    public static let tabletThresholdInches: CGFloat = 9

    public struct Dimensions: Equatable, Sendable {
        public var widthInches: CGFloat
        public var heightInches: CGFloat
        public var diagonalInches: CGFloat
    }

    public enum DeviceType: Equatable, Sendable {
        case phone
        case tablet
    }

    /// `calculateDeviceDimensions`.
    public static func dimensions(widthPoints: CGFloat, heightPoints: CGFloat, pointsPerInch: CGFloat = pointsPerInch) -> Dimensions {
        let width = widthPoints / pointsPerInch
        let height = heightPoints / pointsPerInch
        return Dimensions(widthInches: width, heightInches: height, diagonalInches: (width * width + height * height).squareRoot())
    }

    /// `determineDeviceType` on iOS: an iPad is a tablet only past 9 inches
    /// (strictly), which makes the iPad mini, the 10.9 and 11-inch iPads
    /// phones; anything else is a tablet from 9 inches up.
    public static func deviceType(diagonalInches: CGFloat, isPad: Bool, tabletThresholdInches: CGFloat = tabletThresholdInches) -> DeviceType {
        if isPad {
            return diagonalInches > 9 ? .tablet : .phone
        }
        return diagonalInches >= tabletThresholdInches ? .tablet : .phone
    }

    /// `getDeviceType()`: the screen in points, at 163 per inch.
    public static func deviceType(screen: CGSize, isPad: Bool) -> DeviceType {
        deviceType(diagonalInches: dimensions(widthPoints: screen.width, heightPoints: screen.height).diagonalInches, isPad: isPad)
    }

    /// `calculateHeaderHeight` on iOS: Mac Catalyst 56, iPad 50, iPhone 44.
    /// It goes by the device (`Platform.isPad`), so an iPad's headers stay
    /// 50 even in a window narrow enough for the phone layout.
    public static func headerHeight(isPad: Bool, isMacCatalyst: Bool = false) -> CGFloat {
        if isMacCatalyst { return 56 }
        return isPad ? 50 : 44
    }
}

/// components/layout.ts, iOS: how wide content may grow. Fixed when the
/// module loads, from the screen and the window of that moment, and never
/// recomputed.
public enum ContentWidthLimit {
    /// Tablets (by `DeviceCalculations.deviceType`) and the web.
    public static let tablet: CGFloat = 800
    /// `getMaxLayoutWidth` on Mac Catalyst.
    public static let macLayout: CGFloat = 1400

    /// `layout.maxWidth`: a phone's longest window side (so, in effect, no
    /// limit), 800 on a tablet.
    public static func maxWidth(deviceType: DeviceCalculations.DeviceType, window: CGSize, isMacCatalyst: Bool = false) -> CGFloat {
        if deviceType == .phone { return max(window.width, window.height) }
        return isMacCatalyst ? macLayout : tablet
    }

    /// `layout.headerMaxWidth`: the same, unlimited on Mac Catalyst.
    public static func headerMaxWidth(deviceType: DeviceCalculations.DeviceType, window: CGSize, isMacCatalyst: Bool = false) -> CGFloat {
        if deviceType == .phone { return max(window.width, window.height) }
        return isMacCatalyst ? .greatestFiniteMagnitude : tablet
    }
}
