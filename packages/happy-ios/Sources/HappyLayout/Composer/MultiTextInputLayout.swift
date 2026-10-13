import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// multiTextInputLayout.ts: how tall the growing text input is.
///
/// The input grows with its text from one line (plus its padding) up to
/// `maxHeight`, then scrolls. An emptied input drops back to the minimum at
/// once, whatever the last measurement said.
public struct MultiTextInputLayout: Equatable, Sendable {
    public var height: CGFloat
    /// `height` plus the chrome around the input.
    public var containerHeight: CGFloat
    public var scrollEnabled: Bool

    public init(height: CGFloat, containerHeight: CGFloat, scrollEnabled: Bool) {
        self.height = height
        self.containerHeight = containerHeight
        self.scrollEnabled = scrollEnabled
    }

    /// `resolveMultiTextInputLayout`. `contentHeight` is the text's measured
    /// height, its padding included.
    public init(
        contentHeight: CGFloat,
        hasText: Bool = true,
        maxHeight: CGFloat,
        lineHeight: CGFloat,
        paddingTop: CGFloat = 0,
        paddingBottom: CGFloat = 0,
        minimumHeight explicitMinimumHeight: CGFloat? = nil,
        containerChromeHeight: CGFloat = 0
    ) {
        // A native content size can be under a line for an empty input; one
        // line plus the padding is the least it shows.
        let minimumHeight = max(lineHeight + paddingTop + paddingBottom, explicitMinimumHeight ?? 0)
        let cap = max(0, maxHeight)
        let minimum = min(minimumHeight, cap)
        let measuredHeight = hasText && contentHeight.isFinite ? contentHeight : minimum
        let height = min(cap, max(minimum, measuredHeight))
        self.height = height
        self.containerHeight = height + max(0, containerChromeHeight)
        self.scrollEnabled = measuredHeight >= cap && cap > 0
    }
}
