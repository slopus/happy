import Foundation

// The first screen (StartViewController, Android's ui/start): words straight
// on the Grain Gradient, in its palette.

extension Palette {
    /// The gradient's text: #14112E over the light tints, white over the
    /// dark colours (AA or better on every one of them).
    public static let startText = ColorToken("#14112E", "#FFFFFF")
    /// A slide's line under its title: the text at 87%, still AA (4.6:1
    /// at least) on every colour of the gradient.
    public static let startTextSecondary = ColorToken("#14112EDE", "#FFFFFFDE")
    /// The dots of the slides not showing.
    public static let startDot = ColorToken("#14112E40", "#FFFFFF4D")
}

extension TextStyles {
    /// A slide's title: onboarding's title, capped at 1.2 as it is.
    public static let startSlideTitle = TextStyles.onboardingTitle
    /// A slide's line: grown no further than keeps its title the larger
    /// (`CloudStageLayout.Metrics.bodyMaxScale`).
    public static let startSlideBody = TextStyle(.regular, size: 17, lineHeight: 24, maxScale: CloudStageLayout.Metrics.bodyMaxScale)
    /// A Happy Cloud step's lines: a slide's, and what the step asks for
    /// stays in sight.
    public static let cloudStageBody = startSlideBody
}
