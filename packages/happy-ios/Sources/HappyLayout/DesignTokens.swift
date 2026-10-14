import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// Design tokens ported from packages/happy-app/sources/theme.ts and the
// component stylesheets, iOS values only. They are plain values so layouts
// and tests can use them; HappyUI turns them into UIColor and UIFont.

/// An sRGB colour with components in 0...1.
public struct RGBA: Equatable, Hashable, Sendable {
    public var red: Double
    public var green: Double
    public var blue: Double
    public var alpha: Double

    public init(red: Double, green: Double, blue: Double, alpha: Double = 1) {
        self.red = red
        self.green = green
        self.blue = blue
        self.alpha = alpha
    }

    /// `#RGB`, `#RRGGBB` or `#RRGGBBAA`, with or without the `#`.
    public init?(hex: String) {
        var digits = Substring(hex)
        if digits.hasPrefix("#") { digits = digits.dropFirst() }
        if digits.count == 3 {
            digits = Substring(digits.map { "\($0)\($0)" }.joined())
        }
        guard digits.count == 6 || digits.count == 8, let value = UInt64(digits, radix: 16) else {
            return nil
        }
        let hasAlpha = digits.count == 8
        let rgb = hasAlpha ? value >> 8 : value
        self.red = Double((rgb >> 16) & 0xFF) / 255
        self.green = Double((rgb >> 8) & 0xFF) / 255
        self.blue = Double(rgb & 0xFF) / 255
        self.alpha = hasAlpha ? Double(value & 0xFF) / 255 : 1
    }

    public static let white = RGBA(red: 1, green: 1, blue: 1)
    public static let black = RGBA(red: 0, green: 0, blue: 0)
    public static let clear = RGBA(red: 0, green: 0, blue: 0, alpha: 0)
    /// What a malformed token literal becomes: loud magenta.
    static let invalid = RGBA(red: 1, green: 0, blue: 1, alpha: 0.999)
}

/// A colour that differs between light and dark appearance.
public struct ColorToken: Equatable, Hashable, Sendable {
    public var light: RGBA
    public var dark: RGBA

    public init(light: RGBA, dark: RGBA) {
        self.light = light
        self.dark = dark
    }

    /// Token tables are literals. A typo turns into `RGBA.invalid`, which
    /// `DesignTokenTests` looks for, rather than a plausible black.
    init(_ light: String, _ dark: String) {
        self.init(light: RGBA(hex: light) ?? .invalid, dark: RGBA(hex: dark) ?? .invalid)
    }

    init(_ both: String) {
        self.init(both, both)
    }

    public static let clear = ColorToken(light: .clear, dark: .clear)
}

public enum Palette {
    public static let text = ColorToken("#000000", "#ffffff")
    public static let textSecondary = ColorToken("#8E8E93", "#8E8E93")
    public static let textDestructive = ColorToken("#FF3B30", "#FF453A")
    public static let textLink = ColorToken("#2BACCC")
    public static let surface = ColorToken("#ffffff", "#161616")
    public static let surfaceHigh = ColorToken("#F8F8F8", "#1E1E1E")
    public static let surfacePressedOverlay = ColorToken("#D1D1D6", "#242424")
    public static let divider = ColorToken("#eaeaea", "#2A2A2A")
    /// Item separators. theme.colors.glass.divider: rgba(60,60,67,0.12) and
    /// rgba(255,255,255,0.08).
    public static let itemDivider = ColorToken(
        light: RGBA(red: 60 / 255, green: 60 / 255, blue: 67 / 255, alpha: 0.12),
        dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.08)
    )
    public static let groupedBackground = ColorToken("#F2F2F7", "#000000")
    public static let groupedChevron = ColorToken("#C7C7CC", "#505050")
    public static let groupedSectionTitle = ColorToken("#8E8E93", "#8E8E93")
    public static let headerBackground = ColorToken("#ffffff", "#000000")
    public static let headerTint = ColorToken("#18171C", "#ffffff")
    public static let inputBackground = ColorToken("#F5F5F5", "#1E1E1E")
    public static let inputText = ColorToken("#000000", "#FFFFFF")
    public static let inputPlaceholder = ColorToken("#999999", "#8E8E93")
    public static let statusConnected = ColorToken("#34C759", "#34C759")
    public static let statusConnecting = ColorToken("#007AFF", "#FFFFFF")
    public static let statusDisconnected = ColorToken("#999999", "#8E8E93")
    public static let statusError = ColorToken("#FF3B30", "#FF453A")
    public static let success = ColorToken("#34C759", "#32D74B")
    public static let warningCritical = ColorToken("#FF3B30", "#FF453A")

    /// RoundButton's filled pill: black in light, a light pill with dark text
    /// in dark, mirroring the dock's send button.
    public static let roundButtonFill = ColorToken("#000000", "#F5F5F5")
    public static let roundButtonFillPressed = ColorToken("#333333", "#D9D9D9")
    public static let roundButtonText = ColorToken("#FFFFFF", "#111111")

    /// Ionicons tints the settings rows use.
    public static let iconBlue = ColorToken("#007AFF")
    public static let iconOrange = ColorToken("#FF9500")
    public static let iconRed = ColorToken("#FF3B30")
    public static let iconPurple = ColorToken("#5856D6")
    public static let iconGreen = ColorToken("#34C759")

    /// The stacked "Happy / Engineering" wordmark.
    public static let wordmarkHappy = ColorToken("#183f38", "#ffffff")
    public static let wordmarkEngineering = ColorToken("#e6522c")

    /// The QR code always sits on white so any scanner can read it.
    public static let qrBackground = ColorToken("#ffffff")
    /// Dimming around the scanner's viewfinder.
    public static let scannerDimming = ColorToken(
        light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.55),
        dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.55)
    )

    /// TerminalBlock.tsx: the terminal on happy.engineering, dark in both
    /// appearances.
    public static let terminalBackground = ColorToken("#14352f")
    public static let terminalBorder = ColorToken("#24463f")
    public static let terminalText = ColorToken("#f0ebe0")
    public static let terminalPrompt = ColorToken("#6fae74")
    public static let terminalComment = ColorToken("#8fae8a")

    /// The flat session list paints rows and page alike: white in light,
    /// the page's own black in dark (FlatSessionRow.tsx
    /// `flatListBackgroundColor`).
    public static let flatListBackground = ColorToken("#FFFFFF", "#000000")
    public static let surfaceSelected = ColorToken("#C6C6C8", "#242424")
    public static let surfaceHighest = ColorToken("#f0f0f0", "#282828")
    /// flatSessionRowPresentation.ts: the agent waits on the person.
    public static let sessionBlockedDot = ColorToken("#FF9500")
    /// flatSessionRowPresentation.ts: a finished turn nobody has seen.
    public static let sessionReadyDot = ColorToken("#007AFF")
    /// theme.colors.radio.active: selected segments and checkmarks.
    public static let radioActive = ColorToken("#007AFF", "#0A84FF")
    /// theme.colors.box.warning.text: the offline plaque's glyph.
    public static let warningText = ColorToken("#FF9500", "#FFAB00")
    public static let iconTeal = ColorToken("#5AC8FA")
    public static let iconViolet = ColorToken("#AF52DE")
    public static let switchOn = ColorToken("#34C759")
    /// theme.colors.glass.backgroundSubtle: the chosen option under an
    /// open dropdown.
    public static let optionSelected = ColorToken(
        light: RGBA(red: 1, green: 1, blue: 1, alpha: 0.42),
        dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.07)
    )
    /// theme.colors.glass.border, around Connect Claude's terminal card.
    public static let glassBorder = ColorToken(
        light: RGBA(red: 1, green: 1, blue: 1, alpha: 0.82),
        dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.14)
    )
    /// Connect Claude's terminal text: Menlo green prompt, white command.
    public static let commandPrompt = ColorToken("#00ff00")
    public static let commandText = ColorToken("#ffffff")
    /// AvatarBrutalist.tsx's black-and-white pair and AvatarGradient's
    /// saturation sheet.
    public static let avatarBrutalistMonoTint = ColorToken("#999999")
    public static let avatarBrutalistMonoBackground = ColorToken("#F0F0F0")
    /// UsageChart.tsx bars.
    public static let usageTokens = ColorToken("#007AFF")
    public static let usageCost = ColorToken("#FF9500")

    public static let all: [ColorToken] = [
        text, textSecondary, textDestructive, textLink, surface, surfaceHigh, surfacePressedOverlay,
        divider, itemDivider, groupedBackground, groupedChevron, groupedSectionTitle, headerBackground,
        headerTint, inputBackground, inputText, inputPlaceholder, statusConnected, statusConnecting,
        statusDisconnected, statusError, success, warningCritical, roundButtonFill, roundButtonFillPressed,
        roundButtonText, iconBlue, iconOrange, iconRed, iconPurple, iconGreen, wordmarkHappy,
        wordmarkEngineering, qrBackground, scannerDimming, terminalBackground, terminalBorder, terminalText,
        terminalPrompt, terminalComment, flatListBackground, surfaceSelected, surfaceHighest, sessionBlockedDot,
        sessionReadyDot, radioActive, warningText, iconTeal, iconViolet, switchOn, optionSelected, glassBorder,
        commandPrompt, commandText, avatarBrutalistMonoTint, avatarBrutalistMonoBackground, usageTokens, usageCost,
    ] + BubblePalette.all.flatMap { [$0.background, $0.border, $0.indicator] }
}

/// A user-message bubble preset (utils/userMessageBubbleColor.ts), shown as
/// a swatch in Settings › Appearance until chat lands.
public struct BubblePalette: Equatable, Sendable {
    public var background: ColorToken
    public var border: ColorToken
    public var indicator: ColorToken

    public static let gray = BubblePalette(background: ColorToken("#f0eee6", "#2C2C2E"), border: ColorToken("#f0eee6", "#2C2C2E"), indicator: ColorToken("#8E8E93", "#8E8E93"))
    public static let blue = BubblePalette(background: ColorToken("#E8F2FF", "#17324D"), border: ColorToken("#9CC9FF", "#2F6EA8"), indicator: ColorToken("#0A84FF", "#64B5FF"))
    public static let green = BubblePalette(background: ColorToken("#E9F7EF", "#173A27"), border: ColorToken("#96D6AE", "#3D8B58"), indicator: ColorToken("#34C759", "#65D385"))
    public static let purple = BubblePalette(background: ColorToken("#F0EBFF", "#2B214A"), border: ColorToken("#B7A2FF", "#7D68CF"), indicator: ColorToken("#7D68CF", "#B8A8FF"))
    public static let rose = BubblePalette(background: ColorToken("#FFF0F5", "#462232"), border: ColorToken("#F3A4BF", "#C85E82"), indicator: ColorToken("#D85D85", "#FF9DBB"))
    public static let sand = BubblePalette(background: ColorToken("#F1E7D0", "#3A3326"), border: ColorToken("#D9C292", "#8D7A55"), indicator: ColorToken("#B28B3D", "#E8C878"))

    /// In `USER_MESSAGE_BUBBLE_COLORS` order.
    public static let all: [BubblePalette] = [gray, blue, green, purple, rose, sand]
}

/// The bundled typefaces. Raw values are PostScript names, which is what
/// `UIFont(name:size:)` takes.
public enum FontFace: String, CaseIterable, Sendable {
    case regular = "IBMPlexSans-Regular"
    case italic = "IBMPlexSans-Italic"
    case semiBold = "IBMPlexSans-SemiBold"
    case mono = "IBMPlexMono-Regular"
    case monoItalic = "IBMPlexMono-Italic"
    case monoSemiBold = "IBMPlexMono-SemiBold"
    case logo = "BricolageGrotesque-Bold"

    /// The file in HappyUI's Resources/Fonts that holds this face.
    public var fileName: String { rawValue + ".ttf" }
}

public struct TextStyle: Equatable, Hashable, Sendable {
    public var face: FontFace
    public var size: CGFloat
    /// Fixed line height; nil leaves the font's own.
    public var lineHeight: CGFloat?
    public var letterSpacing: CGFloat
    public var uppercase: Bool
    /// `maxFontSizeMultiplier`: the most the person's text size may grow
    /// this style; nil lets it grow as far as the setting goes.
    public var maxScale: CGFloat?

    public init(_ face: FontFace, size: CGFloat, lineHeight: CGFloat? = nil, letterSpacing: CGFloat = 0, uppercase: Bool = false, maxScale: CGFloat? = nil) {
        self.face = face
        self.size = size
        self.lineHeight = lineHeight
        self.letterSpacing = letterSpacing
        self.uppercase = uppercase
        self.maxScale = maxScale
    }
}

public enum TextStyles {
    // Item (components/Item.tsx)
    public static let itemTitle = TextStyle(.regular, size: 17, lineHeight: 22, letterSpacing: -0.41)
    public static let itemSubtitle = TextStyle(.regular, size: 15, lineHeight: 20, letterSpacing: -0.24)
    public static let itemDetail = TextStyle(.regular, size: 17, letterSpacing: -0.41)

    // ItemGroup (components/ItemGroup.tsx)
    public static let groupHeader = TextStyle(.regular, size: 13, lineHeight: 18, letterSpacing: -0.08, uppercase: true)
    public static let groupFooter = TextStyle(.regular, size: 13, lineHeight: 18, letterSpacing: -0.08)

    // Navigation header (components/onboarding/OnboardingHeader.tsx)
    public static let headerTitle = TextStyle(.semiBold, size: 16, lineHeight: 20)
    /// UIKit's header title through react-native-screens: semibold at its
    /// default 17, which no `headerTitleStyle` in happy-app overrides.
    public static let nativeHeaderTitle = TextStyle(.semiBold, size: 17)
    public static let headerSubtitle = TextStyle(.regular, size: 11, lineHeight: 14)

    // First run (components/onboarding/OnboardingContent.tsx)
    /// OnboardingContent.tsx `TITLE_MAX_SCALE`: grows at most 1.2 times.
    public static let onboardingTitle = TextStyle(.semiBold, size: 28, lineHeight: 34, maxScale: 1.2)
    public static let onboardingProp = TextStyle(.regular, size: 17, lineHeight: 24)
    public static let checklistTitle = TextStyle(.semiBold, size: 17, lineHeight: 22)
    public static let checklistBody = TextStyle(.regular, size: 15, lineHeight: 21)
    public static let onboardingError = TextStyle(.regular, size: 15, lineHeight: 20)
    public static let getHelp = TextStyle(.semiBold, size: 15, lineHeight: 20)
    /// The offline checklist's title and the troubleshoot heading.
    public static let emptyStateTitle = TextStyle(.semiBold, size: 24, lineHeight: 30)
    public static let terminalLine = TextStyle(.mono, size: 14, lineHeight: 24)
    public static let promptHint = TextStyle(.regular, size: 13, lineHeight: 18)

    // Restore (app/(app)/restore/index.tsx and manual.tsx)
    public static let restoreInstruction = TextStyle(.regular, size: 17, lineHeight: 22)
    public static let restorePath = TextStyle(.regular, size: 15, lineHeight: 20)
    public static let secretKeyInput = TextStyle(.mono, size: 15, lineHeight: 22)

    // Server (app/(app)/server.tsx)
    public static let fieldLabel = TextStyle(.semiBold, size: 12, letterSpacing: 0.5, uppercase: true)
    public static let serverInput = TextStyle(.mono, size: 15)
    public static let fieldError = TextStyle(.regular, size: 12)
    public static let fieldStatus = TextStyle(.regular, size: 12)

    // Secret key reveal (app/(app)/settings/account.tsx)
    public static let secretKeyLabel = TextStyle(.semiBold, size: 11, letterSpacing: 0.5, uppercase: true)
    public static let secretKeyValue = TextStyle(.mono, size: 13, lineHeight: 20, letterSpacing: 0.5)

    // Flat session list (components/FlatSessionRow.tsx, SessionsList.tsx)
    public static let sessionTitle = TextStyle(.semiBold, size: 17, lineHeight: 22)
    public static let sessionTimestamp = TextStyle(.regular, size: 13, lineHeight: 22)
    public static let sessionProject = TextStyle(.regular, size: 15, lineHeight: 20)
    public static let sessionWorkspace = TextStyle(.regular, size: 13, lineHeight: 18)
    /// Happy Agent's line counts at the end of the workspace's row
    /// (GitLineChanges.tsx): 11, no line height, "≈" in the default face.
    /// "+12" and "-3" ask for weight 600 with the default family,
    /// 'IBMPlexSans-Regular'. That family is expo-font's alias for the one
    /// face of that name, so RN's closest weight (RCTFontUtils.mm
    /// `RCTFontWithFontProperties`) has only Plex Regular to choose: iOS
    /// draws all three in the regular face.
    public static let sessionLineChanges = TextStyle(.regular, size: 11)
    public static let sessionDayHeader = TextStyle(.semiBold, size: 14, lineHeight: 18, letterSpacing: 0.1)
    public static let archiveToggle = TextStyle(.regular, size: 14, lineHeight: 18)
    public static let swipeAction = TextStyle(.semiBold, size: 12, lineHeight: 15)

    // Empty home (components/EmptyMainScreen.tsx)
    public static let emptyStateDescription = TextStyle(.regular, size: 16, lineHeight: 22)
    public static let secondaryAction = TextStyle(.semiBold, size: 15, lineHeight: 20)

    // Settings header with a profile (components/SettingsView.tsx)
    public static let profileName = TextStyle(.semiBold, size: 20, lineHeight: 25)
    public static let profileBio = TextStyle(.regular, size: 14, lineHeight: 19)

    // Option rows under a dropdown (settings/appearance.tsx)
    public static let optionTitle = TextStyle(.regular, size: 16, lineHeight: 21)
    public static let dropdownValue = TextStyle(.regular, size: 15, lineHeight: 20)

    // Usage (components/usage)
    public static let usagePeriod = TextStyle(.semiBold, size: 14, lineHeight: 18)
    public static let usageStatLabel = TextStyle(.regular, size: 16, lineHeight: 21)
    public static let usageStatValue = TextStyle(.semiBold, size: 20, lineHeight: 25)
    public static let usageSectionTitle = TextStyle(.semiBold, size: 18, lineHeight: 23)
    public static let usageBarLabel = TextStyle(.regular, size: 14, lineHeight: 18)
    public static let usageBarValue = TextStyle(.semiBold, size: 14, lineHeight: 18)
    public static let usageChartLabel = TextStyle(.semiBold, size: 10, lineHeight: 13)
    public static let usageError = TextStyle(.regular, size: 14, lineHeight: 18)

    // What's New (app/(app)/changelog.tsx, MarkdownView's text and lists)
    public static let changelogTitle = TextStyle(.semiBold, size: 20, lineHeight: 28)
    public static let changelogSummary = TextStyle(.regular, size: 16, lineHeight: 23)
    public static let changelogBody = TextStyle(.regular, size: 16, lineHeight: 25)
    public static let changelogBold = TextStyle(.semiBold, size: 16, lineHeight: 25)

    // Connect Claude (settings/connect/claude.tsx)
    public static let connectTitle = TextStyle(.semiBold, size: 18, lineHeight: 23)
    public static let connectBody = TextStyle(.regular, size: 14, lineHeight: 19)
    public static let connectCommand = TextStyle(.mono, size: 14, lineHeight: 19)

    // QR scanner, which happy-app leaves to the system scanner.
    public static let scannerHint = TextStyle(.semiBold, size: 17, lineHeight: 22)
    public static let scannerMessage = TextStyle(.regular, size: 17, lineHeight: 22)

    public static func roundButton(_ size: RoundButtonSize, display: RoundButtonDisplay) -> TextStyle {
        let metrics = RoundButtonMetrics.of(size)
        // The inverted (text) action is regular weight; filled pills are
        // semibold. Line height is round(fontSize × 1.3).
        return TextStyle(display == .inverted ? .regular : .semiBold, size: metrics.fontSize, lineHeight: metrics.lineHeight)
    }
}

public enum Spacing {
    public static let xs: CGFloat = 4
    public static let s: CGFloat = 8
    public static let m: CGFloat = 12
    public static let l: CGFloat = 16
    public static let xl: CGFloat = 20
    public static let xxl: CGFloat = 24
}

public enum Radius {
    public static let xs: CGFloat = 4
    public static let s: CGFloat = 8
    public static let m: CGFloat = 10
    public static let l: CGFloat = 12
    public static let xl: CGFloat = 16
    /// ItemGroup cards.
    public static let group: CGFloat = 14
}
