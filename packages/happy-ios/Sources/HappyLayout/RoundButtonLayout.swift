import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

public enum RoundButtonSize: Sendable, CaseIterable {
    case large
    case normal
    case small
}

public enum RoundButtonDisplay: Sendable {
    /// The filled pill.
    case filled
    /// A text action: no fill, secondary text colour, may wrap.
    case inverted
}

/// From components/RoundButton.tsx: heights follow the platform control
/// sizes, and line height is round(fontSize × 1.3).
public struct RoundButtonMetrics: Equatable, Sendable {
    public var height: CGFloat
    public var fontSize: CGFloat
    public var lineHeight: CGFloat
    public var paddingHorizontal: CGFloat
    /// How far beyond its frame a touch still counts.
    public var hitSlop: CGFloat

    public init(height: CGFloat, fontSize: CGFloat, lineHeight: CGFloat, paddingHorizontal: CGFloat, hitSlop: CGFloat) {
        self.height = height
        self.fontSize = fontSize
        self.lineHeight = lineHeight
        self.paddingHorizontal = paddingHorizontal
        self.hitSlop = hitSlop
    }

    public static func of(_ size: RoundButtonSize) -> RoundButtonMetrics {
        switch size {
        case .large: RoundButtonMetrics(height: 50, fontSize: 17, lineHeight: 22, paddingHorizontal: 24, hitSlop: 0)
        case .normal: RoundButtonMetrics(height: 44, fontSize: 15, lineHeight: 20, paddingHorizontal: 20, hitSlop: 4)
        case .small: RoundButtonMetrics(height: 32, fontSize: 13, lineHeight: 17, paddingHorizontal: 14, hitSlop: 8)
        }
    }

    public static let minimumWidth: CGFloat = 64
    /// Vertical padding of the inverted (wrapping) variant.
    public static let invertedPaddingVertical: CGFloat = 8
    /// Between the spinner and the loading title.
    public static let inlineSpinnerSpacing: CGFloat = 10
}

/// A RoundButton stretched to the width it is offered.
public struct RoundButtonLayout: Equatable, Sendable {
    public enum Loading {
        case none
        /// The spinner replaces the label in place; the label keeps its frame.
        case overlay(spinner: CGSize)
        /// The spinner sits beside a loading title, centred together.
        case inline(spinner: CGSize)
    }

    public struct Input {
        public var width: CGFloat
        public var size: RoundButtonSize
        public var display: RoundButtonDisplay
        /// The visible label: the title, or the loading title when inline.
        public var label: Measurable
        public var loading: Loading

        public init(width: CGFloat, size: RoundButtonSize = .large, display: RoundButtonDisplay = .filled, label: Measurable, loading: Loading = .none) {
            self.width = width
            self.size = size
            self.display = display
            self.label = label
            self.loading = loading
        }
    }

    public var size: CGSize
    public var label: CGRect
    public var spinner: CGRect?
    public var cornerRadius: CGFloat

    public init(_ input: Input) {
        let metrics = RoundButtonMetrics.of(input.size)
        let width = max(RoundButtonMetrics.minimumWidth, input.width)
        let innerWidth = max(0, width - metrics.paddingHorizontal * 2)

        let spinnerSize: CGSize?
        let labelWidthLimit: CGFloat
        switch input.loading {
        case .none:
            spinnerSize = nil
            labelWidthLimit = innerWidth
        case .overlay(let spinner):
            spinnerSize = spinner
            labelWidthLimit = innerWidth
        case .inline(let spinner):
            spinnerSize = spinner
            labelWidthLimit = max(0, innerWidth - spinner.width - RoundButtonMetrics.inlineSpinnerSpacing)
        }

        let labelSize = input.label.size(fitting: labelWidthLimit)
        let paddingVertical = input.display == .inverted ? RoundButtonMetrics.invertedPaddingVertical : 0
        let height = max(metrics.height, labelSize.height + paddingVertical * 2, spinnerSize?.height ?? 0)
        let midY = height / 2
        size = CGSize(width: width, height: height)
        cornerRadius = height / 2

        switch input.loading {
        case .inline(let spinner):
            let groupWidth = spinner.width + RoundButtonMetrics.inlineSpinnerSpacing + labelSize.width
            let x = (width - groupWidth) / 2
            self.spinner = CGRect(x: x, y: midY - spinner.height / 2, width: spinner.width, height: spinner.height)
            label = CGRect(
                x: x + spinner.width + RoundButtonMetrics.inlineSpinnerSpacing,
                y: midY - labelSize.height / 2,
                width: labelSize.width,
                height: labelSize.height
            )
        case .overlay(let spinner):
            self.spinner = CGRect(x: (width - spinner.width) / 2, y: midY - spinner.height / 2, width: spinner.width, height: spinner.height)
            label = CGRect(x: metrics.paddingHorizontal, y: midY - labelSize.height / 2, width: innerWidth, height: labelSize.height)
        case .none:
            self.spinner = nil
            // The label spans the inner width so centred text stays centred.
            label = CGRect(x: metrics.paddingHorizontal, y: midY - labelSize.height / 2, width: innerWidth, height: labelSize.height)
        }
    }
}
