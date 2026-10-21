import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// The chat's tokens: theme.ts colours and the stylesheets of MessageView,
// MarkdownView, SimpleSyntaxHighlighter, the tool views, PermissionFooter,
// the question and goal bars and ChatHeaderView (iOS values).
//
// Much of happy-app's chat text is a plain React Native <Text> with no font
// family, which iOS draws in San Francisco, and terminal text asks for Menlo.
// `FontFace` only names the bundled IBM Plex faces, so chat text styles carry
// a `ChatFace` that can say either.

public enum ChatFace: Hashable, Sendable {
    /// A bundled IBM Plex face (`Typography.default()` / `mono()`).
    case plex(FontFace)
    /// React Native's default font: the system font at a weight.
    case system(ChatWeight)
    /// `fontStyle: 'italic'` on React Native's default font.
    case systemItalic
    /// `Platform.select({ ios: 'Menlo' })`.
    case menlo
    /// Menlo at weight '600', which iOS draws in Menlo Bold.
    case menloBold
    /// Menlo with `fontStyle: 'italic'`.
    case menloItalic

    public var isMonospaced: Bool {
        switch self {
        case .plex(let face): face == .mono || face == .monoItalic || face == .monoSemiBold
        case .system, .systemItalic: false
        case .menlo, .menloBold, .menloItalic: true
        }
    }
}

/// CSS font weights as React Native maps them on iOS.
public enum ChatWeight: Hashable, Sendable {
    case regular
    /// '500'
    case medium
    /// '600'
    case semibold
    /// '700' and above
    case bold
}

public struct ChatTextStyle: Hashable, Sendable {
    public var face: ChatFace
    public var size: CGFloat
    /// Fixed line height; nil leaves the font's own.
    public var lineHeight: CGFloat?
    public var letterSpacing: CGFloat
    public var uppercase: Bool
    /// `maxFontSizeMultiplier`, as on `TextStyle`.
    public var maxScale: CGFloat?

    public init(_ face: ChatFace, size: CGFloat, lineHeight: CGFloat? = nil, letterSpacing: CGFloat = 0, uppercase: Bool = false, maxScale: CGFloat? = nil) {
        self.face = face
        self.size = size
        self.lineHeight = lineHeight
        self.letterSpacing = letterSpacing
        self.uppercase = uppercase
        self.maxScale = maxScale
    }

    public init(_ style: TextStyle) {
        self.init(
            .plex(style.face),
            size: style.size,
            lineHeight: style.lineHeight,
            letterSpacing: style.letterSpacing,
            uppercase: style.uppercase,
            maxScale: style.maxScale
        )
    }

    public func with(_ face: ChatFace) -> ChatTextStyle {
        var copy = self
        copy.face = face
        return copy
    }
}

extension Palette {
    // Message view (theme.ts "Message View colors")
    public static let userMessageText = ColorToken("#000000", "#FFFFFF")
    public static let agentEventText = ColorToken("#666666", "#8E8E93")
    public static let surfacePressed = ColorToken("#f0f0f2", "#242424")
    /// theme.colors.warning: the tool error glyph.
    public static let warning = ColorToken("#8E8E93")

    // Boxes (theme.colors.box)
    public static let boxWarningBackground = ColorToken(light: RGBA(hex: "#FFF8F0")!, dark: RGBA(red: 1, green: 159 / 255, blue: 10 / 255, alpha: 0.15))
    public static let boxErrorBackground = ColorToken(light: RGBA(hex: "#FFF0F0")!, dark: RGBA(red: 1, green: 69 / 255, blue: 58 / 255, alpha: 0.15))
    public static let boxErrorBorder = ColorToken("#FF3B30", "#FF453A")
    public static let boxErrorText = ColorToken("#FF3B30", "#FF6B6B")

    // Code and syntax (theme.ts "Code/Syntax colors")
    public static let syntaxKeyword = ColorToken("#1d4ed8", "#569CD6")
    public static let syntaxString = ColorToken("#059669", "#CE9178")
    public static let syntaxComment = ColorToken("#6b7280", "#6A9955")
    public static let syntaxNumber = ColorToken("#0891b2", "#B5CEA8")
    public static let syntaxFunction = ColorToken("#9333ea", "#DCDCAA")
    public static let syntaxBracket1 = ColorToken("#ff6b6b", "#FFD700")
    public static let syntaxBracket2 = ColorToken("#4ecdc4", "#DA70D6")
    public static let syntaxBracket3 = ColorToken("#45b7d1", "#179FFF")
    public static let syntaxBracket4 = ColorToken("#f7b731", "#FF8C00")
    public static let syntaxBracket5 = ColorToken("#5f27cd", "#00FF00")
    public static let syntaxDefault = ColorToken("#374151", "#D4D4D4")

    // Git (the header's change counts)
    public static let gitBranchText = ColorToken("#6b7280", "#8E8E93")
    public static let gitAddedText = ColorToken("#22c55e", "#34C759")
    public static let gitRemovedText = ColorToken("#ef4444", "#FF453A")

    // Terminal (CommandView)
    public static let terminalPanel = ColorToken("#1E1E1E")
    public static let terminalPromptGreen = ColorToken("#34C759", "#32D74B")
    public static let terminalCommand = ColorToken("#E0E0E0")
    public static let terminalStdout = ColorToken("#E0E0E0")
    public static let terminalStderr = ColorToken("#FFB86C")
    public static let terminalError = ColorToken("#FF5555", "#FF6B6B")
    public static let terminalEmptyOutput = ColorToken("#6272A4", "#7B7B93")

    // Diffs in tool views (theme.colors.diff, renderer palette)
    public static let diffRowAdded = ColorToken("#E6FFEC", "#12261E")
    public static let diffRowRemoved = ColorToken("#FFEBE9", "#25171C")
    public static let diffMarkerAdded = ColorToken("#1A7F37", "#3FB950")
    public static let diffMarkerRemoved = ColorToken("#CF222E", "#F85149")
    public static let diffText = ColorToken("#1F2328", "#E6EDF3")
    public static let diffSectionText = ColorToken("#6E7781", "#8B949E")
    public static let diffGutterBorder = ColorToken("#D8DEE4", "#21262D")

    /// theme.colors.box.warning.text: ToolError's glyph for a refused call.
    public static let boxWarningText = ColorToken("#FF9500", "#FFAB00")

    // TodoView.tsx (fixed colours, the same in both themes)
    public static let todoCompleted = ColorToken("#34C759")
    public static let todoInProgress = ColorToken("#007AFF")
    public static let todoPending = ColorToken("#666666")
    public static let todoOther = ColorToken("#000000")

    /// White on an accent fill (a ticked checkbox, the answer sheet's button).
    public static let onAccent = ColorToken("#FFFFFF")
    /// The answer sheet's required-question dot.
    public static let requiredDot = ColorToken("#FF9500")
    /// ToolFullView's section glyphs: #5856D6 (description, input),
    /// #34C759 (output), #FF3B30 (error), #FF9500 (raw JSON);
    /// MultiEditViewFull's edit number and replace-all badge are the purple
    /// too, its separator #E5E5EA.
    public static let fullViewPurple = ColorToken("#5856D6")
    public static let fullViewGreen = ColorToken("#34C759")
    public static let fullViewRed = ColorToken("#FF3B30")
    public static let fullViewOrange = ColorToken("#FF9500")
    public static let multiEditSeparator = ColorToken("#E5E5EA")
    /// ChatHeaderView's subtitle in the glass capsule: rgba(24,23,28,0.72)
    /// in light, rgba(255,255,255,0.78) in dark.
    public static let headerGlassSubtitle = ColorToken(
        light: RGBA(red: 24 / 255, green: 23 / 255, blue: 28 / 255, alpha: 0.72),
        dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.78)
    )

    /// theme.colors.button.secondary.tint: the goal bar's action glyphs.
    public static let buttonSecondaryTint = ColorToken("#666666", "#8E8E93")
    /// theme.colors.shadow: the scroll-to-bottom button.
    public static let shadow = ColorToken("#000000")
    /// The CLI version warning's pill, the same in both themes: its fill,
    /// its label and close glyph, and its warning glyph.
    public static let cliWarningFill = ColorToken("#FFF3CD")
    public static let cliWarningText = ColorToken("#856404")
    public static let cliWarningIcon = ColorToken("#FF9500")
    /// SessionView's floating back button on a phone held sideways:
    /// rgba(255,255,255,0.9) in light, rgba(28,23,28,0.9) in dark, and a
    /// black chevron in both (happy-app's own choice, kept).
    public static let landscapeBackFill = ColorToken(
        light: RGBA(red: 1, green: 1, blue: 1, alpha: 0.9),
        dark: RGBA(red: 28 / 255, green: 23 / 255, blue: 28 / 255, alpha: 0.9)
    )
    public static let landscapeBackGlyph = ColorToken("#000000")
    /// WorktreeTabStrip's open tab: a translucent chip, so it doesn't punch
    /// a hole in the glass, rgba(0,0,0,0.07) in light and
    /// rgba(255,255,255,0.14) in dark.
    public static let worktreeTabSelected = ColorToken(
        light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.07),
        dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.14)
    )

    public static let chat: [ColorToken] = [
        userMessageText, agentEventText, surfacePressed, warning, boxWarningBackground, boxErrorBackground,
        boxErrorBorder, boxErrorText, syntaxKeyword, syntaxString, syntaxComment, syntaxNumber, syntaxFunction,
        syntaxBracket1, syntaxBracket2, syntaxBracket3, syntaxBracket4, syntaxBracket5, syntaxDefault,
        gitBranchText, gitAddedText, gitRemovedText, terminalPanel, terminalPromptGreen, terminalCommand,
        terminalStdout, terminalStderr, terminalError, terminalEmptyOutput, diffRowAdded, diffRowRemoved,
        diffMarkerAdded, diffMarkerRemoved, diffText, diffSectionText, diffGutterBorder, buttonSecondaryTint, shadow,
        boxWarningText, todoCompleted, todoInProgress, todoPending, todoOther, onAccent, requiredDot,
        headerGlassSubtitle, fullViewPurple, fullViewGreen, fullViewRed, fullViewOrange, multiEditSeparator,
        cliWarningFill, cliWarningText, cliWarningIcon, landscapeBackFill, landscapeBackGlyph,
        worktreeTabSelected,
    ]
}

/// The chat's text styles, by the component they come from.
public enum ChatTextStyles {
    // MarkdownView.tsx
    public static let markdownText = ChatTextStyle(.plex(.regular), size: 16, lineHeight: 25)
    public static let markdownBold = ChatTextStyle(.plex(.semiBold), size: 16, lineHeight: 25)
    public static let markdownItalic = ChatTextStyle(.plex(.italic), size: 16, lineHeight: 25)
    public static let markdownCode = ChatTextStyle(.plex(.mono), size: 16, lineHeight: 24)
    /// header1 is weight 900, header2–6 600; IBM Plex SemiBold draws both.
    public static func markdownHeader(_ level: Int) -> ChatTextStyle {
        switch level {
        case 1: ChatTextStyle(.plex(.semiBold), size: 16, lineHeight: 24)
        case 2: ChatTextStyle(.plex(.semiBold), size: 20, lineHeight: 24)
        case 3: ChatTextStyle(.plex(.semiBold), size: 16, lineHeight: 28)
        default: ChatTextStyle(.plex(.semiBold), size: 16, lineHeight: 24)
        }
    }
    public static let codeBlock = ChatTextStyle(.plex(.mono), size: 14, lineHeight: 20)
    public static let codeLanguage = ChatTextStyle(.plex(.mono), size: 12)
    public static let codeCopy = ChatTextStyle(.plex(.regular), size: 12, lineHeight: 16)
    public static let tableHeader = ChatTextStyle(.plex(.semiBold), size: 16, lineHeight: 24)
    public static let tableCell = ChatTextStyle(.plex(.regular), size: 16, lineHeight: 24)
    public static let option = ChatTextStyle(.plex(.regular), size: 16, lineHeight: 24)
    public static let imageCaption = ChatTextStyle(.plex(.regular), size: 14, lineHeight: 20)

    // MessageView.tsx
    public static let userAuthor = ChatTextStyle(.plex(.semiBold), size: 14, lineHeight: 20)
    public static let pendingStatus = ChatTextStyle(.plex(.regular), size: 11, lineHeight: 14)
    public static let agentEvent = ChatTextStyle(.system(.regular), size: 14)
    public static let goalSent = ChatTextStyle(.system(.regular), size: 14)
    public static let commandChip = ChatTextStyle(.menlo, size: 13)
    /// The compact "unsupported message" row: an event line, smaller.
    public static let unsupported = ChatTextStyle(.system(.regular), size: 13)

    // ToolView.tsx
    public static let toolName = ChatTextStyle(.system(.medium), size: 14)
    public static let toolStatus = ChatTextStyle(.system(.regular), size: 15)
    public static let toolDescription = ChatTextStyle(.system(.regular), size: 13)
    public static let toolElapsed = ChatTextStyle(.menlo, size: 13)
    public static let compactActivity = ChatTextStyle(.system(.regular), size: 15, lineHeight: 20)
    // TodoView.tsx, TaskView.tsx (TaskView asks for 'monospace', which iOS
    // doesn't have, so React Native draws the system font)
    public static let todo = ChatTextStyle(.system(.regular), size: 14)
    public static let taskItem = ChatTextStyle(.system(.medium), size: 14)
    public static let taskMore = ChatTextStyle(.systemItalic, size: 14)
    // ToolSectionView.tsx, ToolError.tsx, CodeView.tsx
    public static let toolSectionTitle = ChatTextStyle(.system(.semibold), size: 13, uppercase: true)
    public static let toolError = ChatTextStyle(.system(.regular), size: 13)
    public static let codeView = ChatTextStyle(.menlo, size: 12, lineHeight: 18)
    // CommandView.tsx
    public static let terminal = ChatTextStyle(.menlo, size: 13, lineHeight: 18)
    public static let terminalPrompt = ChatTextStyle(.menloBold, size: 14, lineHeight: 20)
    public static let terminalCommand = ChatTextStyle(.menlo, size: 14, lineHeight: 20)
    // CodexBashView.tsx ('monospace' is not an iOS font, so React Native
    // draws the system font), GeminiExecuteView.tsx
    public static let toolOperation = ChatTextStyle(.system(.medium), size: 14)
    public static let toolOperationCommand = ChatTextStyle(.system(.regular), size: 12)
    public static let executeCwd = ChatTextStyle(.system(.regular), size: 12)
    public static let executeDescription = ChatTextStyle(.systemItalic, size: 13)
    // FileView.tsx: the attachment's name under its picture.
    public static let attachmentName = ChatTextStyle(.system(.medium), size: 13)

    // PermissionFooter.tsx
    public static let permissionButton = ChatTextStyle(.system(.medium), size: 14, lineHeight: 18)
    public static let permissionButtonSettled = ChatTextStyle(.system(.regular), size: 14, lineHeight: 18)

    // AgentWorkGroupHeader.tsx
    public static let workGroup = ChatTextStyle(.system(.regular), size: 13, lineHeight: 20)

    // AgentQuestionBanner.tsx
    public static let bannerTitle = ChatTextStyle(.plex(.semiBold), size: 14)
    public static let bannerSubtitle = ChatTextStyle(.plex(.regular), size: 13)
    public static let bannerDismiss = ChatTextStyle(.plex(.semiBold), size: 14)

    // AgentGoalBar.tsx
    public static let goalLabel = ChatTextStyle(.system(.semibold), size: 12, lineHeight: 16)
    public static let goalText = ChatTextStyle(.system(.regular), size: 14, lineHeight: 19)

    // RigActivityBar.tsx, ChatFooter.tsx
    public static let rigActivity = ChatTextStyle(.plex(.regular), size: 11)
    public static let chatFooterWarning = ChatTextStyle(.plex(.regular), size: 12)

    // ChatHeaderView.tsx, in the glass capsule (mobileSubtitle: 14 high)
    public static let headerTitle = ChatTextStyle(.plex(.semiBold), size: 16, lineHeight: 20)
    public static let headerSubtitle = ChatTextStyle(.plex(.regular), size: 12, lineHeight: 14)
    /// Without glass (a tablet) the subtitle keeps its own 16.
    public static let headerPlainSubtitle = ChatTextStyle(.plex(.regular), size: 12, lineHeight: 16)

    // EmptyMessages.tsx
    public static let emptyHost = ChatTextStyle(.plex(.semiBold), size: 18)
    public static let emptyPath = ChatTextStyle(.plex(.regular), size: 14)
    public static let emptyTitle = ChatTextStyle(.plex(.regular), size: 20)
    public static let emptyCreated = ChatTextStyle(.plex(.regular), size: 16, lineHeight: 24)

    // SessionView's CLI version warning (a plain <Text>: the system font)
    public static let cliWarning = ChatTextStyle(.system(.semibold), size: 12)

    // CodexPatchView's move destination: `fontFamily: 'monospace'`, which
    // React Native on iOS doesn't know, so the system font
    public static let patchMovePath = ChatTextStyle(.system(.regular), size: 12)

    // PendingChatPlaceholder.tsx; its folder line is emptyPath's 14
    public static let pendingQueued = ChatTextStyle(.plex(.regular), size: 15, lineHeight: 21)

    // InlineQuestionForm.tsx (plain <Text>: the system font)
    public static let inlineQuestionHeader = ChatTextStyle(.system(.semibold), size: 12, uppercase: true)
    public static let inlineQuestionText = ChatTextStyle(.system(.medium), size: 15)
    public static let inlineOptionLabel = ChatTextStyle(.system(.medium), size: 14)
    public static let inlineOptionDescription = ChatTextStyle(.system(.regular), size: 13)
    public static let inlineSubmit = ChatTextStyle(.system(.semibold), size: 14)
    public static let inlineSubmittedHeader = ChatTextStyle(.system(.semibold), size: 13)
    public static let inlineSubmittedValue = ChatTextStyle(.system(.regular), size: 13)

    // AgentQuestionModal.tsx
    public static let sheetAction = ChatTextStyle(.plex(.regular), size: 16)
    public static let sheetTitle = ChatTextStyle(.plex(.semiBold), size: 16)
    public static let sheetChip = ChatTextStyle(.plex(.semiBold), size: 12, uppercase: true)
    public static let sheetQuestion = ChatTextStyle(.plex(.semiBold), size: 17)
    public static let sheetHint = ChatTextStyle(.plex(.regular), size: 13)
    public static let sheetOptionLabel = ChatTextStyle(.plex(.semiBold), size: 15)
    public static let sheetOptionDescription = ChatTextStyle(.plex(.regular), size: 13)
    public static let sheetCustomLabel = ChatTextStyle(.plex(.semiBold), size: 13)
    /// A TextInput with no font family: the system font.
    public static let sheetInput = ChatTextStyle(.system(.regular), size: 15)
    public static let sheetError = ChatTextStyle(.plex(.regular), size: 14)
    public static let sheetSubmit = ChatTextStyle(.plex(.semiBold), size: 16)

    // The message screen: ToolFullView, MultiEditViewFull, CommandView's
    // output and [messageId].tsx's text (plain <Text>s are the system font)
    public static let fullSectionTitle = ChatTextStyle(.system(.semibold), size: 17)
    public static let fullDescription = ChatTextStyle(.system(.regular), size: 14, lineHeight: 20)
    public static let fullError = ChatTextStyle(.system(.regular), size: 14, lineHeight: 20)
    public static let fullEmptyTitle = ChatTextStyle(.system(.semibold), size: 16)
    public static let fullEmptySubtitle = ChatTextStyle(.system(.regular), size: 14)
    public static let multiEditNumber = ChatTextStyle(.system(.semibold), size: 14)
    public static let multiEditBadge = ChatTextStyle(.system(.semibold), size: 12)
    public static let terminalEmptyOutput = ChatTextStyle(.menloItalic, size: 13, lineHeight: 18)
    public static let detailMessage = ChatTextStyle(.plex(.regular), size: 16, lineHeight: 24)

    // InactiveArchivedHint (plain <Text>s: the system font)
    public static let inactiveHint = ChatTextStyle(.system(.regular), size: 13, lineHeight: 18)
    public static let resumeButton = ChatTextStyle(.system(.semibold), size: 15)
    public static let resumeCommand = ChatTextStyle(.menlo, size: 13, lineHeight: 18)

    // LongPressCopyable's menu and the text selection screen
    public static let copyMenuLabel = ChatTextStyle(.plex(.regular), size: 15, lineHeight: 20)
    public static let textSelection = ChatTextStyle(.plex(.mono), size: 14, lineHeight: 20)
    public static let textSelectionLoading = ChatTextStyle(.plex(.regular), size: 16)

    // The session deleted state (SessionView.tsx)
    public static let deletedTitle = ChatTextStyle(.system(.semibold), size: 20)
    public static let deletedBody = ChatTextStyle(.system(.regular), size: 15)
}

extension TextStyles {
    /// PendingChatPlaceholder's shimmering "Starting a new chat…".
    public static let pendingChatTitle = TextStyle(.semiBold, size: 18)
    /// WorktreeTabStrip's tab name, semibold on the open tab.
    public static let worktreeTab = TextStyle(.regular, size: 14, lineHeight: 18)
    public static let worktreeTabSelected = TextStyle(.semiBold, size: 14, lineHeight: 18)
}
