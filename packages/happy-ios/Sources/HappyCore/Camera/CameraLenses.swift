import Foundation

/// The lenses a camera offers, as the system camera shows them: zoom in
/// the Camera app's terms, where the wide camera is 1×, against the
/// device's own `videoZoomFactor`, where a virtual camera's 1 is its
/// widest lens.
///
/// On an iPhone 15 Pro Max the back camera is a triple virtual device that
/// switches from the ultra wide to the wide at 2 and to the 5× telephoto
/// at 10, and whose 48 MP wide reads a full-resolution 2× crop at 4: the
/// buttons are 0.5, 1, 2 and 5. A wide camera alone has the one button, 1.
public struct CameraLenses: Equatable, Sendable {
    /// The device zoom that is 1×.
    public let wideZoom: Double
    /// The device zoom range the buttons and the pinch move within.
    public let minZoom: Double
    public let maxZoom: Double
    /// The buttons, as device zooms, from the widest.
    public let stops: [Double]

    /// A single lens at 1×, before the device is known.
    public static let single = CameraLenses(minZoom: 1, maxZoom: 1)

    /// - `hasUltraWide`: the device is a virtual one whose widest lens is an
    ///   ultra wide, so its 1 is 0.5× and the wide starts at the first
    ///   switch-over.
    /// - `switchOvers`: `virtualDeviceSwitchOverVideoZoomFactors`, where
    ///   each next lens takes over.
    /// - `secondaryNative`: the format's
    ///   `secondaryNativeResolutionZoomFactors`, crops read at full
    ///   resolution (a 48 MP wide's 2×), in device zoom.
    /// - `minZoom`, `maxZoom`: the device's available zoom factors.
    public init(hasUltraWide: Bool = false, switchOvers: [Double] = [], secondaryNative: [Double] = [], minZoom: Double, maxZoom: Double) {
        let switchOvers = switchOvers.filter { $0.isFinite && $0 > 1 }.sorted()
        let wide = hasUltraWide ? (switchOvers.first ?? 1) : 1
        self.wideZoom = wide
        self.minZoom = max(1, min(minZoom, maxZoom))
        // The system camera lets the pinch go five times past its longest
        // lens: 15× with a 3× telephoto, 25× with a 5×, 5× on a wide alone.
        let longest = ([wide] + switchOvers).max() ?? wide
        self.maxZoom = max(self.minZoom, min(maxZoom, longest * 5))
        var stops = (hasUltraWide ? [1] : []) + [wide] + switchOvers.filter { $0 > wide }
        let reach = self.maxZoom
        for crop in secondaryNative where crop.isFinite && crop > wide && crop <= reach {
            // A crop beside a lens of about its reach is that lens.
            if !stops.contains(where: { abs($0 - crop) / crop < 0.1 }) { stops.append(crop) }
        }
        let (low, high) = (self.minZoom, self.maxZoom)
        self.stops = stops.filter { $0 >= low - 1e-9 && $0 <= high + 1e-9 }.sorted()
    }


    /// The Camera app's zoom for a device zoom.
    public func display(_ device: Double) -> Double { device / wideZoom }

    /// The device zoom for one of the Camera app's, within reach.
    public func device(_ display: Double) -> Double {
        Swift.min(maxZoom, Swift.max(minZoom, display * wideZoom))
    }

    public var displayStops: [Double] { stops.map(display) }

    /// The button the zoom falls under: the longest lens at or below it.
    public func stop(for device: Double) -> Int {
        stops.lastIndex(where: { $0 <= device * 1.001 }) ?? 0
    }

    /// The pinch: the zoom it started at, times its scale, within reach.
    public func pinched(from device: Double, scale: Double) -> Double {
        guard scale.isFinite, scale > 0 else { return device }
        return Swift.min(maxZoom, Swift.max(minZoom, device * scale))
    }

    /// A button's words, as the system camera writes them: ".5", "1", "2";
    /// the chosen one with its "×", and the zoom it is at when a pinch has
    /// moved it off its lens ("1.4×").
    public static func label(_ display: Double, selected: Bool) -> String {
        let rounded = (display * 10).rounded() / 10
        var text: String
        if abs(rounded - rounded.rounded()) < 1e-9 {
            text = String(Int(rounded.rounded()))
        } else {
            text = String(format: "%.1f", rounded)
            if text.hasPrefix("0") { text.removeFirst() }
        }
        return selected ? text + "×" : text
    }
}
