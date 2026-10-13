import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// Tokens for session info, the machine screen, the file viewer and the diff
// renderer: theme.ts (iOS values) and the colours those screens hard-code.
// Kept in their own namespaces so they can't collide with `Palette`
// extensions other workstreams add.

public enum SecondaryPalette {
    /// theme.colors.gitAddedText / gitRemovedText (GitLineChanges).
    public static let gitAdded = ColorToken("#22c55e", "#34C759")
    public static let gitRemoved = ColorToken("#ef4444", "#FF453A")

    // Fixed icon tints info.tsx and machine/[id].tsx pass to Ionicons.
    public static let blue = ColorToken("#007AFF")
    public static let purple = ColorToken("#5856D6")
    public static let red = ColorToken("#FF3B30")
    public static let orange = ColorToken("#FF9500")
    public static let green = ColorToken("#34C759")
    public static let gray = ColorToken("#8E8E93")
    public static let yellow = ColorToken("#FFCC00")
    public static let claude = ColorToken("#9C27B0")
    public static let codex = ColorToken("#10A37F")
    /// CopyableItem's check and the resume command's icon.
    public static let copied = ColorToken("#30D158")
    /// The machine screen's session rows draw their own chevron in this.
    public static let chevron = ColorToken("#C7C7CC")
    /// "Machine not found".
    public static let notFound = ColorToken("#666666")
    /// file.tsx's binary file name.
    public static let fileName = ColorToken("#999999")

    // DuplicateSheet.tsx.
    /// theme.colors.glass.overlay: the sheet's background on iOS.
    public static let sheetOverlay = ColorToken(
        light: RGBA(red: 245 / 255, green: 245 / 255, blue: 248 / 255, alpha: 0.58),
        dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.72)
    )
    /// BaseModal's backdrop dim, over its blur.
    public static let backdropDim = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.42), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.42))
    /// theme.colors.button.primary.
    public static let buttonPrimary = ColorToken("#000000")
    public static let buttonPrimaryTint = ColorToken("#FFFFFF")
    /// MobileGlassSurface's liquid sheen: a diagonal white gradient at
    /// `sheenLocations`, top left to bottom right.
    public static let sheen: [ColorToken] = [
        ColorToken(light: RGBA(red: 1, green: 1, blue: 1, alpha: 0.76), dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.12)),
        ColorToken(light: RGBA(red: 1, green: 1, blue: 1, alpha: 0.10), dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.018)),
        ColorToken(light: RGBA(red: 1, green: 1, blue: 1, alpha: 0.42), dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.055)),
    ]
    public static let sheenLocations: [Double] = [0, 0.48, 1]

    public static let all: [ColorToken] = [
        gitAdded, gitRemoved, blue, purple, red, orange, green, gray, yellow, claude, codex, copied, chevron, notFound, fileName,
        sheetOverlay, backdropDim, buttonPrimary, buttonPrimaryTint,
    ] + sheen
}

/// DuplicateSheet.tsx's materials. expo-blur runs its effect to
/// `intensity / 100`.
public enum DuplicateSheetMaterial {
    /// BaseModal's AnimatedBlurBackdrop: intensity 44, the regular material.
    public static let backdropBlurFraction: CGFloat = 0.44
    /// BaseModal: the content fades in from 0.9 scale over 200 ms.
    public static let appearScale: CGFloat = 0.9
    public static let appearDuration: Double = 0.2
    /// The buttons, pressed and disabled.
    public static let pressedOpacity: CGFloat = 0.7
    public static let disabledOpacity: CGFloat = 0.4
}

/// theme.colors.diff: the renderer palette (components/diff) and the
/// traditional colours file.tsx's diff mode uses.
public enum DiffPalette {
    public static let rowAdded = ColorToken("#E6FFEC", "#12261E")
    public static let rowRemoved = ColorToken("#FFEBE9", "#25171C")
    public static let rowContext = ColorToken.clear
    public static let gutterAdded = ColorToken("#CCFFD8", "#1B4721")
    public static let gutterRemoved = ColorToken("#FFD7D5", "#78191B")
    public static let gutterContext = ColorToken.clear
    public static let gutterBorder = ColorToken("#D8DEE4", "#21262D")
    public static let lineNumber = ColorToken("#959DA5", "#6E7681")
    public static let markerAdded = ColorToken("#1A7F37", "#3FB950")
    public static let markerRemoved = ColorToken("#CF222E", "#F85149")
    public static let wordAdded = ColorToken("#ABF2BC", "#1F6F2E")
    public static let wordRemoved = ColorToken("#FFC1C0", "#8B2C2F")
    public static let hunkBackground = ColorToken("#F1F8FF", "#161B22")
    public static let hunkText = ColorToken("#005CC5", "#58A6FF")
    public static let sectionText = ColorToken("#6E7781", "#8B949E")

    // Traditional colours (file.tsx DiffDisplay).
    public static let addedBackground = ColorToken("#E6FFED", "#0D2E1F")
    public static let addedBorder = ColorToken("#34D058", "#3FB950")
    public static let addedText = ColorToken("#24292E", "#C9D1D9")
    public static let removedBackground = ColorToken("#FFEEF0", "#3F1B23")
    public static let removedBorder = ColorToken("#D73A49", "#F85149")
    public static let removedText = ColorToken("#24292E", "#C9D1D9")
    public static let contextText = ColorToken("#586069", "#8B949E")

    /// diff.syntax, by span kind.
    public enum Syntax {
        public static let plain = ColorToken("#1F2328", "#E6EDF3")
        public static let keyword = ColorToken("#CF222E", "#FF7B72")
        public static let string = ColorToken("#0A3069", "#A5D6FF")
        public static let comment = ColorToken("#6E7781", "#8B949E")
        public static let number = ColorToken("#0550AE", "#79C0FF")
        public static let function = ColorToken("#8250DF", "#D2A8FF")
        public static let `operator` = ColorToken("#0550AE", "#79C0FF")
        public static let punctuation = ColorToken("#1F2328", "#E6EDF3")
        public static let type = ColorToken("#953800", "#FFA657")
        public static let variable = ColorToken("#953800", "#FFA657")
        public static let tag = ColorToken("#116329", "#7EE787")
        public static let attr = ColorToken("#0550AE", "#79C0FF")
    }

    public static let all: [ColorToken] = [
        rowAdded, rowRemoved, gutterAdded, gutterRemoved, gutterBorder, lineNumber, markerAdded, markerRemoved,
        wordAdded, wordRemoved, hunkBackground, hunkText, sectionText, addedBackground, addedBorder, addedText,
        removedBackground, removedBorder, removedText, contextText,
        Syntax.plain, Syntax.keyword, Syntax.string, Syntax.comment, Syntax.number, Syntax.function, Syntax.operator,
        Syntax.punctuation, Syntax.type, Syntax.variable, Syntax.tag, Syntax.attr,
    ]
}

/// components/FileIcon.tsx's Seti themes: each Seti colour name, light
/// and dark.
public enum FileIconPalette {
    public static let blue = ColorToken("#268bd2", "#268bd2")
    public static let grey = ColorToken("#6b7280", "#eee")
    public static let greyLight = ColorToken("#9ca3af", "#839496")
    public static let green = ColorToken("#059669", "#4bae4f")
    public static let orange = ColorToken("#d97706", "#cb4b16")
    public static let pink = ColorToken("#db2777", "#d33682")
    public static let purple = ColorToken("#7c3aed", "#6c71c4")
    public static let red = ColorToken("#dc2626", "#dc322f")
    public static let white = ColorToken("#374151", "#fdf6e3")
    public static let yellow = ColorToken("#eab308", "#ffcb29")
    public static let ignore = ColorToken("#9ca3af", "#586e75")

    public static let all: [ColorToken] = [blue, grey, greyLight, green, orange, pink, purple, red, white, yellow, ignore]
}

/// app/(app)/session/[id]/file.tsx's colours beyond the theme's named ones.
public enum FileViewerPalette {
    /// The chosen Diff / File button: `${theme.colors.textLink}66`.
    public static let toggleSelected = ColorToken("#2BACCC66")
    /// Its label: 'white'.
    public static let toggleSelectedText = ColorToken("#FFFFFF")

    public static let all: [ColorToken] = [toggleSelected, toggleSelectedText]
}

/// file.tsx's type.
public enum FileViewerTextStyles {
    /// The header's path: Typography.mono() at 14.
    public static let path = TextStyle(.mono, size: 14)
    /// Diff / File: 14 at weight 600, the semibold face on iOS.
    public static let toggle = TextStyle(.semiBold, size: 14)
    /// DiffDisplay's rows and SimpleSyntaxHighlighter: mono 14 on a 20
    /// line. Hunk and file headers, keywords, control flow, types and
    /// functions are weight 600, the semibold face.
    public static let code = TextStyle(.mono, size: 14, lineHeight: 20)
    public static let codeBold = TextStyle(.monoSemiBold, size: 14, lineHeight: 20)
    /// "File is empty" / "No changes to display": italic 16.
    public static let message = TextStyle(.italic, size: 16)
    /// "Loading {fileName}...", and the error and binary states' text: 16.
    public static let body = TextStyle(.regular, size: 16)
    /// "Error" / "Binary File": 18, bold over the semibold face.
    public static let stateTitle = TextStyle(.semiBold, size: 18)
    /// The binary file's name under them: 14.
    public static let fileName = TextStyle(.regular, size: 14)
}

/// components/diff's type, beside the rows' own (`DiffStyle` in HappyUI,
/// which follow the font size a view is given).
public enum DiffTextStyles {
    /// DiffFileView's "Show N more lines": Typography.default('semiBold') 13.
    public static let showMore = TextStyle(.semiBold, size: 13)
    /// DiffFileHeader: the directory (mono 12), the file name (mono
    /// semibold 12.5), the change badge (mono semibold 10.5, upper case) and
    /// the +N / −N counts (mono 12).
    public static let headerDir = TextStyle(.mono, size: 12)
    public static let headerFileName = TextStyle(.monoSemiBold, size: 12.5)
    public static let headerBadge = TextStyle(.monoSemiBold, size: 10.5, uppercase: true)
    public static let headerCount = TextStyle(.mono, size: 12)
    /// FileSection's size hint and messages, and DiffImageView's "binary".
    public static let sectionMessage = TextStyle(.regular, size: 13)
    /// DiffImageView's Before / After.
    public static let imageLabel = TextStyle(.monoSemiBold, size: 10.5, uppercase: true)
    /// DiffFilesList's empty text, the changes screen's centred messages and
    /// HappyAgentDiffView's notices: Typography.default() at RN's 14.
    public static let body = TextStyle(.regular, size: 14)
    /// HappyAgentDiffView's Retry.
    public static let retry = TextStyle(.semiBold, size: 14)
}

public enum SecondaryTextStyles {
    // info.tsx's loading and deleted states.
    public static let infoLoading = TextStyle(.semiBold, size: 17)
    public static let infoDeletedTitle = TextStyle(.semiBold, size: 20)
    public static let infoDeletedBody = TextStyle(.regular, size: 15)
    /// machine/[id].tsx "Machine not found".
    public static let machineNotFound = TextStyle(.regular, size: 16)

    /// The Changes row's "N changed files" (12, Typography.default()).
    public static let changedFiles = TextStyle(.regular, size: 12)
    /// GitLineChanges: 11 at weight 600, the semibold face on iOS.
    public static let lineChanges = TextStyle(.semiBold, size: 11)
    public static let lineChangesApproximate = TextStyle(.regular, size: 11)

    /// Item subtitles that ask for Menlo 13 / 12 keep Item's 20pt line;
    /// Plex Mono stands in, as for Connect Claude's command.
    public static let monoSubtitle = TextStyle(.mono, size: 13, lineHeight: 20, letterSpacing: -0.24)
    public static let monoSubtitleSmall = TextStyle(.mono, size: 12, lineHeight: 20, letterSpacing: -0.24)
}
